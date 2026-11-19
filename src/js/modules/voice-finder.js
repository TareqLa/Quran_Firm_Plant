// Quran Firm Plant - Voice Recitation Finder Module
// Captures user speech in Arabic, transcribes it, and locates the exact verse in the Quran.

import { db } from '../data/db.js';
import { findClosestVerse } from '../utils/normalize.js';
import { audioPlayer } from '../components/audio-player.js';
import { quranASR, QuranASR } from '../utils/asr.js';
import { getAsrEngine, setAsrEngine } from '../utils/asr-engine-pref.js';

const HISTORY_KEY = 'voice-search-history';
const FAVORITES_KEY = 'voice-favorites';
const MAX_HISTORY = 20;

// Joins SpeechRecognition result segments. Android Chrome's continuous mode re-sends
// everything recognized so far in each new segment ("بسم", "بسم الله", ...), which plain
// concatenation turns into repeated words.
function mergeSegments(segments) {
  let merged = '';
  for (const raw of segments) {
    const seg = (raw || '').trim();
    if (!seg) continue;
    merged = (!merged || seg.startsWith(merged)) ? seg : `${merged} ${seg}`;
  }
  return merged;
}

export class VoiceFinderModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);
    this.recognition = null;
    this.isListening = false;
    this.isTranscribing = false;
    this.whisperStarting = false;
    this.transcriptionText = ''; // settled (final) text
    this.interimText = ''; // still-changing tail from the browser engine
    this.allTranscripts = []; // Store all alternative transcripts for better matching
    this.activeTab = 'none'; // 'none' | 'history' | 'favorites'
    // An error or "no speech" message. The session is already over when it is set,
    // so updateMicUI() shows it instead of the idle prompt until the next mic tap.
    this.notice = '';
    this.destroyed = false; // set by destroy() when the app leaves this page
    this.matchToken = 0; // only the latest search may render its results
    this.openingPageMap = false;

    // Two selectable engines while we test/tune both (see asr-engine-pref.js):
    // browser SpeechRecognition (fast, cloud-based, default) or the on-device
    // Tarteel Whisper model (offline, currently slower/less accurate).
    this.whisperSupported = QuranASR.isSupported();
    this.useWhisper = this.whisperSupported && getAsrEngine() === 'whisper';
    this.initSpeechRecognition();
  }

  // The header surah selector doesn't scope this module; ignore changes.
  loadSurah() {}

  // Called by the app before it switches to another module: release the microphone
  // and stop audio, so nothing keeps recording after the user has left the page.
  destroy() {
    this.destroyed = true;
    if (this.recognition) {
      const recognition = this.recognition;
      // Detach first: abort() still fires error/end, which would touch the next page
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* never started */ }
      this.recognition = null;
    }
    // The on-device recorder is a shared singleton, so a recording left running here
    // would also make the next mic tap (on any page) stop it instead of starting one.
    if (quranASR.isRecording) quranASR.cancelRecording();
    if (quranASR.onLoadProgress === this.whisperProgress) quranASR.onLoadProgress = null;
    this.isListening = false;
    this.isTranscribing = false;
    audioPlayer.stop();
  }

  // --- LocalStorage helpers ---
  getHistory() {
    let history;
    try {
      history = JSON.parse(localStorage.getItem(HISTORY_KEY));
    } catch { return []; }
    if (!Array.isArray(history)) return [];
    // Entries saved before ids existed get one (and keep it), so they can be deleted by id
    if (history.some(entry => !entry.id)) {
      history.forEach(entry => { if (!entry.id) entry.id = this.newHistoryId(); });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    }
    return history;
  }

  newHistoryId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  saveToHistory(query, topMatch) {
    const q = query.trim();
    if (!q) return;
    const history = this.getHistory();
    // A repeated search moves to the top (keeping its id) instead of being added again
    const existing = history.find(entry => (entry.query || '').trim() === q);
    const others = history.filter(entry => (entry.query || '').trim() !== q);
    others.unshift({
      id: existing ? existing.id : this.newHistoryId(),
      query: q,
      timestamp: Date.now(),
      topMatch: topMatch ? {
        surah: topMatch.surah,
        ayah: topMatch.ayah,
        surahName: topMatch.surahName,
        surahNameEn: topMatch.surahNameEn,
        text: topMatch.text,
        id: topMatch.id
      } : null
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(others.slice(0, MAX_HISTORY)));
  }

  deleteHistoryEntry(id) {
    const history = this.getHistory().filter(entry => entry.id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
  }

  getFavorites() {
    try {
      return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || [];
    } catch { return []; }
  }

  isFavorite(verseId) {
    return this.getFavorites().some(f => f.id === verseId);
  }

  toggleFavorite(ayahData) {
    let favorites = this.getFavorites();
    const exists = favorites.findIndex(f => f.id === ayahData.id);
    if (exists >= 0) {
      favorites.splice(exists, 1);
    } else {
      favorites.unshift({
        id: ayahData.id,
        surah: ayahData.surah,
        ayah: ayahData.ayah,
        surahName: ayahData.surahName,
        surahNameEn: ayahData.surahNameEn,
        text: ayahData.text,
        translation: ayahData.translation,
        globalId: ayahData.globalId,
        addedAt: Date.now()
      });
    }
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }

  removeFavorite(verseId) {
    let favorites = this.getFavorites();
    favorites = favorites.filter(f => f.id !== verseId);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }

  // --- Speech Recognition ---
  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition API not supported in this browser.');
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.lang = 'ar-SA'; // Arabic (Saudi Arabia) for recitation
    this.recognition.continuous = true; // Keep listening for longer recitations
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 5; // Request multiple alternatives for better matching

    this.recognition.onstart = () => {
      this.isListening = true;
      this.transcriptionText = '';
      this.interimText = '';
      this.allTranscripts = [];
      this.updateMicUI();
    };

    this.recognition.onresult = (e) => {
      const finals = [];
      const pending = [];
      this.allTranscripts = [];

      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          // Collect all alternatives from the final result
          for (let a = 0; a < result.length; a++) {
            this.allTranscripts.push(result[a].transcript);
          }
          finals.push(result[0].transcript);
        } else {
          pending.push(result[0].transcript);
        }
      }

      this.transcriptionText = mergeSegments(finals);
      let interim = mergeSegments(pending);
      // Android also repeats the settled text at the start of the pending segment
      if (this.transcriptionText && interim.startsWith(this.transcriptionText)) {
        interim = interim.slice(this.transcriptionText.length).trim();
      }
      this.interimText = interim;

      // Show every word as soon as it is heard: settled words plus the still-changing
      // tail (previously the tail disappeared as soon as one segment was final).
      if (this.transcriptionText || this.interimText) {
        this.showTranscript(this.transcriptionText, this.interimText);
      }
    };

    this.recognition.onerror = (e) => {
      console.warn('Speech recognition error:', e.error);

      // Every error ends the session, 'no-speech' included, and the browser fires `end`
      // right after. Keep the message in state: onend's updateMicUI() shows it until the
      // next mic tap instead of resetting the line to the idle prompt.
      this.isListening = false;
      if (e.error === 'no-speech') {
        this.notice = 'No speech detected. Please try again.';
      } else if (e.error === 'not-allowed') {
        this.notice = 'Microphone permission denied. Please allow microphone access.';
      } else if (e.error === 'network') {
        this.notice = 'Network error. Speech recognition requires internet.';
      } else {
        this.notice = `Error: ${e.error}. Tap the mic to try again.`;
      }
      this.updateMicUI();
    };

    this.recognition.onend = () => {
      this.isListening = false;
      this.updateMicUI();
      // A tail that never became final is still what the user said
      const said = [this.transcriptionText, this.interimText].filter(Boolean).join(' ');
      this.interimText = '';
      const alternatives = this.allTranscripts;
      if (said) {
        this.transcriptionText = said;
        this.showTranscript(said);
        this.performMatch(said, { alternatives });
      } else if (alternatives.length > 0) {
        // Fallback to any alternative
        this.performMatch(alternatives[0], { alternatives });
      }
    };
  }

  // Settled words in normal text, the still-changing tail dimmed after them.
  showTranscript(settled, pending = '') {
    const box = document.getElementById('voice-transcription-output');
    if (!box) return;
    box.classList.remove('placeholder');
    box.dir = 'rtl';
    box.replaceChildren();
    if (settled) box.append(settled);
    if (pending) {
      const tail = document.createElement('span');
      tail.className = 'transcription-pending';
      tail.textContent = settled ? ` ${pending}` : pending;
      box.append(tail);
    }
  }

  showPlaceholder(message) {
    const box = document.getElementById('voice-transcription-output');
    if (!box) return;
    box.classList.add('placeholder');
    box.dir = 'ltr';
    box.innerText = message;
  }

  setStatus(message) {
    const statusEl = document.getElementById('voice-status-text');
    if (statusEl) statusEl.innerText = message;
  }

  // A message that must outlast the end of the session (see `notice`).
  showNotice(message) {
    this.notice = message;
    this.updateMicUI();
  }

  toggleListening() {
    this.notice = ''; // a new tap replaces the last error
    if (this.useWhisper) {
      this.toggleWhisper();
      return;
    }

    if (!this.recognition) {
      alert('Your browser does not support Speech Recognition. Please use Google Chrome or Microsoft Edge.');
      return;
    }

    if (this.isListening) {
      try {
        this.recognition.stop();
        this.isListening = false;
        this.updateMicUI();
      } catch (e) {
        console.warn('SpeechRecognition stop warning:', e);
      }
    } else {
      try {
        // Reset state before starting
        this.transcriptionText = '';
        this.interimText = '';
        this.allTranscripts = [];
        this.showPlaceholder('Listening...');

        this.isListening = true;
        this.updateMicUI();
        this.recognition.start();
      } catch (e) {
        console.warn('SpeechRecognition start warning:', e);
        this.isListening = false;
        this.updateMicUI();
      }
    }
  }

  // --- Whisper (on-device Tarteel model) flow ---
  whisperProgress = (pct, phase) => {
    if (this.isListening || this.isTranscribing) return;
    this.setStatus(phase === 'warming'
      ? 'Preparing the on-device recitation model...'
      : `Loading Tarteel Whisper model (cached after the first time)... ${pct}%`);
  };

  // Start loading the model as soon as Whisper is the chosen engine, so the first tap
  // on the mic doesn't have to wait for it.
  preloadWhisper() {
    if (!this.useWhisper || quranASR.modelReady) return;
    quranASR.ensureLoaded(this.whisperProgress)
      .then(() => {
        if (!this.isListening && !this.isTranscribing && !this.whisperStarting) this.updateMicUI();
      })
      .catch((e) => console.warn('On-device model preload failed:', e));
  }

  async toggleWhisper() {
    // Busy loading/starting the mic or transcribing the previous take
    if (this.isTranscribing || this.whisperStarting) return;

    if (!quranASR.isRecording) {
      this.whisperStarting = true;
      try {
        if (!quranASR.modelReady) {
          this.setStatus('Loading recitation model (first time only, cached afterwards)...');
          await quranASR.ensureLoaded(this.whisperProgress);
        }
        if (this.destroyed) return; // left the page while the model loaded
        this.isListening = true;
        this.transcriptionText = '';
        this.interimText = '';
        this.allTranscripts = [];
        this.showPlaceholder('Recording... recite now, then tap the mic to stop.');
        this.updateMicUI();

        await quranASR.startRecording((text, { settled = '', pending = text } = {}) => {
          if (!text || !this.isListening) return;
          // Finished phrases are final; the phrase still being recited may change (dimmed)
          this.transcriptionText = text;
          this.showTranscript(settled, pending);
        });
        // Left the page while the browser was still opening the mic
        if (this.destroyed) quranASR.cancelRecording();
      } catch (e) {
        if (this.destroyed) return;
        console.error('On-device ASR failed:', e);
        this.isListening = false;
        this.updateMicUI();
        if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') {
          this.showNotice('Microphone unavailable. Please allow microphone access.');
          return;
        }
        // Model/worker failure -> fall back to browser SpeechRecognition
        this.useWhisper = false;
        const toggle = document.getElementById('vf-engine-toggle');
        if (toggle) toggle.innerText = 'Browser (live)';
        if (this.recognition) {
          this.setStatus('On-device model unavailable, using browser recognition...');
          this.toggleListening();
        } else {
          this.showNotice('Speech recognition is not available in this browser. Use the text search below.');
        }
      } finally {
        this.whisperStarting = false;
      }
    } else {
      // Stop recording and transcribe locally
      this.isListening = false;
      this.isTranscribing = true;
      this.updateMicUI();
      // Keep the live text on screen while the final pass runs
      if (!this.transcriptionText) this.showPlaceholder('Transcribing your recitation on-device...');

      try {
        const text = await quranASR.stopAndTranscribe();
        if (this.destroyed) return; // left the page while transcribing
        this.isTranscribing = false;

        if (!text) {
          this.transcriptionText = '';
          this.showNotice('No speech detected. Please try again.');
          this.showPlaceholder('Spoken recitation will appear here...');
          return;
        }

        this.updateMicUI();
        this.transcriptionText = text;
        this.showTranscript(text);
        this.performMatch(text);
      } catch (e) {
        if (this.destroyed) return;
        console.error('Transcription failed:', e);
        this.isTranscribing = false;
        this.showNotice('Transcription failed. Tap the mic to try again.');
        this.showPlaceholder('Spoken recitation will appear here...');
      }
    }
  }

  updateMicUI() {
    const container = document.getElementById('voice-mic-container');
    const statusText = document.getElementById('voice-status-text');

    if (container && statusText) {
      if (this.isListening) {
        container.classList.add('listening');
        statusText.innerText = this.useWhisper
          ? 'Reciting... the text updates every few seconds. Tap the mic again to stop.'
          : 'Reciting... Speak clearly now. Tap mic again to stop.';
      } else if (this.isTranscribing) {
        container.classList.remove('listening');
        statusText.innerText = 'Finishing the on-device transcription...';
      } else {
        container.classList.remove('listening');
        statusText.innerText = this.notice || 'Tap the microphone and recite a verse';
      }
    }
  }

  // --- Rendering ---
  render() {
    const historyCount = this.getHistory().length;
    const favCount = this.getFavorites().length;

    this.container.innerHTML = `
      <div class="voice-finder-container">
        <div style="text-align: center; margin-bottom: 8px;">
          <h4 style="color: var(--text-secondary); margin-bottom: 4px;">Recite to Locate</h4>
          <p style="font-size: 0.9rem; color: var(--text-muted);">Recite a verse and we will find its exact Surah, Ayah, and Page — powered by a Quran-tuned Whisper model running privately on your device. You can also type it manually below.</p>
        </div>

        <!-- Pulse Mic Button -->
        <div id="voice-mic-container" class="mic-btn-container">
          <div class="mic-pulse-ring"></div>
          <button id="voice-mic-trigger" class="mic-btn" title="Start Recording">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
            </svg>
          </button>
        </div>

        <div id="voice-status-text" class="voice-status" aria-live="polite">Tap the microphone and recite a verse</div>

        ${this.recognition && this.whisperSupported ? `
        <div class="vf-engine-switch" style="display: flex; align-items: center; justify-content: center; gap: 8px; margin: 4px 0 12px; font-size: 0.8rem; color: var(--text-muted);">
          <span>Recognition engine (testing):</span>
          <button id="vf-engine-toggle" class="btn-outline vf-engine-btn">
            ${this.useWhisper ? 'On-device Whisper' : 'Browser (live)'}
          </button>
        </div>
        ` : ''}

        <!-- Live Transcription Display -->
        <div id="voice-transcription-output" class="transcription-box placeholder">
          Spoken recitation will appear here...
        </div>

        <!-- Manual search fallback -->
        <div class="vf-search-row" style="width: 100%; display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
          <input type="search" id="voice-manual-input" class="search-input" enterkeyhint="search" autocomplete="off" aria-label="Type a verse in Arabic" style="margin-bottom: 0; text-align: right; flex: 1; min-width: 0;" dir="rtl" placeholder="أو اكتب الآية هنا…">
          <button id="voice-manual-btn" class="btn-gold vf-action-btn" style="white-space: nowrap; flex-shrink: 0;">Search</button>
        </div>

        <!-- Matches Result container (populated by the matching algorithm). History and
             Favorites sit below it, so redrawing them never moves a result under the finger. -->
        <div id="voice-matches-container" style="width: 100%; display: flex; flex-direction: column; gap: 16px;"></div>

        <!-- History & Favorites Toggle Bar -->
        <div class="vf-tabs-bar">
          <button class="vf-tab-btn ${this.activeTab === 'history' ? 'active' : ''}" data-tab="history">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            History${historyCount > 0 ? ` (${historyCount})` : ''}
          </button>
          <button class="vf-tab-btn ${this.activeTab === 'favorites' ? 'active' : ''}" data-tab="favorites">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${favCount > 0 ? 'var(--accent-gold)' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            Favorites${favCount > 0 ? ` (${favCount})` : ''}
          </button>
        </div>

        <!-- History & Favorites Panel -->
        <div id="vf-panel-container" style="width: 100%;">
          ${this.renderActivePanel()}
        </div>
      </div>
    `;

    this.setupEvents();
    this.preloadWhisper();
  }

  renderActivePanel() {
    if (this.activeTab === 'history') return this.renderHistoryPanel();
    if (this.activeTab === 'favorites') return this.renderFavoritesPanel();
    return '';
  }

  renderHistoryPanel() {
    const history = this.getHistory();
    if (history.length === 0) {
      return `
        <div class="vf-panel">
          <div style="text-align: center; padding: 24px; color: var(--text-muted);">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 8px; opacity: 0.5;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <p>No search history yet.</p>
            <p style="font-size: 0.8rem; margin-top: 4px;">Your recent voice and text searches will appear here.</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="vf-panel">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <span style="font-size: 0.85rem; color: var(--text-secondary); font-weight: 600;">Recent Searches</span>
          <button id="vf-clear-history" class="vf-clear-btn">Clear All</button>
        </div>
        <div class="vf-list">
          ${history.map(item => {
            const timeAgo = this.formatTimeAgo(item.timestamp);
            const preview = item.topMatch
              ? `${item.topMatch.surahNameEn} ${item.topMatch.surah}:${item.topMatch.ayah}`
              : 'No match';
            // The query is whatever was typed or heard, so it is escaped, never rendered as HTML
            return `
              <div class="vf-list-item vf-history-item" data-id="${this.escapeHtml(item.id)}" data-query="${this.escapeHtml(item.query)}">
                <div class="vf-list-item-main">
                  <div class="vf-list-query" dir="rtl">${this.escapeHtml(item.query)}</div>
                  <div class="vf-list-meta">
                    <span>${preview}</span>
                    <span>·</span>
                    <span>${timeAgo}</span>
                  </div>
                </div>
                <button class="vf-delete-btn" data-history-id="${this.escapeHtml(item.id)}" title="Remove" aria-label="Remove from history">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  renderFavoritesPanel() {
    const favorites = this.getFavorites();
    if (favorites.length === 0) {
      return `
        <div class="vf-panel">
          <div style="text-align: center; padding: 24px; color: var(--text-muted);">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 8px; opacity: 0.5;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            <p>No favorites saved yet.</p>
            <p style="font-size: 0.8rem; margin-top: 4px;">Star verses from search results to save them here.</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="vf-panel">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <span style="font-size: 0.85rem; color: var(--text-secondary); font-weight: 600;">Saved Verses (${favorites.length})</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          ${favorites.map(fav => `
            <div class="card vf-fav-card" style="border-color: var(--border-color);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px;">
                <span style="font-weight: 700; font-size: 0.9rem;">
                  ${fav.surahNameEn || ''} (${fav.surahName || ''})
                </span>
                <div class="toolbar-group" style="gap: 4px;">
                  <span class="comparison-ayah-num">Ayah ${fav.ayah}</span>
                </div>
              </div>
              <div class="quran-text" style="text-align: right; line-height: 1.8; font-size: 1.7rem; margin-bottom: 10px;">
                ${fav.text}
              </div>
              ${fav.translation ? `<div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 10px; border-top: 1px dashed var(--border-color); padding-top: 8px;">${fav.translation}</div>` : ''}
              <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
                <button class="btn-gold vf-action-btn fav-play-btn" data-global-id="${fav.globalId}" data-key="${fav.id}">
                  ▶ Play
                </button>
                <button class="btn-outline vf-action-btn fav-pagemap-btn" data-surah="${fav.surah}" data-ayah="${fav.ayah}" style="border-color: var(--accent-gold); color: var(--accent-gold);">
                  📖 Page Map
                </button>
                <button class="btn-outline vf-action-btn fav-remove-btn" data-id="${fav.id}" style="border-color: var(--color-error); color: var(--color-error);">
                  ✕ Remove
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // --- Events ---
  setupEvents() {
    document.getElementById('voice-mic-trigger')?.addEventListener('click', () => this.toggleListening());

    document.getElementById('vf-engine-toggle')?.addEventListener('click', () => {
      if (this.isListening || this.isTranscribing || this.whisperStarting) return; // don't swap mid-recording
      this.useWhisper = !this.useWhisper;
      setAsrEngine(this.useWhisper ? 'whisper' : 'browser');
      const btn = document.getElementById('vf-engine-toggle');
      if (btn) btn.innerText = this.useWhisper ? 'On-device Whisper' : 'Browser (live)';
      this.updateMicUI();
      this.preloadWhisper();
    });

    // Manual search button
    const handleManualSearch = () => {
      const query = document.getElementById('voice-manual-input').value.trim();
      if (query) {
        const box = document.getElementById('voice-transcription-output');
        if (box) {
          box.classList.remove('placeholder');
          box.dir = 'rtl';
          box.innerText = query;
        }
        // Typed text: no voice alternatives, so the last recitation's guesses aren't retried
        this.performMatch(query);
      }
    };

    document.getElementById('voice-manual-btn')?.addEventListener('click', handleManualSearch);
    // keydown (not the deprecated keypress) also catches the phone keyboard's Search key;
    // skip the Enter that confirms an IME composition.
    document.getElementById('voice-manual-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) handleManualSearch();
    });

    // Tab toggle buttons
    this.container.querySelectorAll('.vf-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        this.activeTab = (this.activeTab === tab) ? 'none' : tab;
        this.refreshPanel();
        // Update tab button active states
        this.container.querySelectorAll('.vf-tab-btn').forEach(b => b.classList.remove('active'));
        if (this.activeTab !== 'none') {
          btn.classList.add('active');
        }
      });
    });

    this.setupPanelEvents();
  }

  setupPanelEvents() {
    const panel = document.getElementById('vf-panel-container');
    if (!panel) return;

    // Clear history
    panel.querySelector('#vf-clear-history')?.addEventListener('click', () => {
      this.clearHistory();
      this.refreshPanel();
      // Update history tab count
      this.updateTabCounts();
    });

    // History item click -> re-run search
    panel.querySelectorAll('.vf-history-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        // Don't trigger if clicking delete button
        if (e.target.closest('.vf-delete-btn')) return;
        const query = item.dataset.query;
        if (query) {
          const box = document.getElementById('voice-transcription-output');
          if (box) {
            box.classList.remove('placeholder');
            box.dir = 'rtl';
            box.innerText = query;
          }
          const input = document.getElementById('voice-manual-input');
          if (input) input.value = query;
          // Re-run as text: the last recitation's alternatives don't belong to it
          const shown = await this.performMatch(query);
          // The results now sit above this list, so bring the query and the first result
          // into view, just below the sticky app header
          if (shown && box) {
            const header = document.querySelector('.app-header');
            box.style.scrollMarginTop = `${(header?.offsetHeight || 0) + 8}px`;
            box.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    });

    // Delete individual history item (by id: positions go stale as the list changes)
    panel.querySelectorAll('.vf-delete-btn[data-history-id]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteHistoryEntry(btn.dataset.historyId);
        this.refreshPanel();
        this.updateTabCounts();
      });
    });

    // Favorite card actions
    panel.querySelectorAll('.fav-play-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const globalId = parseInt(btn.dataset.globalId);
        const key = btn.dataset.key;
        audioPlayer.playGlobalVerse(globalId, key);
      });
    });

    panel.querySelectorAll('.fav-pagemap-btn').forEach(btn => {
      btn.addEventListener('click', () => this.openPageMap(btn));
    });

    panel.querySelectorAll('.fav-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.removeFavorite(btn.dataset.id);
        this.refreshPanel();
        this.updateTabCounts();
      });
    });
  }

  refreshPanel() {
    const panel = document.getElementById('vf-panel-container');
    if (panel) {
      panel.innerHTML = this.renderActivePanel();
      this.setupPanelEvents();
    }
  }

  updateTabCounts() {
    const historyBtn = this.container.querySelector('.vf-tab-btn[data-tab="history"]');
    const favBtn = this.container.querySelector('.vf-tab-btn[data-tab="favorites"]');
    const hCount = this.getHistory().length;
    const fCount = this.getFavorites().length;
    if (historyBtn) {
      historyBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        History${hCount > 0 ? ` (${hCount})` : ''}
      `;
    }
    if (favBtn) {
      favBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${fCount > 0 ? 'var(--accent-gold)' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        Favorites${fCount > 0 ? ` (${fCount})` : ''}
      `;
    }
  }

  // Opening the Page Map can take a while (navigateToPageMap scans the surah's page
  // layouts one by one), so the button shows that and further taps are ignored.
  async openPageMap(btn) {
    if (!window.app || this.openingPageMap) return;
    this.openingPageMap = true;
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Opening page…';
    try {
      await window.app.navigateToPageMap(parseInt(btn.dataset.surah), parseInt(btn.dataset.ayah));
    } catch (e) {
      console.error('Could not open the Page Map:', e);
    } finally {
      this.openingPageMap = false;
      // Still on this page (the app didn't navigate): give the button back
      if (btn.isConnected) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.innerHTML = label;
      }
    }
  }

  // Save / Saved toggle on a result card. Both states have the same width (CSS), so
  // tapping it never reflows the card; aria-pressed carries the state for screen readers.
  saveButtonHtml(a, isFav) {
    const ref = `${a.surahNameEn || ''} ${a.surah}:${a.ayah}`.trim();
    const verse = { id: a.id, surah: a.surah, ayah: a.ayah, surahName: a.surahName, surahNameEn: a.surahNameEn, text: a.text, translation: a.translation, globalId: a.globalId };
    return `
      <button class="vf-star-btn ${isFav ? 'starred' : ''}" data-verse-id="${this.escapeHtml(a.id)}" data-ref="${this.escapeHtml(ref)}" data-verse='${this.escapeHtml(JSON.stringify(verse))}' aria-pressed="${isFav}" aria-label="${isFav ? 'Saved' : 'Save'} ${this.escapeHtml(ref)}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
        ${this.saveButtonInner(isFav)}
      </button>`;
  }

  saveButtonInner(isFav) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="${isFav ? 'var(--accent-gold)' : 'none'}" stroke="${isFav ? 'var(--accent-gold)' : 'currentColor'}" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg><span>${isFav ? 'Saved' : 'Save'}</span>`;
  }

  // Refresh the Save buttons on visible result cards, in place
  updateStarStates() {
    this.container.querySelectorAll('.vf-star-btn').forEach(btn => {
      const isFav = this.isFavorite(btn.dataset.verseId);
      if (btn.getAttribute('aria-pressed') === String(isFav)) return; // unchanged
      btn.classList.toggle('starred', isFav);
      btn.setAttribute('aria-pressed', String(isFav));
      btn.setAttribute('aria-label', `${isFav ? 'Saved' : 'Save'} ${btn.dataset.ref}`);
      btn.title = isFav ? 'Remove from Favorites' : 'Add to Favorites';
      btn.innerHTML = this.saveButtonInner(isFav);
    });
  }

  formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  // For text and attribute values alike (& first, so existing entities survive a round trip)
  escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // --- Matching ---
  // `alternatives` are the recognizer's other guesses for a recitation. Only voice input
  // has them; typed and history searches pass none, so an old recitation can't leak in.
  // Resolves to true once this search's results (or "No Matches Found") are on screen.
  async performMatch(transcription, { alternatives = [] } = {}) {
    const resultsContainer = document.getElementById('voice-matches-container');
    if (!resultsContainer || this.destroyed) return false;
    const token = ++this.matchToken;
    const superseded = () => this.destroyed || token !== this.matchToken;

    resultsContainer.innerHTML = `
      <div style="text-align: center; padding: 20px;">
        <span class="status-dot animate-pulse" style="background-color: var(--accent-gold); margin-right: 8px;"></span>
        <span>Searching database for matches...</span>
      </div>
    `;

    try {
      // Search with the primary transcription
      let matches = await findClosestVerse(transcription, db);

      // If no matches and the recognizer offered alternative transcripts, try those too
      if (matches.length === 0 && alternatives.length > 1) {
        for (let i = 1; i < alternatives.length; i++) {
          if (superseded()) return false;
          const altMatches = await findClosestVerse(alternatives[i], db);
          if (altMatches.length > 0) {
            matches = altMatches;
            // Update the transcription display with the alternative that matched
            const box = document.getElementById('voice-transcription-output');
            if (box && !superseded()) {
              box.innerText = alternatives[i] + ' (alt.)';
            }
            break;
          }
        }
      }
      // A newer search, or another page, owns the screen now
      if (superseded()) return false;

      // Save to history (even if no matches, to record the attempt)
      const topMatch = matches.length > 0 ? matches[0].ayah : null;
      this.saveToHistory(transcription, topMatch);
      this.updateTabCounts();
      // An open History list must match storage (the entry may have moved to the top)
      if (this.activeTab === 'history') this.refreshPanel();

      if (matches.length === 0) {
        resultsContainer.innerHTML = `
          <div class="card" style="text-align: center; padding: 24px; border-color: var(--color-error);">
            <h4 style="color: var(--color-error); margin-bottom: 8px;">No Matches Found</h4>
            <p style="font-size: 0.9rem; color: var(--text-secondary);">We couldn't match your recitation in the database. Try speaking more clearly, recite a longer portion, or use the text search box above.</p>
          </div>
        `;
        return true;
      }

      // Render matched cards
      resultsContainer.innerHTML = matches.map((match, idx) => {
        const a = match.ayah;
        const scorePct = Math.round(match.score * 100);
        const isFav = this.isFavorite(a.id);
        
        return `
          <div class="card" style="border-color: ${idx === 0 ? 'var(--accent-gold)' : 'var(--border-color)'};">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px; flex-wrap: wrap; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                ${this.saveButtonHtml(a, isFav)}
                <span class="comparison-surah" style="font-weight: 700;">
                  ${a.surahNameEn || ''} (${a.surahName || ''})
                </span>
              </div>
              <div class="toolbar-group" style="flex-wrap: wrap; gap: 4px;">
                <span class="comparison-ayah-num" style="background-color: ${idx === 0 ? 'rgba(212, 175, 55, 0.15)' : 'var(--bg-tertiary)'};">
                  Ayah ${a.ayah}
                </span>
                <span class="comparison-ayah-num" style="font-weight: 600; color: ${match.score > 0.8 ? 'var(--color-success)' : 'var(--accent-gold)'};">
                  Match: ${scorePct}%
                </span>
              </div>
            </div>
            <div class="quran-text" style="text-align: right; line-height: 1.8; font-size: 2rem; margin-bottom: 16px;">
              ${a.text}
            </div>
            <div style="font-size: 0.9rem; color: var(--text-secondary); line-height: 1.5; border-top: 1px dashed var(--border-color); padding-top: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
              <div style="flex: 1 1 180px; min-width: 0;">${a.translation || ''}</div>
              <div style="display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap;">
                <button class="btn-gold vf-action-btn play-result-btn" data-global-id="${a.globalId}" data-key="${a.id}">
                  ▶ Play
                </button>
                <button class="btn-outline vf-action-btn jump-pagemap-btn" data-surah="${a.surah}" data-ayah="${a.ayah}" style="border-color: var(--accent-gold); color: var(--accent-gold);">
                  📖 Page Map
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('');

      // Add play events
      resultsContainer.querySelectorAll('.play-result-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const globalId = parseInt(btn.dataset.globalId);
          const key = btn.dataset.key;
          audioPlayer.playGlobalVerse(globalId, key);
        });
      });

      // Add jump-to-page-map events: page-map mode at the exact ayah's page
      resultsContainer.querySelectorAll('.jump-pagemap-btn').forEach(btn => {
        btn.addEventListener('click', () => this.openPageMap(btn));
      });

      // Add star/favorite toggle events
      resultsContainer.querySelectorAll('.vf-star-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const verseData = JSON.parse(btn.dataset.verse);
          this.toggleFavorite(verseData);
          this.updateStarStates();
          this.updateTabCounts();
          // If favorites panel is open, refresh it (it sits below the results, so the
          // card under the finger stays put)
          if (this.activeTab === 'favorites') {
            this.refreshPanel();
          }
        });
      });

      return true;
    } catch (e) {
      if (superseded()) return false;
      console.error(e);
      resultsContainer.innerHTML = `<div class="card" style="text-align: center; color: var(--color-error);">Search failed. Please try again.</div>`;
      return false;
    }
  }
}
