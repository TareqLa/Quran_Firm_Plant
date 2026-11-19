// Quran Firm Plant - Voice Finder ("Focused" layout)
// Recite or type a few words of a verse and find its surah, ayah, page and juz.
// Three tabs: Find (mic, typing, results), History and Saved. Saved verses keep the
// 'voice-favorites' storage key from when the tab was called Favorites.

import { db } from '../data/db.js';
import { findClosestVerse, normalizeArabic, levenshteinDistance } from '../utils/normalize.js';
import { audioPlayer } from '../components/audio-player.js';
import { quranASR, QuranASR } from '../utils/asr.js';
import { getAsrEngine, setAsrEngine } from '../utils/asr-engine-pref.js';
import { pageOfAyah, juzOfAyah } from '../data/ayah-location.js';
import { SURAH_LIST } from '../components/surah-selector.js';

const HISTORY_KEY = 'voice-search-history';
const SAVED_KEY = 'voice-favorites';
const MAX_HISTORY = 20;
const MAX_MATCHES = 8; // findClosestVerse never returns more
const TOAST_MS = 5000;
const TABS = ['find', 'history', 'saved'];

// How a result matched, shown as the pill on the best-match card
const MATCH_LABELS = {
  exact: 'Exact verse',
  phrase: 'Exact phrase',
  near: 'Nearly identical',
  partial: 'Partial match',
};

// Messages that stay on the Find screen until the next mic tap
const NOTICES = {
  noSpeech: { text: 'I didn’t hear anything. Hold the phone a little closer and try again.' },
  micBlocked: { text: 'The microphone is blocked for this site. Allow it in your browser’s site settings, then tap the mic.', help: true },
  noMic: { text: 'No microphone was found. Connect one, then tap the mic.' },
  micBusy: { text: 'Another app is using the microphone. Close it, then tap the mic.' },
  offline: { text: 'Online recognition needs internet. Use on-device recognition instead? It works offline.', action: 'use-device', actionLabel: 'Use on-device recognition' },
  offlineOnly: { text: 'Online recognition needs internet. Check your connection, then tap the mic.' },
  onlineUnavailable: { text: 'Online recognition isn’t available in this browser. Use on-device recognition instead?', action: 'use-device', actionLabel: 'Use on-device recognition' },
  modelOffline: { text: 'On-device recognition needs internet once, for its 45 MB download. Connect, then tap the mic.' },
  unsupported: { text: 'Speech recognition isn’t available in this browser. Type the verse instead.' },
  stopped: { text: 'Listening stopped. Tap the mic to try again.' },
  transcribeFailed: { text: 'The transcription failed. Tap the mic to try again.' },
  generic: { text: 'The microphone didn’t start. Tap it to try again.' },
};

const ICONS = {
  mic: '<path d="M12 2.5a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0v-6a3 3 0 0 0-3-3z"/><path d="M18.5 10.5v1a6.5 6.5 0 0 1-13 0v-1"/><path d="M12 18v3.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8.5 6v12M15.5 6v12" stroke-width="3"/>',
  page: '<path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h6v16H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M20.5 5.5A1.5 1.5 0 0 0 19 4h-6v16h6a1.5 1.5 0 0 0 1.5-1.5z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  kbd: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7.5 14h9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
};

