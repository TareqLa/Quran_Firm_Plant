// Quran Firm Plant - Voice Recitation Finder Module
// Captures user speech in Arabic, transcribes it, and locates the exact verse in the Quran.

import { db } from '../data/db.js';
import { findClosestVerse } from '../utils/normalize.js';
import { audioPlayer } from '../components/audio-player.js';
import { quranASR, QuranASR } from '../utils/asr.js';

const HISTORY_KEY = 'voice-search-history';
const FAVORITES_KEY = 'voice-favorites';
const MAX_HISTORY = 20;

export class VoiceFinderModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);
    this.recognition = null;
    this.isListening = false;
    this.isTranscribing = false;
    this.transcriptionText = '';
    this.allTranscripts = []; // Store all alternative transcripts for better matching
    this.activeTab = 'none'; // 'none' | 'history' | 'favorites'

    // Prefer the on-device Tarteel Whisper model; browser SpeechRecognition is the fallback
    this.useWhisper = QuranASR.isSupported();
    this.initSpeechRecognition();
  }

  // --- LocalStorage helpers ---
  getHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch { return []; }
  }

  saveToHistory(query, topMatch) {
    const history = this.getHistory();
    // Avoid duplicate consecutive entries for the same query
    if (history.length > 0 && history[0].query === query) return;
    history.unshift({
      query,
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
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
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
      this.allTranscripts = [];
      this.updateMicUI();
    };

    this.recognition.onresult = (e) => {
      let finalText = '';
      let interim = '';
      this.allTranscripts = [];

      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          // Collect all alternatives from the final result
          for (let a = 0; a < e.results[i].length; a++) {
            this.allTranscripts.push(e.results[i][a].transcript);
          }
          finalText += e.results[i][0].transcript;
        } else {
          interim += e.results[i][0].transcript;
        }
      }

      this.transcriptionText = finalText;

      const box = document.getElementById('voice-transcription-output');
      if (box) {
        box.classList.remove('placeholder');
        box.dir = 'rtl';
        box.innerText = this.transcriptionText || interim || 'Listening...';
      }
    };

    this.recognition.onerror = (e) => {
      console.error('Speech recognition error:', e.error);
      
      // Don't reset on 'no-speech' — just keep listening
      if (e.error === 'no-speech') {
        const statusEl = document.getElementById('voice-status-text');
        if (statusEl) statusEl.innerText = 'No speech detected. Please try again.';
        return;
      }
      
      this.isListening = false;
      this.updateMicUI();
      
      const statusEl = document.getElementById('voice-status-text');
      if (statusEl) {
        if (e.error === 'not-allowed') {
          statusEl.innerText = 'Microphone permission denied. Please allow microphone access.';
        } else if (e.error === 'network') {
          statusEl.innerText = 'Network error. Speech recognition requires internet.';
        } else {
          statusEl.innerText = `Error: ${e.error}. Tap the mic to try again.`;
        }
      }
    };

    this.recognition.onend = () => {
      this.isListening = false;
      this.updateMicUI();
      if (this.transcriptionText) {
        this.performMatch(this.transcriptionText);
      } else if (this.allTranscripts.length > 0) {
        // Fallback to any alternative
        this.performMatch(this.allTranscripts[0]);
      }
    };
  }

  toggleListening() {
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
        this.allTranscripts = [];
        const box = document.getElementById('voice-transcription-output');
        if (box) {
          box.classList.add('placeholder');
          box.dir = 'ltr';
          box.innerText = 'Listening...';
        }
        
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
  async toggleWhisper() {
    if (this.isTranscribing) return; // busy transcribing the previous take

    const statusEl = document.getElementById('voice-status-text');
    const box = document.getElementById('voice-transcription-output');

    if (!quranASR.isRecording) {
      try {
        if (!quranASR.modelReady) {
          if (statusEl) statusEl.innerText = 'Loading recitation model (first time only, cached afterwards)...';
          await quranASR.ensureLoaded((pct) => {
            if (statusEl) statusEl.innerText = `Downloading Tarteel Whisper model... ${pct}%`;
          });
        }
        this.isListening = true;
        this.transcriptionText = '';
        this.allTranscripts = [];
        if (box) {
          box.classList.add('placeholder');
          box.dir = 'ltr';
          box.innerText = 'Recording... recite now, then tap the mic to stop.';
        }
        this.updateMicUI();

        await quranASR.startRecording((text) => {
          if (!text || !this.isListening) return;
          this.transcriptionText = text;
          if (box) {
            box.classList.remove('placeholder');
            box.dir = 'rtl';
            box.innerText = text;
          }
        });
      } catch (e) {
        console.error('On-device ASR failed:', e);
        if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') {
          if (statusEl) statusEl.innerText = 'Microphone unavailable. Please allow microphone access.';
          return;
        }
        // Model/worker failure -> fall back to browser SpeechRecognition permanently
        this.useWhisper = false;
        if (this.recognition) {
          if (statusEl) statusEl.innerText = 'On-device model unavailable, using browser recognition...';
          this.toggleListening();
        } else {
          if (statusEl) statusEl.innerText = 'Speech recognition is not available in this browser. Use the text search below.';
        }
      }
    } else {
      // Stop recording and transcribe locally
      this.isListening = false;
      this.isTranscribing = true;
      this.updateMicUI();
      if (box) {
        box.classList.add('placeholder');
        box.dir = 'ltr';
        box.innerText = 'Transcribing your recitation on-device...';
      }

      try {
        const text = await quranASR.stopAndTranscribe();
        this.isTranscribing = false;
        this.updateMicUI();

        if (!text) {
          if (statusEl) statusEl.innerText = 'No speech detected. Please try again.';
          if (box) box.innerText = 'Spoken recitation will appear here...';
          return;
        }

        this.transcriptionText = text;
        if (box) {
          box.classList.remove('placeholder');
          box.dir = 'rtl';
          box.innerText = text;
        }
        this.performMatch(text);
      } catch (e) {
        console.error('Transcription failed:', e);
        this.isTranscribing = false;
        this.updateMicUI();
        if (statusEl) statusEl.innerText = 'Transcription failed. Tap the mic to try again.';
        if (box) box.innerText = 'Spoken recitation will appear here...';
      }
    }
  }

  updateMicUI() {
    const container = document.getElementById('voice-mic-container');
    const statusText = document.getElementById('voice-status-text');

    if (container && statusText) {
      if (this.isListening) {
        container.classList.add('listening');
        statusText.innerText = 'Reciting... Speak clearly now. Tap mic again to stop.';
      } else if (this.isTranscribing) {
        container.classList.remove('listening');
        statusText.innerText = 'Transcribing your recitation on-device...';
      } else {
        container.classList.remove('listening');
        statusText.innerText = 'Tap the microphone and recite a verse';
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

        <div id="voice-status-text" class="voice-status">Tap the microphone and recite a verse</div>

        <!-- Live Transcription Display -->
        <div id="voice-transcription-output" class="transcription-box placeholder">
          Spoken recitation will appear here...
        </div>

        <!-- Manual search fallback -->
        <div style="width: 100%; display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
          <input type="text" id="voice-manual-input" class="search-input" style="margin-bottom: 0; text-align: right; flex: 1; min-width: 0;" dir="rtl" placeholder="Or type the verse in Arabic here...">
          <button id="voice-manual-btn" class="btn-gold" style="white-space: nowrap; flex-shrink: 0;">Search</button>
        </div>

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

        <!-- Matches Result container -->
        <div id="voice-matches-container" style="width: 100%; display: flex; flex-direction: column; gap: 16px;">
          <!-- Populated by matching algorithm -->
        </div>
      </div>
    `;

    this.setupEvents();
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
          ${history.map((item, idx) => {
            const timeAgo = this.formatTimeAgo(item.timestamp);
            const preview = item.topMatch
              ? `${item.topMatch.surahNameEn} ${item.topMatch.surah}:${item.topMatch.ayah}`
              : 'No match';
            return `
              <div class="vf-list-item vf-history-item" data-idx="${idx}" data-query="${this.escapeAttr(item.query)}">
                <div class="vf-list-item-main">
                  <div class="vf-list-query" dir="rtl">${item.query}</div>
                  <div class="vf-list-meta">
                    <span>${preview}</span>
                    <span>·</span>
                    <span>${timeAgo}</span>
                  </div>
                </div>
                <button class="vf-delete-btn" data-history-idx="${idx}" title="Remove">
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
              <div style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
                <button class="btn-gold fav-play-btn" data-global-id="${fav.globalId}" data-key="${fav.id}" style="padding: 5px 10px; font-size: 0.78rem; border-radius: var(--border-radius-sm);">
                  ▶ Play
                </button>
                <button class="btn-outline fav-pagemap-btn" data-surah="${fav.surah}" data-ayah="${fav.ayah}" style="padding: 5px 10px; font-size: 0.78rem; border-radius: var(--border-radius-sm); border-color: var(--accent-gold); color: var(--accent-gold);">
                  📖 Page Map
                </button>
                <button class="btn-outline fav-remove-btn" data-id="${fav.id}" style="padding: 5px 10px; font-size: 0.78rem; border-radius: var(--border-radius-sm); border-color: var(--color-error); color: var(--color-error);">
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

    // Manual search button
    const handleManualSearch = () => {
      const query = document.getElementById('voice-manual-input').value;
      if (query.trim()) {
        const box = document.getElementById('voice-transcription-output');
        if (box) {
          box.classList.remove('placeholder');
          box.dir = 'rtl';
          box.innerText = query;
        }
        this.performMatch(query);
      }
    };

    document.getElementById('voice-manual-btn')?.addEventListener('click', handleManualSearch);
    document.getElementById('voice-manual-input')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleManualSearch();
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
      item.addEventListener('click', (e) => {
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
          this.performMatch(query);
        }
      });
    });

    // Delete individual history item
    panel.querySelectorAll('.vf-delete-btn[data-history-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.historyIdx);
        const history = this.getHistory();
        history.splice(idx, 1);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
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
      btn.addEventListener('click', () => {
        const surahNum = parseInt(btn.dataset.surah);
        const ayahNum = parseInt(btn.dataset.ayah);
        if (window.app) {
          window.app.navigateToPageMap(surahNum, ayahNum);
        }
      });
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

  // Refresh the star states on visible result cards
  updateStarStates() {
    this.container.querySelectorAll('.vf-star-btn').forEach(btn => {
      const id = btn.dataset.verseId;
      const isFav = this.isFavorite(id);
      btn.classList.toggle('starred', isFav);
      btn.title = isFav ? 'Remove from Favorites' : 'Add to Favorites';
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'var(--accent-gold)' : 'none'}" stroke="${isFav ? 'var(--accent-gold)' : 'currentColor'}" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
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

  escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Matching ---
  async performMatch(transcription) {
    const resultsContainer = document.getElementById('voice-matches-container');
    if (!resultsContainer) return;

    resultsContainer.innerHTML = `
      <div style="text-align: center; padding: 20px;">
        <span class="status-dot animate-pulse" style="background-color: var(--accent-gold); margin-right: 8px;"></span>
        <span>Searching database for matches...</span>
      </div>
    `;

    try {
      // Search with the primary transcription
      let matches = await findClosestVerse(transcription, db);
      
      // If no matches and we have alternative transcripts, try those too
      if (matches.length === 0 && this.allTranscripts.length > 1) {
        for (let i = 1; i < this.allTranscripts.length; i++) {
          const altMatches = await findClosestVerse(this.allTranscripts[i], db);
          if (altMatches.length > 0) {
            matches = altMatches;
            // Update the transcription display with the alternative that matched
            const box = document.getElementById('voice-transcription-output');
            if (box) {
              box.innerText = this.allTranscripts[i] + ' (alt.)';
            }
            break;
          }
        }
      }
      
      // Save to history (even if no matches, to record the attempt)
      const topMatch = matches.length > 0 ? matches[0].ayah : null;
      this.saveToHistory(transcription, topMatch);
      this.updateTabCounts();

      if (matches.length === 0) {
        resultsContainer.innerHTML = `
          <div class="card" style="text-align: center; padding: 24px; border-color: var(--color-error);">
            <h4 style="color: var(--color-error); margin-bottom: 8px;">No Matches Found</h4>
            <p style="font-size: 0.9rem; color: var(--text-secondary);">We couldn't match your recitation in the database. Try speaking more clearly, recite a longer portion, or use the text search box above.</p>
          </div>
        `;
        return;
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
                <button class="vf-star-btn ${isFav ? 'starred' : ''}" data-verse-id="${a.id}" data-verse='${this.escapeAttr(JSON.stringify({ id: a.id, surah: a.surah, ayah: a.ayah, surahName: a.surahName, surahNameEn: a.surahNameEn, text: a.text, translation: a.translation, globalId: a.globalId }))}' title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'var(--accent-gold)' : 'none'}" stroke="${isFav ? 'var(--accent-gold)' : 'currentColor'}" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
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
              <div style="flex: 1; min-width: 0;">${a.translation || ''}</div>
              <div style="display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap;">
                <button class="btn-gold play-result-btn" data-global-id="${a.globalId}" data-key="${a.id}" style="padding: 6px 12px; font-size: 0.8rem; border-radius: var(--border-radius-sm);">
                  ▶ Play
                </button>
                <button class="btn-outline jump-pagemap-btn" data-surah="${a.surah}" data-ayah="${a.ayah}" style="padding: 6px 12px; font-size: 0.8rem; border-radius: var(--border-radius-sm); border-color: var(--accent-gold); color: var(--accent-gold);">
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

      // Add jump-to-page-map events
      resultsContainer.querySelectorAll('.jump-pagemap-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const surahNum = parseInt(btn.dataset.surah);
          const ayahNum = parseInt(btn.dataset.ayah);

          // Navigate the app to page-map mode at the exact ayah's page
          if (window.app) {
            window.app.navigateToPageMap(surahNum, ayahNum);
          }
        });
      });

      // Add star/favorite toggle events
      resultsContainer.querySelectorAll('.vf-star-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const verseData = JSON.parse(btn.dataset.verse);
          this.toggleFavorite(verseData);
          this.updateStarStates();
          this.updateTabCounts();
          // If favorites panel is open, refresh it
          if (this.activeTab === 'favorites') {
            this.refreshPanel();
          }
        });
      });

    } catch (e) {
      console.error(e);
      resultsContainer.innerHTML = `<div class="card" style="text-align: center; color: var(--color-error);">Search failed. Please try again.</div>`;
    }
  }
}