function icon(name) {
  return `<svg class="vf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

// For text and attribute values alike (& first, so existing entities survive a round trip)
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

function vibrate() {
  try {
    navigator.vibrate?.(10);
  } catch { /* not supported */ }
}

function surahNames(surah, record) {
  const meta = SURAH_LIST[surah - 1];
  return {
    en: record?.surahNameEn || meta?.nameEn || `Surah ${surah}`,
    ar: record?.surahName || meta?.name || '',
  };
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(timestamp) {
  return isSameDay(new Date(timestamp), new Date());
}

function timeLabel(timestamp) {
  const then = new Date(timestamp);
  const now = new Date();
  if (isSameDay(then, now)) {
    const mins = Math.floor((now - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    return `${Math.floor(mins / 60)} h ago`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(then, yesterday)) return 'Yesterday';
  // English like the rest of the page ("Mon", "10 Oct"), whatever the browser's language
  if (now - then < 6 * 86400000) return then.toLocaleDateString('en-GB', { weekday: 'short' });
  return then.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

// --- Matching words in the verse ---
// Words are compared normalized, without alefs and the standalone hamza, and with doubled
// letters written once: the Uthmani text leaves out many alefs that plain spelling (and
// both speech engines) write out (ٱلۡعَٰلَمِينَ vs العالمين), spells آلاء as ءَالَآءِ, and
// يؤوده as يَـُٔودُهُۥ.
function looseWords(text) {
  return normalizeArabic(text).split(' ')
    .map(word => word.replace(/[اء]/g, '').replace(/(.)\1+/g, '$1'))
    .filter(Boolean);
}

// Index where `inner` starts as consecutive words of `outer`, or -1
function findRun(outer, inner, same = (a, b) => a === b) {
  if (!inner.length) return -1;
  for (let i = 0; i + inner.length <= outer.length; i++) {
    let j = 0;
    while (j < inner.length && same(outer[i + j], inner[j])) j++;
    if (j === inner.length) return i;
  }
  return -1;
}

// Equal, or the same word with a one-letter prefix (wa-, fa-, bi-, li-, ka-) added or dropped
function sameWord(a, b) {
  if (a === b) return true;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.length === short.length + 1 && 'وفبلك'.includes(long[0]) && long.slice(1) === short;
}

function similarWord(a, b) {
  if (sameWord(a, b)) return true;
  const longest = Math.max(a.length, b.length);
  return longest >= 3 && levenshteinDistance(a, b) <= Math.floor(longest / 3);
}

// How a result matched the query, in the words of the result card. A verse that lies
// whole inside a longer recitation is only near: the other words may be another verse's.
function matchKind(query, ayah, score) {
  const q = looseWords(query);
  const verse = looseWords(ayah.text);
  if (q.length && q.join(' ') === verse.join(' ')) return 'exact';
  if (findRun(verse, q) >= 0) return 'phrase';
  return score >= 0.85 ? 'near' : 'partial';
}

// [first, last] indexes of the verse words the query covers, or null
function recitedRange(tokens, query) {
  const q = looseWords(query);
  const at = []; // token indexes of real words (skips marks such as ۞)
  const words = [];
  tokens.forEach((token, i) => {
    const key = looseWords(token).join('');
    if (key) {
      at.push(i);
      words.push(key);
    }
  });
  if (!q.length || !words.length) return null;

  // The recited words in a row
  if (q.length <= words.length) {
    const start = findRun(words, q, sameWord);
    if (start >= 0) return [at[start], at[start + q.length - 1]];
  } else if (findRun(q, words, sameWord) >= 0) {
    return [at[0], at[at.length - 1]];
  }

  // Recognition slips: the stretch of about the query's length with the most similar words
  const hit = words.map(word => q.some(w => similarWord(word, w)));
  const size = Math.min(q.length, words.length);
  let best = null;
  for (let i = 0; i + size <= words.length; i++) {
    let hits = 0;
    let first = -1;
    let last = -1;
    for (let j = i; j < i + size; j++) {
      if (!hit[j]) continue;
      hits++;
      if (first < 0) first = j;
      last = j;
    }
    if (hits > (best?.hits || 0)) best = { hits, first, last };
  }
  if (!best || best.hits < Math.ceil(size / 2)) return null;
  return [at[best.first], at[best.last]];
}

// The verse with the recited words in one <mark>; `from` > 0 starts at that word with "…"
function markedVerseHtml(tokens, range, from = 0) {
  const words = (a, b) => tokens.slice(a, b).map(escapeHtml).join(' ');
  const lead = from > 0 ? '…' : '';
  if (!range) return [lead, words(from, tokens.length)].filter(Boolean).join(' ');
  const [start, end] = range;
  return [lead, words(from, start), `<mark>${words(start, end + 1)}</mark>`, words(end + 1, tokens.length)]
    .filter(Boolean).join(' ');
}

// Identical verses (Ar-Rahman's refrain, Al-Mursalat's, ...) differ at most in pause marks
function repeatKey(text) {
  return String(text || '').replace(/[ۖ-ۜ۞۩]/g, '').replace(/\s+/g, ' ').trim();
}

export class VoiceFinderModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);
    this.root = null;

    // What the page shows
    this.tab = 'find'; // 'find' | 'history' | 'saved'
    this.mode = 'idle'; // Find tab: 'idle' | 'listening' | 'typing' | 'result'
    this.query = ''; // what was searched, spoken or typed
    this.querySource = 'voice'; // 'voice' | 'typed'
    this.results = []; // matches, identical verses grouped, best first
    this.heroId = null; // the result in the big card
    this.rawMatchCount = 0;
    this.searching = false;
    this.searchFailed = false;
    this.fullVerse = false;
    this.showTranslation = false;
    this.draft = ''; // the text field, kept across re-renders
    this.confirmClear = false; // History: the inline "Clear all?" question

    // Speech
    this.recognition = null;
    this.isListening = false;
    this.isStopping = false; // browser engine: stop() sent, waiting for `end`
    this.isTranscribing = false; // on-device engine: final pass after stopping
    this.whisperStarting = false; // on-device engine: model loading or mic opening
    this.discardSpeech = false; // the recognition was aborted on purpose
    this.speechSession = 0; // on-device results of an older session are ignored
    this.transcriptionText = ''; // settled (final) text
    this.interimText = ''; // still-changing tail from the browser engine
    this.allTranscripts = []; // the browser engine's alternatives for the last recitation
    // An error or "no speech" message. The session is already over when it is set, so the
    // Find screen keeps showing it until the next mic tap.
    this.notice = null;
    this.modelStatus = ''; // on-device model download progress

    this.destroyed = false; // set by destroy() when the app leaves this page
    this.matchToken = 0; // only the latest search may render its results
    this.openingPageMap = false;
    this.play = { key: null, state: 'idle' }; // state: 'loading' | 'playing'
    this.audioListeners = null;
    this.toastTimer = 0;
    this.toastUndo = null;
    this.toastGroup = null; // { key, count } of removals sharing the toast on screen
    this.resizeFrame = 0;

    // Two engines (see asr-engine-pref.js): the browser's online SpeechRecognition
    // (default, faster) or the on-device Quran-tuned Whisper model (offline, slower).
    this.whisperSupported = QuranASR.isSupported();
    this.initSpeechRecognition();
    this.useWhisper = this.whisperSupported && (getAsrEngine() === 'whisper' || !this.recognition);
  }

  get speechAvailable() {
    return !!this.recognition || this.whisperSupported;
  }

  isBusy() {
    return this.isListening || this.isStopping || this.isTranscribing || this.whisperStarting;
  }

  // The header surah selector is hidden here and doesn't scope this module.
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
    this.unbindAudio();
    clearTimeout(this.toastTimer);
    this.toastUndo = null;
    cancelAnimationFrame(this.resizeFrame);
    window.removeEventListener('resize', this.onResize);
    const sheet = this.root?.querySelector('.vf-sheet');
    if (sheet?.open) sheet.close();
  }

  // --- Storage ---
  readList(key) {
    try {
      const list = JSON.parse(localStorage.getItem(key));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  writeList(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch (e) {
      console.warn(`Could not save ${key}:`, e);
    }
  }

  getHistory() {
    const history = this.readList(HISTORY_KEY);
    // Entries saved before ids existed get one (and keep it), so they can be deleted by id
    if (history.some(entry => !entry.id)) {
      history.forEach(entry => { if (!entry.id) entry.id = this.newHistoryId(); });
      this.writeList(HISTORY_KEY, history);
    }
    return history;
  }

  setHistory(list) {
    this.writeList(HISTORY_KEY, list.slice(0, MAX_HISTORY));
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
    this.setHistory(others);
  }

  getSaved() {
    return this.readList(SAVED_KEY);
  }

  isSaved(verseId) {
    return this.getSaved().some(v => v.id === verseId);
  }

  // Unique recent queries, newest first
  recentQueries(limit) {
    const seen = new Set();
    const queries = [];
    for (const entry of this.getHistory()) {
      const q = (entry.query || '').trim();
      if (!q || seen.has(q)) continue;
      seen.add(q);
      queries.push(q);
      if (queries.length >= limit) break;
    }
    return queries;
  }

  // --- Speech: the browser's online engine ---
  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition API not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'ar-SA'; // Arabic (Saudi Arabia) for recitation
    recognition.continuous = true; // Keep listening for longer recitations
    recognition.interimResults = true;
    recognition.maxAlternatives = 5; // More guesses to match against when the first finds nothing

    recognition.onresult = (e) => {
      if (this.discardSpeech) return;
      const finals = [];
      const pending = [];
      this.allTranscripts = [];

      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
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

      // Every word as soon as it is heard: settled words, then the still-changing tail
      if (this.transcriptionText || this.interimText) {
        this.showTranscript(this.transcriptionText, this.interimText);
      }
    };

    recognition.onerror = (e) => {
      if (this.discardSpeech) return;
      console.warn('Speech recognition error:', e.error);
      // Every error ends the session and the browser fires `end` right after. Keep the
      // message in state: onend shows it until the next mic tap.
      this.isListening = false;
      this.notice = this.noticeFor(e.error);
    };

    recognition.onend = () => {
      const discarded = this.discardSpeech;
      this.discardSpeech = false;
      this.isListening = false;
      this.isStopping = false;
      if (discarded || this.destroyed) return;

      // A tail that never became final is still what the user said
      const said = [this.transcriptionText, this.interimText].filter(Boolean).join(' ').trim();
      this.interimText = '';
      const alternatives = this.allTranscripts;
      const query = said || (alternatives[0] || '').trim();
      if (query) {
        this.transcriptionText = query;
        this.search(query, { source: 'voice', alternatives });
        return;
      }
      this.mode = 'idle';
      if (!this.notice) this.notice = NOTICES.noSpeech;
      this.renderFind({ focusMic: true });
    };

    this.recognition = recognition;
  }

  noticeFor(error) {
    switch (error) {
      case 'no-speech': return NOTICES.noSpeech;
      case 'not-allowed': return NOTICES.micBlocked;
      case 'audio-capture': return NOTICES.noMic;
      case 'network': return this.whisperSupported ? NOTICES.offline : NOTICES.offlineOnly;
      case 'service-not-allowed':
      case 'language-not-supported':
        return this.whisperSupported ? NOTICES.onlineUnavailable : NOTICES.unsupported;
      case 'aborted': return NOTICES.stopped;
      default: return { text: `Something went wrong (${error}). Tap the mic to try again.` };
    }
  }

  toggleMic() {
    if (this.whisperStarting || this.isStopping || this.isTranscribing) return; // one moment
    if (this.isListening) this.stopListening();
    else this.startListening();
  }

  startListening() {
    this.notice = null; // a new tap replaces the last error
    audioPlayer.pause(); // don't record the reciter
    this.tab = 'find';
    this.updateTabs();
    if (!this.speechAvailable) {
      this.mode = 'idle';
      this.notice = NOTICES.unsupported;
      this.renderFind({ focusMic: true });
      return;
    }
    if (this.useWhisper) {
      this.startWhisper();
      return;
    }

    this.transcriptionText = '';
    this.interimText = '';
    this.allTranscripts = [];
    this.discardSpeech = false;
    this.isListening = true;
    this.mode = 'listening';
    this.renderFind({ focusMic: true });
    try {
      this.recognition.start();
    } catch (e) {
      console.warn('SpeechRecognition start warning:', e);
      this.isListening = false;
      this.mode = 'idle';
      this.notice = NOTICES.generic;
      this.renderFind({ focusMic: true });
    }
  }

  // `discard`: drop what was heard (the user left the Find tab) instead of searching it
  stopListening({ discard = false } = {}) {
    if (this.useWhisper) {
      if (discard) this.cancelWhisper();
      else this.stopWhisper();
      return;
    }
    if (!this.recognition || (!this.isListening && !this.isStopping)) return;
    if (discard) {
      this.discardSpeech = true;
      this.isListening = false;
      this.isStopping = false;
      this.mode = 'idle';
      try { this.recognition.abort(); } catch { /* already over */ }
      return;
    }
    this.isStopping = true;
    this.updateListeningUI();
    try {
      this.recognition.stop(); // `end` follows with the final words, then the search
    } catch (e) {
      console.warn('SpeechRecognition stop warning:', e);
    }
  }

  // --- Speech: the on-device Whisper engine ---
  whisperProgress = (pct, phase) => {
    if (this.destroyed) return;
    this.modelStatus = phase === 'warming'
      ? 'Getting the on-device model ready…'
      : `Downloading the on-device model (45 MB, once)… ${pct}%`;
    this.updateModelStatus();
  };

  // Start loading the model as soon as Whisper is the chosen engine, so the first tap
  // on the mic doesn't have to wait for it.
  preloadWhisper() {
    if (!this.useWhisper || quranASR.modelReady) return;
    quranASR.ensureLoaded(this.whisperProgress)
      .then(() => {
        if (this.destroyed) return;
        this.modelStatus = '';
        this.updateModelStatus();
      })
      .catch((e) => {
        console.warn('On-device model preload failed:', e);
        if (this.destroyed || !this.useWhisper) return;
        // The mic retries the download, so say so rather than going quiet
        this.modelStatus = navigator.onLine === false
          ? 'On-device recognition needs internet once, for its 45 MB download.'
          : 'The on-device model couldn’t load. Tap the mic to try again.';
        this.updateModelStatus();
      });
  }

  async startWhisper() {
    if (this.whisperStarting || this.isTranscribing || quranASR.isRecording) return;
    const session = ++this.speechSession;
    const current = () => !this.destroyed && session === this.speechSession;
    this.whisperStarting = true;
    this.transcriptionText = '';
    this.interimText = '';
    this.allTranscripts = [];
    try {
      if (!quranASR.modelReady) {
        this.updateListeningUI(); // "Getting ready…" under the mic
        await quranASR.ensureLoaded(this.whisperProgress);
        if (!current()) return; // left the page or the tab while the model loaded
        this.modelStatus = '';
        this.updateModelStatus();
      }
      this.isListening = true;
      this.mode = 'listening';
      this.renderFind({ focusMic: true });

      await quranASR.startRecording((text, { settled = '', pending = text } = {}) => {
        if (!text || !this.isListening || !current()) return;
        // Finished phrases are final; the phrase still being recited may change (dimmed)
        this.transcriptionText = text;
        this.showTranscript(settled, pending);
      });
      // Left while the browser was still opening the mic
      if (!current()) {
        quranASR.cancelRecording();
        return;
      }
      this.whisperStarting = false;
      this.updateListeningUI();
    } catch (e) {
      if (!current()) return;
      console.error('On-device ASR failed:', e);
      this.whisperStarting = false;
      this.isListening = false;
      this.mode = 'idle';
      this.modelStatus = '';
      const name = e?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') this.notice = NOTICES.micBlocked;
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') this.notice = NOTICES.noMic;
      else if (name === 'NotReadableError' || name === 'AbortError') this.notice = NOTICES.micBusy;
      else if (!quranASR.modelReady && navigator.onLine === false) this.notice = NOTICES.modelOffline;
      else if (this.recognition) {
        // The model or its worker failed on this device: use online recognition for now
        this.useWhisper = false;
        this.toast('On-device recognition isn’t working here, so online recognition is on for now.');
        this.startListening();
        return;
      } else {
        this.notice = NOTICES.unsupported;
      }
      this.renderFind({ focusMic: true });
    }
  }

  async stopWhisper() {
    if (!quranASR.isRecording || this.isTranscribing) return;
    const session = this.speechSession;
    const current = () => !this.destroyed && session === this.speechSession;
    this.isListening = false;
    this.isTranscribing = true;
    this.updateListeningUI(); // the live text stays on screen while the final pass runs

    try {
      const text = ((await quranASR.stopAndTranscribe()) || '').trim();
      if (!current()) return; // left the page or the tab while transcribing
      this.isTranscribing = false;
      if (!text) {
        this.mode = 'idle';
        this.notice = NOTICES.noSpeech;
        this.renderFind({ focusMic: true });
        return;
      }
      this.transcriptionText = text;
      this.search(text, { source: 'voice' });
    } catch (e) {
      if (!current()) return;
      console.error('Transcription failed:', e);
      this.isTranscribing = false;
      this.mode = 'idle';
      this.notice = NOTICES.transcribeFailed;
      this.renderFind({ focusMic: true });
    }
  }

  // Stop recording and forget it; a transcription still running is ignored when it ends
  cancelWhisper() {
    this.speechSession++;
    if (quranASR.isRecording) quranASR.cancelRecording();
    this.isListening = false;
    this.isTranscribing = false;
    this.whisperStarting = false;
    this.mode = 'idle';
  }

  setEngine(engine) {
    if (this.isBusy()) return;
    const whisper = engine === 'whisper' && this.whisperSupported;
    if (!whisper && !this.recognition) return;
    this.useWhisper = whisper;
    setAsrEngine(whisper ? 'whisper' : 'browser');
    this.notice = null; // e.g. "Online recognition needs internet" no longer applies
    if (!whisper) this.modelStatus = '';
    if (this.tab === 'find' && this.mode === 'idle') this.renderPanel();
    this.preloadWhisper();
    this.refreshSheetNote();
  }

  // --- Rendering ---
  render() {
    this.container.innerHTML = `
      <div class="vf" data-tab="${this.tab}">
        <div class="vf-top">
          <div class="vf-tabs" role="tablist" aria-label="Voice Finder">
            ${TABS.map(tab => this.tabHtml(tab)).join('')}
          </div>
          <button type="button" class="vf-icon-btn" data-act="settings" aria-label="Recognition settings" aria-haspopup="dialog">${icon('sliders')}</button>
        </div>
        <div class="vf-panel" id="vf-panel" role="tabpanel" tabindex="-1" aria-labelledby="vf-tab-${this.tab}"></div>
        <button type="button" class="vf-mic vf-fab" data-act="mic" aria-label="Recite again" hidden>${icon('mic')}</button>
        <div class="vf-toast-region" role="status" aria-live="polite" data-toast-region></div>
        <div class="vf-sr-only" aria-live="polite" data-announcer></div>
        <dialog class="vf-sheet" aria-labelledby="vf-sheet-title"></dialog>
      </div>
    `;
    this.root = this.container.querySelector('.vf');
    this.bindEvents();
    this.bindAudio();
    this.renderPanel();
    this.preloadWhisper();
    // Clamping and the "Show full verse" link depend on the Arabic font's metrics
    document.fonts?.ready.then(() => { if (!this.destroyed) this.fitHeroVerse(); });
  }

  tabHtml(tab) {
    const selected = this.tab === tab;
    const label = { find: 'Find', history: 'History', saved: 'Saved' }[tab];
    const count = tab === 'saved' ? this.getSaved().length : 0;
    return `
      <button type="button" role="tab" class="vf-tab" id="vf-tab-${tab}" data-act="tab" data-tab="${tab}"
        aria-selected="${selected}" aria-controls="vf-panel" tabindex="${selected ? 0 : -1}">
        ${label}${tab === 'saved' ? `<span class="vf-count" data-saved-count${count ? '' : ' hidden'}>${count}</span>` : ''}
      </button>`;
  }

  updateTabs() {
    if (!this.root) return;
    this.root.querySelectorAll('[role="tab"]').forEach(tab => {
      const selected = tab.dataset.tab === this.tab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    this.root.querySelector('#vf-panel')?.setAttribute('aria-labelledby', `vf-tab-${this.tab}`);
    this.root.dataset.tab = this.tab;
  }

  updateSavedCount() {
    const badge = this.root?.querySelector('[data-saved-count]');
    if (!badge) return;
    const count = this.getSaved().length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  renderPanel() {
    const panel = this.root?.querySelector('#vf-panel');
    if (!panel) return;
    if (this.tab === 'history') panel.innerHTML = this.historyHtml();
    else if (this.tab === 'saved') panel.innerHTML = this.savedHtml();
    else panel.innerHTML = this.findHtml();
    this.updateFab();
    if (this.tab === 'find' && this.mode === 'result') this.fitHeroVerse();
  }

  // Redraw the Find tab, if it is the one on screen
  renderFind({ focusMic = false } = {}) {
    if (this.destroyed || this.tab !== 'find') return;
    this.renderPanel();
    if (focusMic) this.root.querySelector('[data-mic]')?.focus({ preventScroll: true });
  }

  // The floating "recite again" mic belongs to results
  updateFab() {
    const fab = this.root?.querySelector('.vf-fab');
    if (!fab) return;
    const show = this.tab === 'find' && this.mode === 'result';
    fab.hidden = !show;
    this.root.classList.toggle('vf--fab', show);
  }

  findHtml() {
    if (this.mode === 'listening') return this.listeningHtml();
    if (this.mode === 'typing') return this.typingHtml();
    if (this.mode === 'result') return this.resultHtml();
    return this.idleHtml();
  }

  idleHtml() {
    return `
      <div class="vf-find vf-find--idle">
        <p class="vf-hint">Recite a few words of any verse. You’ll get the surah, ayah and page.</p>
        ${this.noticeHtml()}
        <p class="vf-status-line" data-model-status${this.modelStatus ? '' : ' hidden'}>${escapeHtml(this.modelStatus)}</p>
        <div class="vf-spacer"></div>
        ${this.micZoneHtml()}
      </div>`;
  }

  noticeHtml() {
    const notice = this.notice;
    if (!notice) return '';
    return `
      <div class="vf-notice">
        <p>${escapeHtml(notice.text)}</p>
        ${notice.help ? `
          <details class="vf-help">
            <summary>How to allow it</summary>
            <p>Tap the icon to the left of the web address (a lock or sliders), open Permissions or Site settings, and set Microphone to Allow.</p>
          </details>` : ''}
        ${notice.action ? `<button type="button" class="vf-btn" data-act="${notice.action}">${escapeHtml(notice.actionLabel)}</button>` : ''}
      </div>`;
  }

  micLabel() {
    if (this.whisperStarting) return 'Getting ready…';
    if (this.isStopping || this.isTranscribing) return 'One moment…';
    return this.mode === 'listening' ? 'Tap to stop' : 'Tap and recite';
  }

  micZoneHtml() {
    const recording = this.mode === 'listening';
    const busy = this.whisperStarting || this.isStopping || this.isTranscribing;
    return `
      <div class="vf-mic-zone">
        <button type="button" class="vf-mic${recording ? ' is-rec' : ''}" data-act="mic" data-mic
          aria-label="${recording ? 'Stop reciting' : 'Start reciting'}" aria-pressed="${recording}"${busy ? ' aria-disabled="true"' : ''}>
          ${icon(recording ? 'stop' : 'mic')}
        </button>
        <span class="vf-mic-label" data-mic-label>${this.micLabel()}</span>
        ${recording
          ? '<span class="vf-mic-zone-pad" aria-hidden="true"></span>'
          : `<button type="button" class="vf-btn vf-btn--ghost" data-act="type">${icon('kbd')}Type instead</button>`}
      </div>`;
  }

  listeningStatus() {
    if (this.whisperStarting) return 'Opening the microphone…';
    if (this.isTranscribing) return 'Finishing the transcription…';
    if (this.isStopping) return 'One moment…';
    return this.useWhisper
      ? 'Listening… the words appear every few seconds. Tap to stop.'
      : 'Listening… tap to stop.';
  }

  listeningHtml() {
    const busy = this.whisperStarting || this.isStopping || this.isTranscribing;
    return `
      <div class="vf-find vf-find--listening">
        <p class="vf-live${busy ? ' is-busy' : ''}" role="status" aria-live="polite" data-status>${escapeHtml(this.listeningStatus())}</p>
        <div class="vf-transcript is-empty" dir="rtl" lang="ar" data-live>…</div>
        <div class="vf-spacer"></div>
        ${this.micZoneHtml()}
      </div>`;
  }

  typingHtml() {
    // Up to 3 recent searches, leaving out the one already in the field
    const recent = this.recentQueries(4).filter(q => q !== this.draft.trim()).slice(0, 3);
    return `
      <div class="vf-find vf-find--typing">
        <form class="vf-search" role="search" data-form="search" novalidate>
          <input id="vf-query" class="vf-field" type="search" name="q" dir="rtl" lang="ar"
            enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
            placeholder="اكتب كلمات من الآية" aria-label="Verse words" value="${escapeHtml(this.draft)}">
          <button type="submit" class="vf-btn vf-btn--primary">${icon('search')}Search</button>
        </form>
        <p class="vf-form-hint" data-form-hint hidden>Type a few words from the verse.</p>
        ${recent.length ? `
          <h3 class="vf-sec-h">Recent searches</h3>
          <div class="vf-chips">
            ${recent.map(q => `<button type="button" class="vf-chip" data-act="recent" data-query="${escapeHtml(q)}" dir="rtl" lang="ar">${escapeHtml(q)}</button>`).join('')}
          </div>` : ''}
        <div class="vf-spacer"></div>
        ${this.speechAvailable ? `<button type="button" class="vf-btn vf-back" data-act="back-to-mic">${icon('mic')}Back to reciting</button>` : ''}
      </div>`;
  }

  resultHtml() {
    let body;
    if (this.searching) {
      body = '<div class="vf-card vf-searching" aria-busy="true"><span class="vf-spinner" aria-hidden="true"></span>Finding the verse…</div>';
    } else if (this.searchFailed) {
      body = `
        <div class="vf-card vf-nomatch">
          <h3 class="vf-card-title">The search didn’t work</h3>
          <p>Something went wrong while searching. Please try again.</p>
          <button type="button" class="vf-btn" data-act="retry">Try again</button>
        </div>`;
    } else if (!this.results.length) {
      body = `
        <div class="vf-card vf-nomatch">
          <h3 class="vf-card-title">No verse matched</h3>
          <p>Recite a few more words, or type them.</p>
          <button type="button" class="vf-btn" data-act="edit">${icon('edit')}Edit the words</button>
        </div>`;
    } else {
      body = this.heroHtml() + this.othersHtml();
    }
    return `
      <div class="vf-find vf-find--result">
        <div class="vf-heard">
          <span class="vf-heard-label">${this.querySource === 'voice' ? 'You recited' : 'You searched'}</span>
          <span class="vf-heard-text" dir="rtl" lang="ar">${escapeHtml(this.query)}</span>
          <button type="button" class="vf-btn vf-btn--ghost vf-heard-edit" data-act="edit" aria-label="Edit the words">${icon('edit')}Edit</button>
        </div>
        ${body}
      </div>`;
  }

  heroResult() {
    return this.results.find(r => r.ayah.id === this.heroId) || this.results[0] || null;
  }

  locHtml(surah, ayah, page, juz) {
    return `<span>${surah}:${ayah}</span>${page ? `<span>Page ${page}</span>` : ''}${juz ? `<span>Juz ${juz}</span>` : ''}`;
  }

  heroVerseHtml(result, { excerpt = false } = {}) {
    const tokens = String(result.ayah.text || '').split(/\s+/).filter(Boolean);
    const range = recitedRange(tokens, this.query);
    // Start just before the recited words when they would be clamped out of view
    const from = excerpt && range ? Math.max(0, range[0] - 3) : 0;
    return markedVerseHtml(tokens, range, from);
  }

  heroHtml() {
    const result = this.heroResult();
    const a = result.ayah;
    const { en, ar } = surahNames(a.surah, a);
    const page = pageOfAyah(a.surah, a.ayah);
    const juz = juzOfAyah(a.surah, a.ayah);
    const translation = (a.translation || '').trim();
    return `
      <article class="vf-card vf-hero" data-hero tabindex="-1" aria-labelledby="vf-hero-title">
        <div class="vf-row">
          <span class="vf-eyebrow">${result === this.results[0] ? 'Best match' : 'Selected match'}</span>
          <span class="vf-pill vf-pill--${result.kind}">${MATCH_LABELS[result.kind]}</span>
        </div>
        <h3 class="vf-surah" id="vf-hero-title">
          <span class="vf-surah-en">${escapeHtml(en)}</span>
          <span class="vf-surah-ar" lang="ar" dir="rtl">${escapeHtml(ar)}</span>
        </h3>
        <p class="vf-loc">${this.locHtml(a.surah, a.ayah, page, juz)}</p>
        <p class="vf-verse${this.fullVerse ? '' : ' is-clamped'}" dir="rtl" lang="ar" data-verse>${this.heroVerseHtml(result)}</p>
        <div class="vf-row vf-toggles">
          <button type="button" class="vf-link" data-act="full-verse" aria-expanded="${this.fullVerse}"${this.fullVerse ? '' : ' hidden'}>${this.fullVerse ? 'Show less' : 'Show full verse'}</button>
          ${translation ? `<button type="button" class="vf-link vf-link--end" data-act="translation" aria-expanded="${this.showTranslation}" aria-controls="vf-hero-tr">Translation</button>` : ''}
        </div>
        ${translation ? `<p class="vf-translation" id="vf-hero-tr"${this.showTranslation ? '' : ' hidden'}>${escapeHtml(translation)}</p>` : ''}
        <div class="vf-actions">
          ${this.saveButtonHtml(a.id, this.isSaved(a.id))}
          ${this.playButtonHtml(a.id, a.globalId)}
          ${this.pageButtonHtml(a.surah, a.ayah, page)}
        </div>
        ${result.repeats > 1 ? `<p class="vf-note">${this.repeatText(result)}</p>` : ''}
      </article>`;
  }

  repeatText(result) {
    const { en } = surahNames(result.ayah.surah, result.ayah);
    return result.repeatSurahs === 1
      ? `This verse repeats <b>${result.repeats} times</b> in ${escapeHtml(en)}. Showing the first.`
      : `This verse appears <b>${result.repeats} times</b> in the Quran. Showing the first.`;
  }

  othersHtml() {
    const hero = this.heroResult();
    const others = this.results.filter(r => r !== hero);
    if (!others.length) return '';
    // No verse is an exact match, but the words occur in several: say so instead of a bare
    // score. If every slot the matcher returned holds them, there may be more than shown.
    const verbatim = this.results.filter(r => r.kind === 'exact' || r.kind === 'phrase').length;
    const capped = this.rawMatchCount >= MAX_MATCHES && verbatim === this.results.length;
    const several = this.results[0].kind === 'phrase' && verbatim >= 2
      ? `<p class="vf-note">${capped ? 'These words appear in many verses.' : `These words appear in ${verbatim} verses.`} Recite a little more to narrow it down.</p>`
      : '';
    const title = others.every(r => r.kind === 'phrase')
      ? `Also contains your words (${others.length})`
      : `Other matches (${others.length})`;
    return `
      <section class="vf-others" aria-labelledby="vf-others-title">
        ${several}
        <h3 class="vf-sec-h" id="vf-others-title">${title}</h3>
        <ul class="vf-list vf-card vf-card--list">
          ${others.map(r => this.otherRowHtml(r)).join('')}
        </ul>
      </section>`;
  }

  otherRowHtml(result) {
    const a = result.ayah;
    const { en } = surahNames(a.surah, a);
    const page = pageOfAyah(a.surah, a.ayah);
    const juz = juzOfAyah(a.surah, a.ayah);
    const meta = [
      page && `Page ${page}`,
      juz && `Juz ${juz}`,
      MATCH_LABELS[result.kind],
      result.repeats > 1 && `repeats ${result.repeats}×`,
    ].filter(Boolean).join(' · ');
    return `
      <li class="vf-item">
        <button type="button" class="vf-item-main" data-act="pick" data-id="${escapeHtml(a.id)}">
          <strong>${escapeHtml(en)} ${a.surah}:${a.ayah}</strong>
          <span class="vf-item-ar" dir="rtl" lang="ar">${escapeHtml(a.text)}</span>
          <small>${escapeHtml(meta)}</small>
        </button>
        ${this.starButtonHtml(a.id, `${en} ${a.surah}:${a.ayah}`, this.isSaved(a.id))}
      </li>`;
  }

  // Save / Saved toggle. The three hero actions are equal grid columns, so the label
  // change never moves anything; aria-pressed carries the state.
  saveButtonHtml(id, saved) {
    return `<button type="button" class="vf-btn vf-save" data-act="save" data-id="${escapeHtml(id)}" aria-pressed="${saved}">${icon('star')}<span data-label>${saved ? 'Saved' : 'Save'}</span></button>`;
  }

  starButtonHtml(id, ref, saved) {
    return `<button type="button" class="vf-star" data-act="save" data-id="${escapeHtml(id)}" aria-pressed="${saved}" aria-label="Save ${escapeHtml(ref)}">${icon('star')}</button>`;
  }

  playButtonInner(id) {
    const on = this.play.key === id;
    const loading = on && this.play.state === 'loading';
    return `${icon(on && !loading ? 'pause' : 'play')}<span data-label>${loading ? 'Loading…' : on ? 'Pause' : 'Play'}</span>`;
  }

  playButtonHtml(id, globalId) {
    const on = this.play.key === id;
    return `<button type="button" class="vf-btn" data-act="play" data-id="${escapeHtml(id)}" data-global-id="${Number(globalId) || ''}" aria-pressed="${on}"${on && this.play.state === 'loading' ? ' aria-busy="true"' : ''}>${this.playButtonInner(id)}</button>`;
  }

  pageButtonHtml(surah, ayah, page) {
    if (!page) return '';
    return `<button type="button" class="vf-btn vf-btn--primary" data-act="open-page" data-surah="${surah}" data-ayah="${ayah}" aria-label="Open page ${page}">${icon('page')}<span data-label>Page ${page}</span></button>`;
  }

  historyHtml() {
    const history = this.getHistory();
    if (!history.length) {
      return `
        <div class="vf-empty">
          ${icon('clock')}
          <b>No searches yet</b>
          <span>Recite or type a verse and it shows up here.</span>
        </div>`;
    }
    const group = (label, items) => items.length ? `
      <h3 class="vf-group">${label}</h3>
      <ul class="vf-list">${items.map(entry => this.historyRowHtml(entry)).join('')}</ul>` : '';
    const count = history.length;
    return `
      <div class="vf-history">
        ${group('Today', history.filter(entry => isToday(entry.timestamp)))}
        ${group('Earlier', history.filter(entry => !isToday(entry.timestamp)))}
        <div class="vf-history-foot">
          ${this.confirmClear ? `
            <div class="vf-confirm" role="group" aria-labelledby="vf-confirm-text">
              <span id="vf-confirm-text">${count === 1 ? 'Clear the 1 search?' : `Clear all ${count} searches?`}</span>
              <span class="vf-confirm-btns">
                <button type="button" class="vf-btn" data-act="clear-cancel">Cancel</button>
                <button type="button" class="vf-btn vf-btn--danger-solid" data-act="clear-confirm">Clear</button>
              </span>
            </div>` : '<button type="button" class="vf-btn vf-btn--danger" data-act="clear-history">Clear history</button>'}
        </div>
      </div>`;
  }

  historyRowHtml(entry) {
    const top = entry.topMatch;
    let meta = 'No match';
    if (top?.surah && top?.ayah) {
      const surah = Number(top.surah);
      const ayah = Number(top.ayah);
      const page = pageOfAyah(surah, ayah);
      meta = `${surahNames(surah, top).en} ${surah}:${ayah}${page ? ` · Page ${page}` : ''}`;
    }
    // The query is whatever was typed or heard, so it is escaped, never rendered as HTML
    return `
      <li class="vf-item">
        <button type="button" class="vf-item-main" data-act="rerun" data-history-id="${escapeHtml(entry.id)}">
          <span class="vf-item-ar" dir="rtl" lang="ar">${escapeHtml(entry.query)}</span>
          <small>${escapeHtml(meta)} · ${escapeHtml(timeLabel(entry.timestamp))}</small>
        </button>
        <button type="button" class="vf-icon-btn" data-act="remove-history" data-history-id="${escapeHtml(entry.id)}" aria-label="Remove from history: ${escapeHtml(entry.query)}">${icon('x')}</button>
      </li>`;
  }

  savedHtml() {
    const saved = this.getSaved();
    if (!saved.length) {
      return `
        <div class="vf-empty">
          ${icon('star')}
          <b>Nothing saved yet</b>
          <span>Tap Save on a result to keep it here for review.</span>
        </div>`;
    }
    return `
      <div class="vf-saved">
        <h3 class="vf-sec-h">Recently saved</h3>
        <ul class="vf-saved-list">${saved.map(verse => this.savedCardHtml(verse)).join('')}</ul>
      </div>`;
  }

  savedCardHtml(verse) {
    const surah = Number(verse.surah);
    const ayah = Number(verse.ayah);
    const { en, ar } = surahNames(surah, verse);
    const page = pageOfAyah(surah, ayah);
    const juz = juzOfAyah(surah, ayah);
    return `
      <li class="vf-card vf-saved-card">
        <div class="vf-row vf-row--top">
          <h3 class="vf-surah vf-surah--sm">
            <span class="vf-surah-en">${escapeHtml(en)}</span>
            <span class="vf-surah-ar" lang="ar" dir="rtl">${escapeHtml(ar)}</span>
          </h3>
          ${this.starButtonHtml(verse.id, `${en} ${surah}:${ayah}`, true)}
        </div>
        <p class="vf-loc">${this.locHtml(surah, ayah, page, juz)}</p>
        <p class="vf-verse vf-verse--sm is-clamped" dir="rtl" lang="ar">${escapeHtml(verse.text)}</p>
        <div class="vf-actions vf-actions--2">
          ${this.playButtonHtml(verse.id, verse.globalId)}
          ${this.pageButtonHtml(surah, ayah, page)}
        </div>
      </li>`;
  }

  sheetNote() {
    if (this.isBusy()) return 'Stop reciting to change this.';
    if (this.useWhisper && this.modelStatus) return this.modelStatus;
    if (this.useWhisper && quranASR.modelReady) return 'The on-device model is ready.';
    return '';
  }

  sheetHtml() {
    const device = window.matchMedia?.('(pointer: coarse)').matches ? 'phone' : 'device';
    const busy = this.isBusy();
    const engine = this.useWhisper ? 'whisper' : 'browser';
    const note = this.sheetNote();
    const option = (value, title, text, available) => `
      <label class="vf-radio">
        <input type="radio" name="vf-engine" value="${value}"${engine === value ? ' checked' : ''}${available && !busy ? '' : ' disabled'}>
        <span class="vf-radio-text"><b>${title}</b><small>${available ? text : 'Not available in this browser.'}</small></span>
      </label>`;
    return `
      <div class="vf-sheet-inner">
        <div class="vf-grab" aria-hidden="true"></div>
        <div class="vf-row">
          <h2 class="vf-sheet-title" id="vf-sheet-title">Recognition</h2>
          <button type="button" class="vf-icon-btn" data-act="close-settings" aria-label="Close">${icon('x')}</button>
        </div>
        <fieldset class="vf-options">
          <legend class="vf-sr-only">Recognition engine</legend>
          ${option('browser', 'Online · faster', 'Your browser’s speech service. Needs internet and may send audio online.', !!this.recognition)}
          ${option('whisper', `On this ${device} · private`, 'Quran-tuned Whisper. Works offline after a one-time 45 MB download. Slower.', this.whisperSupported)}
        </fieldset>
        <p class="vf-sheet-note" data-sheet-note${note ? '' : ' hidden'}>${escapeHtml(note)}</p>
      </div>`;
  }

  // --- In-place updates (nothing else on the page moves) ---
  updateListeningUI() {
    if (!this.root || this.tab !== 'find') return;
    const busy = this.whisperStarting || this.isStopping || this.isTranscribing;
    const mic = this.root.querySelector('[data-mic]');
    if (mic) {
      if (busy) mic.setAttribute('aria-disabled', 'true');
      else mic.removeAttribute('aria-disabled');
    }
    const label = this.root.querySelector('[data-mic-label]');
    if (label) label.textContent = this.micLabel();
    const status = this.root.querySelector('[data-status]');
    if (status) {
      status.textContent = this.listeningStatus();
      status.classList.toggle('is-busy', busy);
    }
    this.refreshSheetNote();
  }

  updateModelStatus() {
    const line = this.root?.querySelector('[data-model-status]');
    if (line) {
      line.textContent = this.modelStatus;
      line.hidden = !this.modelStatus;
    }
    this.refreshSheetNote();
  }

  refreshSheetNote() {
    const note = this.root?.querySelector('[data-sheet-note]');
    if (!note) return;
    const text = this.sheetNote();
    note.textContent = text;
    note.hidden = !text;
    const busy = this.isBusy();
    this.root.querySelectorAll('input[name="vf-engine"]').forEach(input => {
      const available = input.value === 'whisper' ? this.whisperSupported : !!this.recognition;
      input.disabled = busy || !available;
    });
  }

  // Settled words in normal ink, the still-changing tail lighter after them
  showTranscript(settled, pending = '') {
    const box = this.root?.querySelector('[data-live]');
    if (!box) return;
    box.classList.remove('is-empty');
    box.replaceChildren();
    if (settled) box.append(settled);
    if (pending) {
      const tail = document.createElement('span');
      tail.className = 'vf-pending';
      tail.textContent = settled ? ` ${pending}` : pending;
      box.append(tail);
    }
    box.scrollTop = box.scrollHeight;
  }

  // Clamp the hero verse to 3 lines, but keep the recited words in view, and offer
  // "Show full verse" only when something is cut off.
  fitHeroVerse() {
    const hero = this.root?.querySelector('[data-hero]');
    const verse = hero?.querySelector('[data-verse]');
    const toggle = hero?.querySelector('[data-act="full-verse"]');
    const result = this.heroResult();
    if (!verse || !toggle || !result) return;
    verse.innerHTML = this.heroVerseHtml(result);
    if (this.fullVerse) {
      toggle.hidden = false;
      return;
    }
    let excerpted = false;
    const mark = verse.querySelector('mark');
    if (mark) {
      const lineHeight = parseFloat(getComputedStyle(verse).lineHeight) || 40;
      if (mark.offsetTop > verse.clientHeight - lineHeight * 0.75) {
        verse.innerHTML = this.heroVerseHtml(result, { excerpt: true });
        excerpted = true;
      }
    }
    toggle.hidden = !(excerpted || verse.scrollHeight > verse.clientHeight + 2);
  }

  syncSaveButtons(verseId) {
    const saved = this.isSaved(verseId);
    this.root?.querySelectorAll('[data-act="save"]').forEach(btn => {
      if (btn.dataset.id !== verseId) return;
      btn.setAttribute('aria-pressed', String(saved));
      const label = btn.querySelector('[data-label]');
      if (label) label.textContent = saved ? 'Saved' : 'Save';
    });
  }

  setPlayState(key, state) {
    this.play = { key: state === 'idle' ? null : key, state };
    this.root?.querySelectorAll('[data-act="play"]').forEach(btn => {
      const id = btn.dataset.id;
      const on = this.play.key === id;
      btn.setAttribute('aria-pressed', String(on));
      if (on && state === 'loading') btn.setAttribute('aria-busy', 'true');
      else btn.removeAttribute('aria-busy');
      btn.innerHTML = this.playButtonInner(id);
    });
  }

  // Cleared first and set a moment later, so the same message twice is still read out
  announce(text) {
    const el = this.root?.querySelector('[data-announcer]');
    if (!el) return;
    el.textContent = '';
    setTimeout(() => { if (el.isConnected) el.textContent = text; }, 100);
  }

  scrollToTop() {
    if (this.container) this.container.scrollTop = 0; // larger screens: the content area scrolls
    if ((document.scrollingElement?.scrollTop || 0) > 0) window.scrollTo(0, 0); // phones: the page does
  }

  focusHero() {
    const active = document.activeElement;
    if (active && active !== document.body && this.root.contains(active) && active.isConnected) return;
    this.root.querySelector('[data-hero]')?.focus({ preventScroll: true });
  }

  // --- Toasts ---
  // `group`: removals of the same kind while the toast is up share it, and its Undo brings
  // all of them back. After a removal the next row slides under the finger, so a double
  // tap would otherwise lose the first one for good.
  toast(message, undo = null, group = null) {
    const region = this.root?.querySelector('[data-toast-region]');
    if (!region) return;
    clearTimeout(this.toastTimer);
    if (group && undo && this.toastGroup?.key === group.key && this.toastUndo) {
      const earlier = this.toastUndo;
      const latest = undo;
      undo = () => { latest(); earlier(); }; // newest first, so each lands back in its place
      this.toastGroup.count++;
      message = group.many(this.toastGroup.count);
    } else {
      this.toastGroup = group ? { key: group.key, count: 1 } : null;
    }
    this.toastUndo = undo;
    region.innerHTML = `
      <div class="vf-toast">
        <span class="vf-toast-msg">${escapeHtml(message)}</span>
        ${undo ? '<button type="button" class="vf-toast-undo" data-act="undo">Undo</button>' : ''}
      </div>`;
    this.toastTimer = setTimeout(() => this.hideToast(), TOAST_MS);
  }

  hideToast() {
    clearTimeout(this.toastTimer);
    this.toastUndo = null;
    this.toastGroup = null;
    this.root?.querySelector('[data-toast-region]')?.replaceChildren();
  }

  undo() {
    const restore = this.toastUndo;
    this.hideToast();
    restore?.();
  }

  // --- Events: one listener per kind on the page's root, driven by data-act ---
  bindEvents() {
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('submit', this.onSubmit);
    this.root.addEventListener('input', this.onInput);
    this.root.addEventListener('change', this.onChange);
    this.root.addEventListener('keydown', this.onKeydown);
    window.addEventListener('resize', this.onResize);

    const sheet = this.root.querySelector('.vf-sheet');
    // A tap on the dimmed backdrop lands on the dialog itself
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
    sheet.addEventListener('close', () => {
      if (!this.destroyed) this.root.querySelector('[data-act="settings"]')?.focus({ preventScroll: true });
    });

    // The toast waits while it has focus or a mouse over it (someone reaching for Undo)
    const region = this.root.querySelector('[data-toast-region]');
    const hold = () => clearTimeout(this.toastTimer);
    const resume = () => {
      clearTimeout(this.toastTimer);
      if (region.firstElementChild) this.toastTimer = setTimeout(() => this.hideToast(), TOAST_MS);
    };
    region.addEventListener('focusin', hold);
    region.addEventListener('focusout', resume);
    region.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') hold(); });
    region.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') resume(); });
  }

  bindAudio() {
    this.unbindAudio();
    const audio = audioPlayer.audio;
    const key = () => audioPlayer.currentAyahKey;
    this.audioListeners = {
      play: () => this.setPlayState(key(), 'loading'),
      playing: () => this.setPlayState(key(), 'playing'),
      waiting: () => { if (!audio.paused) this.setPlayState(key(), 'loading'); },
      pause: () => this.setPlayState(null, 'idle'),
      ended: () => this.setPlayState(null, 'idle'),
      error: () => { if (this.play.key) this.playFailed(); },
    };
    Object.entries(this.audioListeners).forEach(([type, fn]) => audio.addEventListener(type, fn));
  }

  unbindAudio() {
    if (!this.audioListeners) return;
    Object.entries(this.audioListeners).forEach(([type, fn]) => audioPlayer.audio.removeEventListener(type, fn));
    this.audioListeners = null;
  }

  onClick = (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !this.root.contains(el) || el.disabled) return;
    switch (el.dataset.act) {
      case 'tab': this.switchTab(el.dataset.tab); break;
      case 'settings': this.openSettings(); break;
      case 'close-settings': this.root.querySelector('.vf-sheet')?.close(); break;
      case 'mic': this.toggleMic(); break;
      case 'use-device':
        this.setEngine('whisper');
        if (this.useWhisper) this.startListening();
        break;
      case 'type': this.openTyping(''); break;
      case 'edit': this.openTyping(this.query); break;
      case 'back-to-mic': this.backToMic(); break;
      case 'recent': this.search(el.dataset.query || '', { source: 'typed' }); break;
      case 'retry': this.search(this.query, { source: this.querySource }); break;
      case 'pick': this.pickResult(el.dataset.id); break;
      case 'full-verse': this.toggleFullVerse(el); break;
      case 'translation': this.toggleTranslation(el); break;
      case 'save': this.toggleSave(el.dataset.id); break;
      case 'play': this.togglePlay(el.dataset.id, Number(el.dataset.globalId)); break;
      case 'open-page': this.openPageMap(el); break;
      case 'rerun': this.rerunHistory(el.dataset.historyId); break;
      case 'remove-history': this.removeHistory(el.dataset.historyId); break;
      case 'clear-history': this.setConfirmClear(true); break;
      case 'clear-cancel': this.setConfirmClear(false); break;
      case 'clear-confirm': this.clearHistory(); break;
      case 'undo': this.undo(); break;
      default: break;
    }
  };

  // Submit on the form, not on keypress, which Arabic keyboards don't always send
  onSubmit = (e) => {
    if (!e.target.matches('[data-form="search"]')) return;
    e.preventDefault();
    const input = e.target.querySelector('#vf-query');
    const query = (input?.value || '').trim();
    if (!query) {
      const hint = this.root.querySelector('[data-form-hint]');
      if (hint) hint.hidden = false;
      input?.focus();
      return;
    }
    input.blur(); // close the phone keyboard so the answer has the screen
    this.draft = query;
    // Typed text: no voice alternatives, so the last recitation's guesses aren't retried
    this.search(query, { source: 'typed' });
  };

  onInput = (e) => {
    if (e.target.id !== 'vf-query') return;
    this.draft = e.target.value;
    const hint = this.root.querySelector('[data-form-hint]');
    if (hint && !hint.hidden && this.draft.trim()) hint.hidden = true;
  };

  onChange = (e) => {
    if (e.target.name === 'vf-engine') this.setEngine(e.target.value);
  };

  // Arrow keys move between the tabs
  onKeydown = (e) => {
    const tab = e.target.closest?.('[role="tab"]');
    if (!tab) return;
    let index = TABS.indexOf(tab.dataset.tab);
    if (e.key === 'ArrowRight') index = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') index = (index + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') index = 0;
    else if (e.key === 'End') index = TABS.length - 1;
    else return;
    e.preventDefault();
    this.switchTab(TABS[index]);
    this.root.querySelector(`#vf-tab-${TABS[index]}`)?.focus();
  };

  onResize = () => {
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      if (!this.destroyed && this.tab === 'find' && this.mode === 'result') this.fitHeroVerse();
    });
  };

  // --- Actions ---
  switchTab(tab) {
    if (!TABS.includes(tab) || tab === this.tab) return;
    // Leaving Find mid-recitation drops it, so nothing redraws a tab you are reading
    if (this.isBusy()) this.stopListening({ discard: true });
    this.tab = tab;
    this.confirmClear = false;
    this.updateTabs();
    this.renderPanel();
    this.scrollToTop();
  }

  openTyping(prefill) {
    this.mode = 'typing';
    this.draft = prefill || '';
    this.renderFind();
    const input = this.root.querySelector('#vf-query');
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    try { input.setSelectionRange(end, end); } catch { /* not supported for this input */ }
  }

  backToMic() {
    this.mode = 'idle';
    this.renderFind({ focusMic: true });
  }

  pickResult(id) {
    if (!this.results.some(r => r.ayah.id === id)) return;
    this.heroId = id;
    this.fullVerse = false;
    this.showTranslation = false;
    this.renderPanel();
    this.scrollToTop();
    this.root.querySelector('[data-hero]')?.focus({ preventScroll: true });
  }

  toggleFullVerse(btn) {
    this.fullVerse = !this.fullVerse;
    const verse = this.root.querySelector('[data-hero] [data-verse]');
    verse?.classList.toggle('is-clamped', !this.fullVerse);
    btn.setAttribute('aria-expanded', String(this.fullVerse));
    btn.textContent = this.fullVerse ? 'Show less' : 'Show full verse';
    this.fitHeroVerse();
  }

  toggleTranslation(btn) {
    this.showTranslation = !this.showTranslation;
    btn.setAttribute('aria-expanded', String(this.showTranslation));
    const text = this.root.querySelector('#vf-hero-tr');
    if (text) text.hidden = !this.showTranslation;
  }

  openSettings() {
    const sheet = this.root.querySelector('.vf-sheet');
    if (!sheet || sheet.open) return;
    sheet.innerHTML = this.sheetHtml();
    sheet.showModal();
    (sheet.querySelector('input:checked:not(:disabled)') || sheet.querySelector('[data-act="close-settings"]'))?.focus();
  }

  toggleSave(verseId) {
    const list = this.getSaved();
    const index = list.findIndex(v => v.id === verseId);
    let record;
    if (index >= 0) {
      [record] = list.splice(index, 1);
    } else {
      const a = this.results.find(r => r.ayah.id === verseId)?.ayah;
      if (!a) return;
      record = {
        id: a.id,
        surah: a.surah,
        ayah: a.ayah,
        surahName: a.surahName,
        surahNameEn: a.surahNameEn,
        text: a.text,
        translation: a.translation,
        globalId: a.globalId,
        addedAt: Date.now()
      };
      list.unshift(record);
    }
    const saved = index < 0;
    // Flip the button first; storage follows
    this.writeList(SAVED_KEY, list);
    vibrate();
    this.afterSavedChange(verseId, saved ? -1 : index);

    const ref = `${surahNames(Number(record.surah), record).en} ${record.surah}:${record.ayah}`;
    this.toast(saved ? `Saved ${ref}` : `Removed ${ref}`, () => {
      const current = this.getSaved().filter(v => v.id !== verseId);
      if (!saved) current.splice(Math.min(index, current.length), 0, record); // back in its place
      this.writeList(SAVED_KEY, current);
      this.afterSavedChange(verseId, -1);
    }, saved ? null : { key: 'saved-remove', many: n => `Removed ${n} saved verses` });
  }

  // Results update the Save buttons in place. The Saved tab is that list, so it redraws.
  afterSavedChange(verseId, removedIndex) {
    this.updateSavedCount();
    if (this.tab !== 'saved') {
      this.syncSaveButtons(verseId);
      return;
    }
    this.renderPanel();
    if (removedIndex < 0) return;
    // Keep keyboard focus near the card that went away
    const stars = this.root.querySelectorAll('#vf-panel .vf-star');
    (stars[removedIndex] || stars[removedIndex - 1] || this.root.querySelector('#vf-panel'))?.focus({ preventScroll: true });
  }

  togglePlay(verseId, globalId) {
    if (!globalId) return;
    const audio = audioPlayer.audio;
    if (audioPlayer.currentGlobalId === globalId && audioPlayer.currentAyahKey === verseId) {
      if (!audio.paused) {
        audioPlayer.pause();
        return;
      }
      if (audio.currentTime > 0 && !audio.ended) { // paused part-way: carry on
        audio.play().catch((e) => { if (e?.name !== 'AbortError') this.playFailed(); });
        return;
      }
    }
    this.setPlayState(verseId, 'loading');
    audioPlayer.playGlobalVerse(globalId, verseId, { onError: () => this.playFailed() });
  }

  playFailed() {
    this.setPlayState(null, 'idle');
    this.toast('Couldn’t play this verse. Check your internet connection.');
  }

  // Opening the Page Map loads that page's layout, so the button says so and further
  // taps are ignored until the app has switched pages.
  async openPageMap(btn) {
    if (!window.app || this.openingPageMap) return;
    this.openingPageMap = true;
    const label = btn.innerHTML;
    const ariaLabel = btn.getAttribute('aria-label');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-label', 'Opening page…');
    btn.innerHTML = '<span data-label>Opening page…</span>';
    try {
      await window.app.navigateToPageMap(parseInt(btn.dataset.surah, 10), parseInt(btn.dataset.ayah, 10));
    } catch (e) {
      console.error('Could not open the Page Map:', e);
    } finally {
      this.openingPageMap = false;
      // Still on this page (the app didn't navigate): give the button back
      if (btn.isConnected) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
        btn.innerHTML = label;
      }
    }
  }

  rerunHistory(id) {
    const entry = this.getHistory().find(h => h.id === id);
    if (!entry?.query) return;
    this.draft = entry.query;
    // Re-run as text: the last recitation's alternatives don't belong to it
    this.search(entry.query, { source: 'typed' });
  }

  removeHistory(id) {
    const history = this.getHistory();
    const index = history.findIndex(h => h.id === id);
    if (index < 0) return;
    const [entry] = history.splice(index, 1);
    this.setHistory(history);
    this.confirmClear = false;
    this.renderPanel();
    const removes = this.root.querySelectorAll('#vf-panel [data-act="remove-history"]');
    (removes[index] || removes[index - 1] || this.root.querySelector('#vf-panel'))?.focus({ preventScroll: true });
    this.toast('Removed from history', () => {
      const current = this.getHistory();
      if (!current.some(h => h.id === entry.id || (h.query || '').trim() === (entry.query || '').trim())) {
        current.splice(Math.min(index, current.length), 0, entry);
      }
      this.setHistory(current);
      if (this.tab === 'history') this.renderPanel();
    }, { key: 'history-remove', many: n => `Removed ${n} searches from history` });
  }

  setConfirmClear(on) {
    this.confirmClear = on;
    this.renderPanel();
    this.root.querySelector(on ? '[data-act="clear-cancel"]' : '[data-act="clear-history"]')?.focus({ preventScroll: true });
  }

  clearHistory() {
    const old = this.getHistory();
    this.writeList(HISTORY_KEY, []);
    this.confirmClear = false;
    this.renderPanel();
    this.root.querySelector('#vf-panel')?.focus({ preventScroll: true });
    this.toast('History cleared', () => {
      const current = this.getHistory(); // searches made since stay on top
      const restored = old.filter(o => !current.some(c => c.id === o.id || (c.query || '').trim() === (o.query || '').trim()));
      this.setHistory([...current, ...restored]);
      if (this.tab === 'history') this.renderPanel();
    });
  }

  // --- Searching ---
  // `alternatives` are the recognizer's other guesses for a recitation. Only voice input
  // has them; typed and history searches pass none, so an old recitation can't leak in.
  // Resolves to true once this search's results (or "No verse matched") are on screen.
  async search(rawQuery, { source = 'typed', alternatives = [] } = {}) {
    const query = (rawQuery || '').trim();
    if (!query || this.destroyed) return false;
    const token = ++this.matchToken;
    const superseded = () => this.destroyed || token !== this.matchToken;
    if (source !== 'voice') this.allTranscripts = [];

    this.tab = 'find';
    this.mode = 'result';
    this.query = query;
    this.querySource = source;
    this.results = [];
    this.heroId = null;
    this.searching = true;
    this.searchFailed = false;
    this.fullVerse = false;
    this.showTranslation = false;
    this.updateTabs();
    this.renderPanel();
    this.scrollToTop();

    try {
      let searched = query;
      let matches = await findClosestVerse(query, db);
      // Nothing for the first guess: try the recognizer's other guesses
      if (matches.length === 0 && alternatives.length > 1) {
        for (const alt of alternatives.slice(1)) {
          if (superseded()) return false;
          const text = (alt || '').trim();
          if (!text || text === query) continue;
          const altMatches = await findClosestVerse(text, db);
          if (altMatches.length > 0) {
            matches = altMatches;
            searched = text;
            break;
          }
        }
      }
      if (superseded()) return false; // a newer search, or another page, owns the screen
      const groups = await this.groupRepeats(matches);
      if (superseded()) return false;

      this.query = searched;
      this.rawMatchCount = matches.length;
      this.results = groups.map(g => ({ ...g, kind: matchKind(searched, g.ayah, g.score) }));
      this.heroId = this.results[0]?.ayah.id ?? null;
      this.searching = false;
      // Recorded even without a match, so the attempt can be retried from History
      this.saveToHistory(searched, this.results[0]?.ayah || null);

      if (this.tab !== 'find') return true; // shown when the user comes back to Find
      this.renderPanel();
      this.scrollToTop();
      this.focusHero();
      const best = this.results[0]?.ayah;
      if (best) {
        const page = pageOfAyah(best.surah, best.ayah);
        this.announce(`Best match: ${surahNames(best.surah, best).en} ${best.surah}:${best.ayah}${page ? `, page ${page}` : ''}.`);
      } else {
        this.announce('No verse matched.');
      }
      return true;
    } catch (e) {
      if (superseded()) return false;
      console.error(e);
      this.searching = false;
      this.searchFailed = true;
      this.renderFind();
      return false;
    }
  }

  // One entry per verse text: a refrain like Ar-Rahman's would otherwise fill every slot.
  // The matcher stops at 8 verses, so repeats are counted over the whole Quran.
  async groupRepeats(matches) {
    const groups = [];
    const byText = new Map();
    for (const match of matches) {
      const key = repeatKey(match.ayah.text);
      const group = byText.get(key);
      if (group) {
        group.matched++;
        continue;
      }
      const entry = { ayah: match.ayah, score: match.score, matched: 1, repeats: 1, repeatSurahs: 1 };
      byText.set(key, entry);
      groups.push(entry);
    }
    const repeated = groups.filter(g => g.matched > 1);
    if (!repeated.length) return groups;

    const occurrences = new Map(repeated.map(g => [repeatKey(g.ayah.text), []]));
    await this.scanVerses(ayah => occurrences.get(repeatKey(ayah.text))?.push(ayah));
    repeated.forEach(group => {
      const all = (occurrences.get(repeatKey(group.ayah.text)) || []).sort((a, b) => a.globalId - b.globalId);
      if (!all.length) return;
      group.ayah = all[0]; // "Showing the first"
      group.repeats = all.length;
      group.repeatSurahs = new Set(all.map(a => a.surah)).size;
    });
    return groups;
  }

  async scanVerses(visit) {
    await db.initPromise;
    return new Promise((resolve) => {
      const request = db.db.transaction(['text'], 'readonly').objectStore('text').openCursor();
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) {
          resolve();
          return;
        }
        visit(cursor.value);
        cursor.continue();
      };
      request.onerror = () => resolve();
    });
  }
}
