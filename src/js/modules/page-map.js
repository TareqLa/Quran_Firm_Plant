// Quran Firm Plant - Visual Mushaf Page Map Module
// Renders page grids, silhouettes, and cross-line transitions to build visual memory.

import { db } from '../data/db.js';
import { quranLoader } from '../data/loader.js';
import { AyahPlayer, firstHearings, lastWordStart } from '../components/ayah-player.js';
import {
  loadReciters, reciterInfo, reciterLabel, peekChapter, hasNoTimings, naturalEnds, adjacentPart, wordOrd,
} from '../data/recitations.js';
import { SURAH_LIST } from '../components/surah-selector.js';

const STORAGE_KEY_LAST_PAGE = 'pagemap-last-page';
const STORAGE_KEY_HISTORY = 'pagemap-page-history';
const MAX_HISTORY_ITEMS = 30;
// Listened reps (auto-counted by the player), next to the manual 'repetition-history'
const LISTEN_HISTORY_KEY = 'listening-history';
// The last part looped in each ayah: { '4:6': { from, to, at } }, by its first ayah
const PARTS_KEY = 'pagemap-parts';
const MAX_SAVED_PARTS = 300;
const NOTE_MS = 4500; // how long a note stays in the bar's word slot

// m:ss for the player's clock (ms in)
function formatClock(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const repeatLabel = (n) => (n === Infinity ? '∞' : `×${n}`);

const surahOf = (key) => Number(String(key).split(':')[0]);
const ordOf = (w) => wordOrd(w.key, w.pos);
const sameWord = (a, b) => !!a && !!b && a.key === b.key && a.pos === b.pos;

// "4:6 words 14–19", "4:6 word 14", "4:5:12 to 4:6:3"
function partLabel({ from, to }) {
  if (from.key !== to.key) return `${from.key}:${from.pos} to ${to.key}:${to.pos}`;
  return from.pos === to.pos ? `${from.key} word ${from.pos}` : `${from.key} words ${from.pos}–${to.pos}`;
}

// A word's text for the player bar. A V1 page cached before it carried
// readable text (and not yet fetched again, e.g. offline) holds QCF glyph
// codes, which other fonts show as one presentation-form letter: show
// nothing rather than that.
const readableWord = (text) => (/^[\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}\s]*$/u.test(text || '') ? '' : text);

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

// Player bar icons (24×24, stroke = currentColor)
const svg = (body, { fill = 'none', size = 22 } = {}) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  prev: svg('<path d="M6 5v14"/><path d="M19 6.2v11.6a.8.8 0 0 1-1.2.7L9.6 12.7a.8.8 0 0 1 0-1.4l8.2-5.8a.8.8 0 0 1 1.2.7z" fill="currentColor"/>'),
  next: svg('<path d="M18 5v14"/><path d="M5 6.2v11.6a.8.8 0 0 0 1.2.7l8.2-5.8a.8.8 0 0 0 0-1.4L6.2 5.5A.8.8 0 0 0 5 6.2z" fill="currentColor"/>'),
  back: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>'),
  fwd: svg('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>'),
  play: '<svg class="pm-icon-play" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.2-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z"/></svg>',
  pause: '<svg class="pm-icon-pause" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>',
  spinner: '<svg class="pm-icon-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>', { size: 16 }),
  echo: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/>', { size: 16 }),
  reciter: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>', { size: 15 }),
  listened: svg('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"/><path d="M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/>', { size: 15 }),
  chevron: svg('<path d="m6 9 6 6 6-6"/>', { size: 14 }),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>', { size: 18 }),
  part: svg('<path d="M8 4H5v16h3"/><path d="M16 4h3v16h-3"/><path d="M9.5 12h5"/>', { size: 16 }),
  join: svg('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>', { size: 16 }),
  hide: svg('<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-6.5 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M2 2l20 20"/>', { size: 16 }),
  show: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', { size: 16 }),
  check: svg('<path d="M20 6 9 17l-5-5"/>', { size: 16 }),
  view: svg('<line x1="21" y1="6" x2="14" y2="6"/><line x1="10" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="18" x2="16" y2="18"/><line x1="12" y1="18" x2="3" y2="18"/><line x1="14" y1="4" x2="14" y2="8"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="16" x2="16" y2="20"/>', { size: 16 }),
};

// Mistake types a word can be marked with. Warm hues = recitation recall
// errors, cool hues = knowledge errors. Border style doubles as a
// colorblind-safe encoding.
export const MISTAKE_TYPES = [
  { type: 'word', label: 'Wrong Word', cssVar: '--mistake-word' },
  { type: 'forgotten', label: 'Forgotten Word', cssVar: '--mistake-forgotten' },
  { type: 'haraka', label: 'Wrong Haraka', cssVar: '--mistake-haraka' },
  { type: 'pronunciation', label: 'Wrong Pronunciation', cssVar: '--mistake-pronunciation' },
  { type: 'meaning', label: 'Wrong / Forgotten Meaning', cssVar: '--mistake-meaning' },
];

export class PageMapModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);
    
    // Restore last opened page, fallback to 591 (Al-A'la)
    const savedPage = parseInt(localStorage.getItem(STORAGE_KEY_LAST_PAGE));
    this.currentPage = (savedPage >= 1 && savedPage <= 604) ? savedPage : 591;
    
    this.pageData = null;
    this.wordTranslations = {}; // "surah:ayah:position" -> English gloss, for hover/tap tooltip
    this.tajweed = {};          // "surah:ayah:position" -> tajweed-coloured markup

    // Selected mushaf edition (v1 or v2)
    this.currentEdition = localStorage.getItem('mushaf-edition') || 'v2';

    // Tajweed colouring. Independent of the edition: the markup is keyed by
    // verse/position, so it overlays either mushaf. Turning it on swaps the
    // per-page glyph fonts for Uthmani text that can be coloured per letter.
    this.tajweedMode = localStorage.getItem('pagemap-tajweed-mode') === '1';
    
    // Page history state
    this.showHistory = false;

    // Marked mistake words: wordKey -> mistake type ('forgotten' | 'word' | 'haraka' | 'meaning')
    this.markedWords = new Map();

    // Silhouette study state (merged from Blank Page module)
    this.studyMode = localStorage.getItem('pagemap-study-mode') || 'free'; // 'free' | 'sequential' | 'first-word'
    this.sliderMode = localStorage.getItem('pagemap-slider-mode') === '1'; // per-line reading reveal sliders
    this.showGlosses = localStorage.getItem('pagemap-show-glosses') === '1'; // show English gloss under revealed words
    this.revealedWords = new Set();   // persisted revealed word keys for the current page
    this.wordSequence = [];           // word keys in reading order (for sequential mode & progress)
    this.firstWordAnchors = new Set(); // first word key of each ayah on the page

    // Repetition counter (right-side panel). Targets: a single verse, a verse
    // group (range), or the whole page. The live count is what the user is
    // tallying right now (+/- buttons); pressing Save commits it into a dated
    // history entry, and the history sums those reps across days.
    //   repHistory:  { targetKey: { mode, label, sessions: { 'YYYY-MM-DD': n } } }  (IndexedDB)
    //   liveCounts:  { targetKey: n }  uncommitted tallies (localStorage)
    // Target keys: `page-591`, `verse-87:5`, `group-87:2~87:5`.
    this.repHistory = {};
    this.liveCounts = {};
    this.counterMode = localStorage.getItem('repetition-mode') || 'page'; // 'verse' | 'group' | 'page'
    this.counterVerse = null;      // selected verse key (verse mode)
    this.counterGroupFrom = null;  // selected start verse key (group mode)
    this.counterGroupTo = null;    // selected end verse key (group mode)
    // Phones show the counter below the page, collapsed unless the user opened it
    this.counterOpen = localStorage.getItem('pagemap-counter-open') === '1';

    // Listened reps, counted by the player: { 'verse-87:5': { mode, label, sessions: { 'YYYY-MM-DD': n } } }
    this.listenHistory = {};

    // Recitation player. It holds what is loaded and where; the page (ayah wash,
    // word follow) and the player bar only mirror it, so a re-render never loses it.
    this.player = new AyahPlayer({
      describe: (key, part) => (part ? `${this.describeAyah(part.from.key).replace(/ \S+$/, '')} ${partLabel(part)}` : this.describeAyah(key)),
    });
    this.scrubbing = false; // the player's position bar is being dragged
    this.ticksFor = null;   // the track the bar's word ticks were drawn for
    this.offPlayer = [
      this.player.on('state', (s) => this.syncPlayback(s)),
      this.player.on('select', (s) => this.syncPlayback(s)),
      this.player.on('word', (s) => this.syncFollow(s)),
      this.player.on('time', (s) => this.syncPlayerTime(s)),
      this.player.on('pass', (s) => this.addListened(s.lastPass?.key)),
      // A part's passes ('partpass') are practice only: not logged
    ];

    // Part loops: Part in the player, then a tap on a part's first and last
    // word. Next / Previous part step to the words after or before it; the
    // parts reached that way form a trail, and Join plays the trail from its
    // first part to the current one as one stretch. The player holds what
    // plays (player.part); this is how the page got there.
    //   partPick: choosing the ends, { first: { key, pos } | null }, or null
    //   part:     { trail: [{ from, to }], ti, joined }, or null
    this.partPick = null;
    this.part = null;
    this.partHover = null;  // the word under the mouse while choosing (a preview)
    this.partNote = null;   // { text, until }: a short note in the bar's word slot
    this.partResumeTried = false; // Part was pressed on this page (only the first press resumes)
    this.pageWords = [];    // the page's words in reading order: [{ key, pos, text }]
    this.wordAt = new Map(); // 'key:pos' -> index in pageWords
    this.verseTexts = null; // V2 pages: each ayah's Uthmani text (its waqf signs), once Part is used
    this.endsCache = new Map();
    this.savedParts = this.readSavedParts();
    this.player.partNav = (dir) => this.stepPart(dir);
    // The part's stroke follows its words when they change size (fonts load)
    this.partRO = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.placePartStrokes()) : null;

    // Sheets (View options, reciter picker) stay open across re-renders
    this.viewOpen = false;
    this.reciterOpen = false;
    this.reciters = null;
    loadReciters().then((list) => {
      this.reciters = list;
      this.refreshReciterSheet();
      this.syncPlayback();
    });

    // Keyboard and outside taps (sheets)
    this.onKeyDown = (e) => this.handleKey(e);
    this.onDocPointerDown = (e) => this.handleOutsidePointer(e);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    // The bar's word keeps fitting its slot when the screen turns
    this.onWindowResize = () => {
      this.fitBarWord();
      this.placePartStrokes();
    };
    window.addEventListener('resize', this.onWindowResize);
    this.onFontsLoaded = () => this.placePartStrokes();
    document.fonts?.addEventListener?.('loadingdone', this.onFontsLoaded);
  }

  // Called by the app when it leaves the Page Map
  destroy() {
    this.offPlayer.forEach((off) => off());
    this.player.destroy();
    this.closeContextMenu();
    this.hideWordTooltip();
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('resize', this.onWindowResize);
    document.fonts?.removeEventListener?.('loadingdone', this.onFontsLoaded);
    this.partRO?.disconnect();
    clearTimeout(this.noteTimer);
    if (this._sliderResizeHandler) {
      window.removeEventListener('resize', this._sliderResizeHandler);
      this._sliderResizeHandler = null;
    }
  }

  // "At-Tariq 86:5"
  describeAyah(key) {
    const surahNum = Number(String(key).split(':')[0]);
    const name = SURAH_LIST.find((x) => x.id === surahNum)?.nameEn || 'Surah';
    return `${name} ${key}`;
  }

  // --- Page History Helpers ---
  _getHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  _pushHistory(pageNumber) {
    let history = this._getHistory();
    // Remove duplicates of the same page so it moves to the top
    history = history.filter(entry => entry.page !== pageNumber);
    // Add to the front with timestamp
    history.unshift({ page: pageNumber, timestamp: Date.now() });
    // Cap the length
    if (history.length > MAX_HISTORY_ITEMS) {
      history = history.slice(0, MAX_HISTORY_ITEMS);
    }
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
  }

  _clearHistory() {
    localStorage.removeItem(STORAGE_KEY_HISTORY);
  }

  _formatTimestamp(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);
    
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString();
  }

  async loadPage(pageNumber) {
    this.closeContextMenu();
    this.hideWordTooltip();
    // The player only ever plays an ayah of the page on screen. Reloading the
    // same page (e.g. another mushaf edition) keeps it playing.
    if (pageNumber !== this.currentPage) {
      this.player.stop();
      this.part = null;
      this.partPick = null;
      this.partHover = null;
      this.partResumeTried = false;
    }
    this.currentPage = pageNumber;
    
    // Persist the last opened page and push to history
    localStorage.setItem(STORAGE_KEY_LAST_PAGE, pageNumber);
    this._pushHistory(pageNumber);
    
    this.container.innerHTML = `
      <div style="display: flex; justify-content: center; align-items: center; height: 200px;">
        <div class="status-indicator">
          <span class="status-dot animate-pulse" style="background-color: var(--accent-gold);"></span>
          <span>Loading page layout for Page ${pageNumber}...</span>
        </div>
      </div>
    `;

    try {
      // Saved as [wordKey, type] pairs; older saves were plain wordKey strings
      // from when "forgotten" was the only mark type.
      const savedMarked = await db.getProgress(`pagemap-marked-${pageNumber}`);
      this.markedWords = new Map((savedMarked || []).map(entry =>
        typeof entry === 'string' ? [entry, 'forgotten'] : entry
      ));

      const savedRevealed = await db.getProgress(`pagemap-revealed-${pageNumber}`);
      this.revealedWords = new Set(savedRevealed || []);

      await this.loadRepetitionData();

      const [pageData, wordTranslations, tajweed] = await Promise.all([
        quranLoader.loadPage(pageNumber, this.currentEdition),
        quranLoader.loadWordTranslations(pageNumber),
        this.tajweedMode ? quranLoader.loadTajweed(pageNumber) : Promise.resolve({})
      ]);
      this.pageData = pageData;
      this.wordTranslations = wordTranslations || {};
      this.tajweed = tajweed || {};
      if (!this.pageData) {
        throw new Error('Failed to load layout from CDN or cache');
      }

      this.processPageWords();
      // Waqf signs for Next part (see ensureVerseTexts)
      this.verseTexts = null;
      this.endsCache.clear();
      if (this.part) this.ensureVerseTexts();
      // The player steps through this page's ayahs, and loads their surahs'
      // word timings now so the first tap plays at once
      const verseKeys = this.getOrderedVerseKeys();
      this.player.setOrder(verseKeys);
      this.player.prefetch([...new Set(verseKeys.map((k) => Number(k.split(':')[0])))]);
      this.render();
      this.setupEvents();
    } catch (e) {
      console.error(e);
      this.container.innerHTML = `
        <div class="card" style="text-align: center; padding: 40px;">
          <h3 style="color: var(--color-error); margin-bottom: 12px;">Failed to Load Layout</h3>
          <p style="margin-bottom: 20px;">Could not retrieve coordinates mapping for Page ${pageNumber}.</p>
          <button id="retry-page-btn" class="btn-gold">Retry Download</button>
        </div>
      `;
      document.getElementById('retry-page-btn')?.addEventListener('click', () => {
        this.loadPage(pageNumber);
      });
    }
  }

  render() {
    const history = this._getHistory();
    const hasHistory = history.length > 0;
    // A re-render replaces every control: give focus back to the one that had it
    const focusedId = this.container.contains(document.activeElement) ? document.activeElement.id : null;

    const modes = [
      ['free', 'Free reveal', 'Free'],
      ['sequential', 'Next word guide', 'Guide'],
      ['first-word', 'First word anchors', 'Anchors'],
    ];

    this.container.innerHTML = `
      <!-- One toolbar row: reveal mode, then Write Page, History and the View sheet -->
      <div class="pm-toolbar">
        <div class="seg-control pm-reveal-modes" role="group" aria-label="Reveal mode">
          ${modes.map(([mode, long, short]) => `
            <button type="button" class="seg-btn study-mode-btn ${this.studyMode === mode ? 'active' : ''}" data-study-mode="${mode}" aria-pressed="${this.studyMode === mode}" aria-label="${long}" title="${long}">
              <span class="pm-lbl-long">${long}</span><span class="pm-lbl-short">${short}</span>
            </button>`).join('')}
        </div>

        <div class="pm-toolbar-actions">
          <button type="button" id="pagemap-write-btn" class="btn-gold pm-tool-btn" aria-label="Write Page ${this.currentPage}" title="Write Page ${this.currentPage}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            <span class="pm-lbl-long">Write Page ${this.currentPage}</span><span class="pm-lbl-short">Write</span>
          </button>

          <!-- Page History Toggle (icon-only; label lives in the tooltip) -->
          <div class="pagemap-history-wrapper">
            <button type="button" id="pagemap-history-btn" class="btn-outline pm-tool-btn pm-icon-btn ${this.showHistory ? 'active' : ''}" title="Page history" aria-label="Page history" aria-expanded="${this.showHistory}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              ${hasHistory ? `<span class="history-badge">${history.length}</span>` : ''}
            </button>

            ${this.showHistory ? `
              <div class="pagemap-history-panel">
                <div class="pagemap-history-header">
                  <span class="pagemap-history-title">Recently Opened Pages</span>
                  ${hasHistory ? `<button id="pagemap-clear-history" class="pagemap-history-clear" title="Clear history">Clear All</button>` : ''}
                </div>
                <div class="pagemap-history-list">
                  ${hasHistory ? history.map((entry) => {
                    const isCurrent = entry.page === this.currentPage;
                    return `
                      <button class="pagemap-history-item ${isCurrent ? 'current' : ''}" data-page="${entry.page}" ${isCurrent ? 'disabled' : ''}>
                        <span class="pagemap-history-item-page">Page ${entry.page}</span>
                        <span class="pagemap-history-item-time">${this._formatTimestamp(entry.timestamp)}</span>
                      </button>
                    `;
                  }).join('') : `
                    <div class="pagemap-history-empty">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                      </svg>
                      <span>No pages visited yet</span>
                    </div>
                  `}
                </div>
              </div>
            ` : ''}
          </div>

          <!-- View: sliders, translations, tajweed and the mushaf edition -->
          <div class="pm-view-wrapper">
            <button type="button" id="pagemap-view-btn" class="btn-outline pm-tool-btn ${this.viewOpen ? 'active' : ''}" aria-haspopup="dialog" aria-expanded="${this.viewOpen}" aria-controls="pm-view-sheet" aria-label="View options" title="View: sliders, translations, tajweed, edition">
              ${ICONS.view}<span class="pm-lbl-long">View</span>
            </button>
            ${this.renderViewSheet()}
          </div>
        </div>
      </div>

      <!-- The page (left), the player and the repetition counter (right; on phones the
           player docks at the bottom and the counter sits below the page) -->
      <div class="pagemap-layout has-player">
        <div id="pagemap-content-area" class="pm-main">
          ${this.renderSilhouette()}
        </div>
        <div class="pm-side">
          ${this.renderPlayerBar()}
          <aside id="pagemap-counter-panel" class="rep-panel ${this.counterOpen ? 'open' : ''}">
            ${this.renderCounterPanelInner()}
          </aside>
        </div>
      </div>
    `;

    // The page was rebuilt: put back the player's state (ayah wash, word
    // follow, the bar)
    this.ticksFor = null;
    this.syncPlayback();
    // The part's stroke is drawn on the new page (tajweed and edition too)
    this.drawPart();
    document.fonts?.ready?.then(() => this.placePartStrokes());
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }

  // --- View sheet (sliders, translations, tajweed, edition) ---

  renderViewSheet() {
    const toggle = (id, on, title, desc) => `
      <button type="button" id="${id}" class="pm-switch toggle-btn ${on ? 'active' : ''}" aria-pressed="${on}">
        <span class="pm-switch-text"><span class="pm-switch-title">${title}</span><span class="pm-switch-desc">${desc}</span></span>
        <span class="pm-switch-knob" aria-hidden="true"></span>
      </button>`;
    return `
      <div class="pm-sheet pm-view-sheet" id="pm-view-sheet" role="dialog" aria-label="View options" ${this.viewOpen ? '' : 'hidden'}>
        <div class="pm-sheet-head">
          <span class="pm-sheet-title">View</span>
          <button type="button" class="pm-sheet-close" data-sheet-close="view" aria-label="Close">${ICONS.close}</button>
        </div>
        <div class="pm-sheet-body">
          ${toggle('sil-slider-toggle-btn', this.sliderMode, 'Reading sliders', 'A slider on each line sweeps the words visible as you read')}
          ${toggle('sil-gloss-toggle-btn', this.showGlosses, 'Translations', 'Briefly show the English meaning when a word is revealed')}
          ${toggle('sil-tajweed-toggle-btn', this.tajweedMode, 'Tajweed colours', 'Colour the letters by tajweed rule (either edition)')}
          <label class="pm-field" for="mushaf-edition-select">
            <span class="pm-switch-title">Mushaf edition</span>
            <select id="mushaf-edition-select" class="selector-input pm-select">
              <option value="v2" ${this.currentEdition === 'v2' ? 'selected' : ''}>Madinah V2 (Standard)</option>
              <option value="v1" ${this.currentEdition === 'v1' ? 'selected' : ''}>Madinah V1 (Classic 1405 AH)</option>
            </select>
          </label>
          <p class="pm-sheet-tip">Tap a block to reveal the word, or an ayah number to play its recitation. Long-press (or right-click) a word to mark it, or an ayah number to hide or show the ayah. Keys: Space plays or pauses, ← → step by word, Shift with an arrow steps by ayah, R changes Repeat.</p>
        </div>
      </div>
      <div class="pm-sheet-backdrop" data-sheet-close="view" ${this.viewOpen ? '' : 'hidden'}></div>
    `;
  }

  // Open or close a sheet (one at a time). Keeps the flag, so a re-render
  // while it's open draws it open again.
  setSheet(name, open) {
    if (name === 'view') {
      this.viewOpen = open;
      if (open) this.reciterOpen = false;
    } else {
      this.reciterOpen = open;
      if (open) this.viewOpen = false;
    }
    this.syncSheets();
    const sheet = this.container.querySelector(name === 'view' ? '#pm-view-sheet' : '#pm-reciter-sheet');
    if (open && sheet) {
      const first = sheet.querySelector(name === 'view' ? '.pm-switch' : '.pm-reciter-item.active, .pm-reciter-item');
      first?.focus({ preventScroll: true });
    }
  }

  syncSheets() {
    const c = this.container;
    const apply = (sheetSel, btnSel, kind, open) => {
      const sheet = c.querySelector(sheetSel);
      if (sheet) sheet.hidden = !open;
      c.querySelectorAll(`.pm-sheet-backdrop[data-sheet-close="${kind}"]`).forEach((b) => { b.hidden = !open; });
      const btn = c.querySelector(btnSel);
      if (btn) {
        btn.setAttribute('aria-expanded', String(open));
        btn.classList.toggle('active', open);
      }
    };
    apply('#pm-view-sheet', '#pagemap-view-btn', 'view', this.viewOpen);
    apply('#pm-reciter-sheet', '#pm-reciter', 'reciter', this.reciterOpen);
  }

  // Esc and outside taps. Returns true when something was open.
  closeSheets() {
    if (!this.viewOpen && !this.reciterOpen) return false;
    const returnTo = this.viewOpen ? '#pagemap-view-btn' : '#pm-reciter';
    const inside = this.container.querySelector(this.viewOpen ? '#pm-view-sheet' : '#pm-reciter-sheet')?.contains(document.activeElement);
    this.viewOpen = false;
    this.reciterOpen = false;
    this.syncSheets();
    if (inside) this.container.querySelector(returnTo)?.focus({ preventScroll: true });
    return true;
  }

  handleOutsidePointer(e) {
    if (!this.viewOpen && !this.reciterOpen) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    // The phone backdrop closes on its own click; closing it here would let
    // that click fall through to the page (and reveal a word)
    if (t.closest('.pm-sheet-backdrop')) return;
    if (this.viewOpen && t.closest('.pm-view-wrapper')) return;
    if (this.reciterOpen && (t.closest('#pm-reciter-sheet') || t.closest('#pm-reciter'))) return;
    this.closeSheets();
  }

  // --- Player bar ---

  renderPlayerBar() {
    return `
      <div class="pm-player" id="pm-player" role="region" aria-label="Recitation player">
        <div class="pm-now">
          <div class="pm-info">
            <span class="pm-title" id="pm-title"></span>
            <span class="pm-status" id="pm-status"></span>
          </div>
          <span class="pm-word" id="pm-word" lang="ar" dir="rtl"></span>
          <button type="button" class="pm-chip pm-listened" id="pm-listened" data-pm-act="listened" hidden>
            ${ICONS.listened}<span class="pm-listened-n" id="pm-listened-n">0</span><span class="pm-listened-lbl">today</span>
          </button>
          <button type="button" class="pm-btn pm-part-x" id="pm-part-x" data-pm-act="part-exit" aria-label="Back to whole ayahs" title="Back to whole ayahs (Esc)" hidden>${ICONS.close}</button>
        </div>
        <div class="pm-track-row">
          <span class="pm-time" id="pm-elapsed">0:00</span>
          <div class="pm-track" id="pm-track" role="slider" tabindex="0" aria-label="Position in the ayah" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
            <div class="pm-rail"><div class="pm-fill" id="pm-fill"></div><div class="pm-lens" id="pm-lens"></div></div>
            <div class="pm-ticks" id="pm-ticks"></div>
            <div class="pm-thumb" id="pm-thumb"></div>
          </div>
          <span class="pm-time" id="pm-duration">0:00</span>
        </div>
        <div class="pm-error" id="pm-error" role="alert"></div>
        <div class="pm-ctl">
          <button type="button" class="pm-btn" data-pm-act="prev" aria-label="Previous ayah" title="Previous ayah (Shift+←)">${ICONS.prev}<small class="pm-part-lbl"></small></button>
          <button type="button" class="pm-btn pm-step" data-pm-act="back" aria-label="Back one word" title="Back one word (←)">${ICONS.back}<small>word</small></button>
          <button type="button" class="pm-btn pm-btn-main" data-pm-act="toggle" aria-label="Play" title="Play (Space)">${ICONS.play}${ICONS.pause}${ICONS.spinner}</button>
          <button type="button" class="pm-btn pm-step" data-pm-act="fwd" aria-label="Forward one word" title="Forward one word (→)">${ICONS.fwd}<small>word</small></button>
          <button type="button" class="pm-btn" data-pm-act="next" aria-label="Next ayah" title="Next ayah (Shift+→)">${ICONS.next}<small class="pm-part-lbl"></small></button>
        </div>
        <div class="pm-opts">
          <button type="button" class="pm-chip" data-pm-act="repeat" id="pm-repeat" title="Repeat the ayah (R)">${ICONS.repeat}<span id="pm-repeat-n">×1</span></button>
          <button type="button" class="pm-chip" data-pm-act="rate" id="pm-rate" title="Speed">1×</button>
          <button type="button" class="pm-chip" data-pm-act="echo" id="pm-echo" aria-pressed="false" title="Echo: after each ayah, a pause as long as the ayah, for you to say it back">${ICONS.echo}<span>Echo</span></button>
          <button type="button" class="pm-chip pm-part-chip" data-pm-act="part" id="pm-part" aria-pressed="false">${ICONS.part}<span>Part</span></button>
          <button type="button" class="pm-chip pm-reciter" data-pm-act="reciter" id="pm-reciter" aria-haspopup="dialog" aria-expanded="${this.reciterOpen}" aria-controls="pm-reciter-sheet" title="Reciter">${ICONS.reciter}<span class="pm-reciter-name" id="pm-reciter-name"></span>${ICONS.chevron}</button>
        </div>
        <div class="pm-part-tools" id="pm-part-tools" role="group" aria-label="Part" hidden>
          <button type="button" class="pm-chip" data-pm-act="join" id="pm-join" aria-pressed="false">${ICONS.join}<span id="pm-join-lbl">Join</span></button>
          <button type="button" class="pm-chip" data-pm-act="hide-part" id="pm-hide-part" aria-pressed="false"><span class="pm-hide-icon" id="pm-hide-icon">${ICONS.hide}</span><span id="pm-hide-lbl">Hide</span></button>
        </div>
        ${this.renderReciterSheet()}
      </div>
    `;
  }

  renderReciterSheet() {
    return `
      <div class="pm-sheet pm-reciter-sheet" id="pm-reciter-sheet" role="dialog" aria-label="Reciter" ${this.reciterOpen ? '' : 'hidden'}>
        <div class="pm-sheet-head">
          <span class="pm-sheet-title">Reciter</span>
          <button type="button" class="pm-sheet-close" data-sheet-close="reciter" aria-label="Close">${ICONS.close}</button>
        </div>
        <div class="pm-sheet-body pm-reciter-list" id="pm-reciter-list">${this.renderReciterItems()}</div>
      </div>
      <div class="pm-sheet-backdrop" data-sheet-close="reciter" ${this.reciterOpen ? '' : 'hidden'}></div>
    `;
  }

  renderReciterItems() {
    const current = this.player.reciterId;
    const list = this.reciters || [reciterInfo(current)];
    const surahs = this.pageData ? this.pageSurahs() : [];
    return list.map((r) => {
      // Known to have no word timings here (none from quran.com, or the surah file failed)
      const noWords = surahs.length > 0 && surahs.every((s) =>
        peekChapter(r.id, s) === null || this.player.failedFiles.has(`${r.id}:${s}`));
      const on = r.id === current;
      return `
        <button type="button" class="pm-reciter-item ${on ? 'active' : ''}" data-reciter-id="${r.id}" aria-pressed="${on}">
          <span class="pm-reciter-item-text">
            <span class="pm-reciter-item-name">${escapeHtml(r.name)}</span>
            ${r.style ? `<span class="pm-reciter-item-style">${escapeHtml(r.style)}</span>` : ''}
            ${noWords ? '<span class="pm-reciter-item-note">No word timings here: plays ayah by ayah</span>' : ''}
          </span>
          ${on ? ICONS.check : ''}
        </button>`;
    }).join('');
  }

  refreshReciterSheet() {
    const list = this.container.querySelector('#pm-reciter-list');
    if (list) list.innerHTML = this.renderReciterItems();
  }

  pageSurahs() {
    return [...new Set(this.getOrderedVerseKeys().map((k) => Number(k.split(':')[0])))];
  }

  bindPlayerBar() {
    const bar = this.container.querySelector('#pm-player');
    if (!bar) return;

    bar.addEventListener('click', (e) => {
      const item = e.target.closest('[data-reciter-id]');
      if (item) {
        this.player.setReciter(Number(item.dataset.reciterId));
        this.setSheet('reciter', false);
        this.refreshReciterSheet();
        bar.querySelector('#pm-reciter')?.focus({ preventScroll: true });
        return;
      }
      if (e.target.closest('[data-sheet-close="reciter"]')) {
        this.setSheet('reciter', false);
        return;
      }
      const btn = e.target.closest('[data-pm-act]');
      if (!btn || btn.disabled) return;
      const p = this.player;
      switch (btn.dataset.pmAct) {
        case 'toggle': p.toggle(); break;
        case 'prev': if (this.part) this.stepPart(-1); else p.prevAyah(); break;
        case 'next': if (this.part) this.stepPart(1); else p.nextAyah(); break;
        case 'back': p.backWord(); break;
        case 'fwd': p.fwdWord(); break;
        case 'repeat': p.cycleRepeat(); break;
        case 'rate': p.cycleRate(); break;
        case 'echo': p.setEcho(!p.echo); break;
        case 'part': this.onPartChip(); break;
        case 'part-exit': this.exitPart(); break;
        case 'join': this.toggleJoin(); break;
        case 'hide-part': this.toggleHidePart(); break;
        case 'retry': p.retry(); break;
        case 'reciter':
          this.refreshReciterSheet();
          this.setSheet('reciter', !this.reciterOpen);
          break;
        case 'listened':
          if (p.key) this.openCounterFor(p.key);
          break;
        default:
      }
    });

    // Position bar: tap or drag to seek (playing or paused stays so). The
    // arrow keys step by word through handleKey(); Home / End go to the ends.
    const track = bar.querySelector('#pm-track');
    const seekAt = (clientX) => {
      const s = this.player.getState();
      if (!s.key || !s.duration) return;
      const r = track.getBoundingClientRect();
      if (!r.width) return;
      this.player.seek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * s.duration);
    };
    track.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const s = this.player.getState();
      if (!s.key || !s.duration) return;
      e.preventDefault();
      try { track.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      this.scrubbing = true;
      track.classList.add('is-dragging');
      seekAt(e.clientX);
      const move = (ev) => seekAt(ev.clientX);
      const up = () => {
        this.scrubbing = false;
        track.classList.remove('is-dragging');
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        track.removeEventListener('pointercancel', up);
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });
    track.addEventListener('keydown', (e) => {
      const s = this.player.getState();
      if (!s.key) return;
      if (e.key === 'Home') {
        e.preventDefault();
        this.player.seek(0);
      } else if (e.key === 'End' && s.words.length) {
        e.preventDefault();
        this.player.seek(lastWordStart(s.words));
      }
    });
  }

  // Mirror the player on this page. Runs on every player change and after every render().
  syncPlayback(s = this.player.getState()) {
    // The player dropped the part (this reciter has no word timings here, or
    // the surah file failed): the page goes back to whole ayahs too
    if (this.part && !s.part && s.key) {
      this.part = null;
      this.drawPart();
      this.showPartNote(this.partsUnavailableNote() || 'This part couldn’t be cut from the recitation, so the whole ayah plays.');
    }
    this.syncFollow(s);
    this.syncPlayerBar(s);
  }

  // The page follows the reciter: the loaded ayah's number shows playing or
  // paused, the ayah gets a green wash, and the word being recited is
  // underlined (or, while hidden, its block is outlined, text still hidden).
  syncFollow(s = this.player.getState()) {
    const c = this.container;
    const loaded = !!s.key && s.status !== 'idle';
    const active = s.status === 'playing' || s.status === 'loading' || s.status === 'gap';
    const washed = loaded && s.status !== 'ended' && s.status !== 'error';
    // A part has its stroke instead of the ayah's wash and number
    const inPart = !!s.part;

    c.querySelectorAll('.ayah-end-block.playing, .ayah-end-block.paused').forEach((el) => {
      el.classList.remove('playing', 'paused', 'loading');
    });
    if (loaded && !inPart) {
      const marker = c.querySelector(`.ayah-end-block[data-verse-key="${s.key}"]`);
      if (marker) {
        marker.classList.add(active ? 'playing' : 'paused');
        marker.classList.toggle('loading', s.status === 'loading');
      }
    }

    const washKey = washed && !inPart ? s.key : null;
    c.querySelectorAll('.mushaf-word-box.ayah-playing').forEach((el) => {
      if (el.dataset.verseKey !== washKey) el.classList.remove('ayah-playing');
    });
    if (washKey) {
      c.querySelectorAll(`.mushaf-word-box[data-verse-key="${washKey}"]:not(.ayah-end-block)`)
        .forEach((el) => el.classList.add('ayah-playing'));
    }

    const word = washed && s.status !== 'gap' && s.wordIndex >= 0 ? s.words[s.wordIndex] : null;
    // A part's words name their ayah (a part may run across ayahs)
    const wordEl = word
      ? c.querySelector(`.mushaf-word-box[data-verse-key="${word.key || s.key}"][data-position="${word.pos}"]:not(.ayah-end-block)`)
      : null;
    c.querySelectorAll('.mushaf-word-box.word-current').forEach((el) => {
      if (el !== wordEl) el.classList.remove('word-current');
    });
    wordEl?.classList.add('word-current');

    // The bar shows the word in Arabic (or "Your turn" during an Echo pause)
    const slot = c.querySelector('#pm-word');
    if (slot) {
      let text = '';
      let cls = '';
      const note = this.partNote && this.partNote.until > Date.now() ? this.partNote.text : '';
      const picked = this.partPick?.first ? this.wordBox(this.partPick.first) : null;
      if (note) {
        text = note;
        cls = 'is-note';
      } else if (this.partPick) {
        // Choosing: the first word picked, so a wrong tap is easy to spot
        text = picked ? readableWord(picked.dataset.text) : '';
      } else if (s.status === 'gap') {
        text = 'Your turn: say it back';
        cls = 'is-turn';
      } else if (loaded && s.mode === 'ayah') {
        text = 'No word timings for this reciter';
        cls = 'is-note';
      } else if (wordEl) {
        text = readableWord(wordEl.dataset.text);
      }
      const className = `pm-word ${cls}`;
      const changed = slot.textContent !== text || slot.className !== className;
      if (slot.textContent !== text) slot.textContent = text;
      slot.className = className;
      slot.setAttribute('lang', cls ? 'en' : 'ar');
      slot.setAttribute('dir', cls ? 'ltr' : 'rtl');
      if (changed) this.fitBarWord();
    }
  }

  // The word in the bar is shown whole. Its slot gets the room the title and
  // the Listened chip leave; a long word next to a long surah name on a narrow
  // phone gets a smaller font (down to 70%) rather than being cut off.
  fitBarWord() {
    const slot = this.container.querySelector('#pm-word');
    if (!slot) return;
    slot.style.fontSize = '';
    if (!slot.textContent || slot.classList.contains('is-turn') || slot.classList.contains('is-note')) return;
    const room = slot.clientWidth;
    const need = slot.scrollWidth;
    if (!room || need <= room) return;
    const base = parseFloat(getComputedStyle(slot).fontSize);
    slot.style.fontSize = `${Math.max(base * 0.7, Math.floor((base * room * 10) / need) / 10)}px`;
  }

  playerStatusText(s) {
    if (!s.key || s.status === 'idle') return `Recited by ${reciterInfo(s.reciterId).short}`;
    // A part: which one leads ("Part 2 · Playing · 1 of 3")
    const lead = s.part && this.part ? `${this.partName()} · ` : '';
    return lead + this.statusWord(s);
  }

  statusWord(s) {
    const of = s.repeat === Infinity ? '∞' : s.repeat;
    const loop = s.repeat !== 1 ? ` · ${s.repeat === Infinity ? s.loop + 1 : Math.min(s.loop + 1, s.repeat)} of ${of}` : '';
    switch (s.status) {
      case 'loading': return 'Loading…';
      case 'playing': return `Playing${loop}`;
      case 'paused': return `Paused${loop}`;
      case 'gap': return `Your turn · ${Math.ceil(s.gapLeft / 1000)} s`;
      case 'ended': return s.repeat !== 1 ? `Done · ${repeatLabel(s.repeat)}` : 'Done';
      case 'error': return 'Couldn’t play';
      default: return '';
    }
  }

  syncPlayerBar(s = this.player.getState()) {
    const bar = this.container.querySelector('#pm-player');
    if (!bar) return;
    const $ = (sel) => bar.querySelector(sel);
    const loaded = !!s.key && s.status !== 'idle';
    const active = s.status === 'playing' || s.status === 'loading' || s.status === 'gap';
    const inPart = !!(this.part && s.part);
    const choosing = !!this.partPick;
    bar.classList.toggle('is-idle', !loaded && !choosing);
    bar.classList.toggle('is-active', active);
    bar.classList.toggle('is-loading', s.status === 'loading');
    bar.classList.toggle('is-gap', s.status === 'gap');
    bar.classList.toggle('has-error', s.status === 'error');
    bar.classList.toggle('no-words', loaded && s.mode === 'ayah');
    bar.classList.toggle('is-part', inPart);
    bar.classList.toggle('is-choosing', choosing);
    if (choosing) {
      $('#pm-title').textContent = 'Choose a part';
      $('#pm-status').textContent = this.partPick.first ? 'Now tap its last word' : 'Tap its first word';
    } else if (inPart) {
      $('#pm-title').textContent = partLabel(s.part);
      $('#pm-status').textContent = this.playerStatusText(s);
    } else {
      $('#pm-title').textContent = loaded ? this.describeAyah(s.key) : 'Tap an ayah number to listen';
      $('#pm-status').textContent = this.playerStatusText(s);
    }
    $('#pm-part-x').hidden = !inPart && !choosing;
    $('#pm-part-x').setAttribute('aria-label', choosing ? 'Stop choosing a part' : 'Back to whole ayahs');
    $('#pm-part-x').title = choosing ? 'Stop choosing (Esc)' : 'Back to whole ayahs (Esc)';

    // Listened today, for the loaded ayah (opens the Repetition Counter).
    // Parts aren't counted, so it steps aside for the part's ✕.
    const chip = $('#pm-listened');
    if (loaded && !inPart && !choosing) {
      const n = this.listenedToday(s.key);
      chip.hidden = false;
      $('#pm-listened-n').textContent = String(n);
      const label = `Listened to ${s.key} ${n} ${n === 1 ? 'time' : 'times'} today. Open the Repetition Counter.`;
      chip.setAttribute('aria-label', label);
      chip.title = label;
    } else {
      chip.hidden = true;
    }
    // The title, status and chip set the word's room
    this.fitBarWord();

    const btn = (act) => bar.querySelector(`[data-pm-act="${act}"]`);
    // The outer buttons step by part while a part is loaded
    if (inPart) {
      btn('prev').disabled = !this.canStepPart(-1);
      btn('next').disabled = !this.canStepPart(1);
    } else {
      btn('prev').disabled = !loaded;
      btn('next').disabled = !loaded || !s.hasNext;
    }
    [['prev', 'Previous', 'Shift+←'], ['next', 'Next', 'Shift+→']].forEach(([act, lbl, keys]) => {
      const b = btn(act);
      const what = inPart ? 'part' : 'ayah';
      b.setAttribute('aria-label', `${lbl} ${what}`);
      b.title = `${lbl} ${what} (${keys})`;
      b.classList.toggle('pm-step', inPart);
      b.querySelector('.pm-part-lbl').textContent = inPart ? 'part' : '';
    });
    btn('back').disabled = !loaded || !s.mode;
    btn('fwd').disabled = !loaded || !s.mode || s.status === 'ended';
    // Without word timings the word steps move two seconds instead
    const byTime = s.mode === 'ayah';
    bar.querySelectorAll('[data-pm-act="back"] small, [data-pm-act="fwd"] small').forEach((el) => { el.textContent = byTime ? '2 s' : 'word'; });
    btn('back').setAttribute('aria-label', byTime ? 'Back 2 seconds' : 'Back one word');
    btn('fwd').setAttribute('aria-label', byTime ? 'Forward 2 seconds' : 'Forward one word');

    const main = btn('toggle');
    const label = active ? 'Pause'
      : s.status === 'ended' ? 'Play again'
      : s.status === 'error' ? 'Try again'
      : loaded && s.position > 0 ? 'Continue' : 'Play';
    main.setAttribute('aria-label', label);
    main.title = `${label} (Space)`;

    $('#pm-repeat-n').textContent = repeatLabel(s.repeat);
    const rep = $('#pm-repeat');
    rep.classList.toggle('on', s.repeat !== 1);
    const what = s.part ? 'the part' : 'the ayah';
    rep.setAttribute('aria-label', `Repeat ${what}: ${s.repeat === 1 ? 'once' : s.repeat === Infinity ? 'until paused' : `${s.repeat} times`}`);
    rep.title = `Repeat ${what} (R)`;
    const rate = $('#pm-rate');
    rate.textContent = `${s.rate}×`;
    rate.classList.toggle('on', s.rate !== 1);
    rate.setAttribute('aria-label', `Speed ${s.rate}×`);
    const echo = $('#pm-echo');
    echo.classList.toggle('on', s.echo);
    echo.setAttribute('aria-pressed', String(s.echo));
    echo.title = s.part
      ? 'Echo: after each pass, a pause as long as the part, for you to say it back'
      : 'Echo: after each ayah, a pause as long as the ayah, for you to say it back';
    this.syncPartControls(bar, s);
    const r = reciterInfo(s.reciterId);
    $('#pm-reciter-name').textContent = r.short;
    $('#pm-reciter').setAttribute('aria-label', `Reciter: ${reciterLabel(r)}`);

    // Inline error with Retry, written once per failure so it's announced once
    const err = $('#pm-error');
    if (s.status === 'error') {
      if (!err.firstChild) {
        err.innerHTML = `
          <span>Couldn’t load this recitation. Check your internet connection.</span>
          <button type="button" class="pm-player-retry" data-pm-act="retry">Retry</button>
        `;
      }
    } else if (err.firstChild) {
      err.textContent = '';
    }

    // A tick for each word on the position bar, once per word: where it's
    // first heard (a reciter's repeats don't add ticks)
    const ticksKey = loaded && s.duration ? `${s.key}|${s.reciterId}|${s.mode}|${Math.round(s.duration)}|${s.part ? partLabel(s.part) : ''}` : null;
    if (ticksKey !== this.ticksFor) {
      this.ticksFor = ticksKey;
      const starts = ticksKey ? firstHearings(s.words).slice(1) : [];
      $('#pm-ticks').innerHTML = starts
        .map((w) => `<i style="left:${((w.st / s.duration) * 100).toFixed(2)}%"></i>`).join('');
    }

    // Phones: the bar is docked, so the page reserves its height at the end
    this.container.querySelector('.pagemap-layout')?.style.setProperty('--pm-player-h', `${bar.offsetHeight}px`);
    this.syncPlayerTime(s);
  }

  // Position bar, clock and the Echo countdown; runs on every frame while playing
  syncPlayerTime(s = this.player.getState()) {
    const bar = this.container.querySelector('#pm-player');
    if (!bar) return;
    const dur = s.duration;
    const loaded = !!s.key && s.status !== 'idle';
    const pos = loaded ? Math.min(s.position, dur || s.position) : 0;
    const f = dur ? Math.min(1, Math.max(0, pos / dur)) : 0;
    const pct = `${(f * 100).toFixed(2)}%`;
    bar.querySelector('#pm-fill').style.width = pct;
    bar.querySelector('#pm-thumb').style.left = pct;

    const lens = bar.querySelector('#pm-lens');
    const word = loaded && dur && s.status !== 'ended' && s.status !== 'gap' && s.wordIndex >= 0 ? s.words[s.wordIndex] : null;
    if (word) {
      lens.style.left = `${((word.st / dur) * 100).toFixed(2)}%`;
      lens.style.width = `${(((word.en - word.st) / dur) * 100).toFixed(2)}%`;
    } else {
      lens.style.width = '0';
    }

    bar.querySelector('#pm-elapsed').textContent = formatClock(pos);
    bar.querySelector('#pm-duration').textContent = dur ? formatClock(dur) : (loaded ? '–:––' : '0:00');
    const track = bar.querySelector('#pm-track');
    track.setAttribute('aria-valuemax', String(Math.round(dur / 1000)));
    track.setAttribute('aria-valuenow', String(Math.round(pos / 1000)));
    track.setAttribute('aria-valuetext', loaded ? `${formatClock(pos)} of ${dur ? formatClock(dur) : 'unknown length'}` : 'Nothing loaded');

    // Echo: the play button fills as "Your turn" runs out
    const main = bar.querySelector('.pm-btn-main');
    if (s.status === 'gap') {
      main.style.setProperty('--pm-gap', `${(s.gapProgress * 100).toFixed(1)}%`);
      const status = bar.querySelector('#pm-status');
      const text = this.playerStatusText(s);
      if (status.textContent !== text) status.textContent = text;
    } else {
      main.style.removeProperty('--pm-gap');
    }
  }

  // Tap on an ayah number: the loaded ayah pauses or continues (or plays again
  // after it ended); another ayah plays from its start. It also leaves a part
  // (or choosing one) for that whole ayah.
  toggleAyahAudio(verseKey) {
    const p = this.player;
    if (this.part || this.partPick) this.leavePart();
    if (p.key === verseKey && p.status !== 'idle' && !p.part) {
      if (p.isActive) p.pause();
      else p.play();
    } else {
      p.select(verseKey, { play: true });
    }
  }

  // --- Part loops ---
  //
  // Part in the player's option row starts choosing: the next two word taps
  // pick a part's first and last word (in either order, across lines and
  // ayahs, within one surah) instead of revealing them. The part loops in the
  // player with Repeat and Echo; the outer buttons become Previous and Next
  // part, Join plays the parts reached with Next as one stretch, and Hide
  // turns the part into blocks to recite it from memory. ✕, Esc or a tap on
  // an ayah number goes back to whole ayahs.

  wordBox(w) {
    return w
      ? this.container.querySelector(`.mushaf-word-box[data-verse-key="${w.key}"][data-position="${w.pos}"]:not(.ayah-end-block)`)
      : null;
  }

  // A part's first and last word as indexes into pageWords, or null when
  // they aren't both on this page
  partIndexes(range) {
    if (!range) return null;
    const i0 = this.wordAt.get(`${range.from.key}:${range.from.pos}`);
    const i1 = this.wordAt.get(`${range.to.key}:${range.to.pos}`);
    if (i0 == null || i1 == null) return null;
    return { i0: Math.min(i0, i1), i1: Math.max(i0, i1) };
  }

  rangeAt({ i0, i1 }) {
    const a = this.pageWords[i0];
    const b = this.pageWords[i1];
    return { from: { key: a.key, pos: a.pos }, to: { key: b.key, pos: b.pos } };
  }

  // What plays: the current part, or with Join the trail from its first part to it
  partPlayed() {
    const p = this.part;
    if (!p) return null;
    const cur = p.trail[p.ti];
    return p.joined ? { from: p.trail[0].from, to: cur.to } : cur;
  }

  // "Part 2", or with Join "Parts 1–2" (the bar's title names the words)
  partName() {
    const p = this.part;
    const n = p ? p.ti + 1 : 1;
    return p?.joined ? `Parts 1–${n}` : `Part ${n}`;
  }

  // Why Part can't be used with this reciter on this page, or '': a part is
  // cut from the surah file with the word timings
  partsUnavailableNote() {
    const id = this.player.reciterId;
    const surahs = this.pageData ? this.pageSurahs() : [];
    const all = (test) => surahs.length > 0 && surahs.every(test);
    if (hasNoTimings(id) || all((s) => peekChapter(id, s) === null)) {
      return `Parts need word timings, and ${reciterInfo(id).short} has none here. Pick another reciter to use Part.`;
    }
    if (all((s) => peekChapter(id, s) === null || this.player.failedFiles.has(`${id}:${s}`))) {
      return 'The surah recitation didn’t load, so parts can’t play now. Pick another reciter, or reload later.';
    }
    return '';
  }

  // A short note in the bar's word slot
  showPartNote(text) {
    this.partNote = { text, until: Date.now() + NOTE_MS };
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.partNote = null;
      this.syncFollow();
    }, NOTE_MS);
    this.syncFollow();
  }

  // The Part chip: choose a part (or stop choosing). Its first press on a
  // page brings back the last part looped there, so an ayah opens where you
  // stopped; after that it always chooses.
  onPartChip() {
    const note = this.partsUnavailableNote();
    if (note) {
      this.showPartNote(note);
      return;
    }
    if (this.partPick) {
      this.stopChoosing();
      return;
    }
    this.ensureVerseTexts();
    const firstPress = !this.partResumeTried;
    this.partResumeTried = true;
    if (!this.part && firstPress) {
      const saved = this.savedPartToResume();
      if (saved) {
        this.setPart(saved, { play: false });
        this.showPartNote('Your last part here. Press Part again to choose another.');
        return;
      }
    }
    this.partPick = { first: null };
    this.partHover = null;
    this.partNote = null;
    this.drawPart();
    this.syncPlayback();
  }

  stopChoosing() {
    this.partPick = null;
    this.partHover = null;
    this.drawPart();
    this.syncPlayback();
  }

  // A word tapped while choosing: the first end, then the last
  pickPartWord(box) {
    const w = { key: box.dataset.verseKey, pos: Number(box.dataset.position) };
    const first = this.partPick.first;
    if (!first || surahOf(first.key) !== surahOf(w.key)) {
      // A surah has its own file, so a part can't run on into the next surah
      if (first) this.showPartNote('A part stays within one surah. Now tap its last word.');
      this.partPick.first = w;
      this.partHover = w;
      this.drawPart();
      this.syncPlayback();
      return;
    }
    const [a, b] = ordOf(first) <= ordOf(w) ? [first, w] : [w, first];
    this.partPick = null;
    this.partHover = null;
    this.setPart({ from: a, to: b });
  }

  setPart(range, { play = true } = {}) {
    this.ensureVerseTexts();
    this.part = { trail: [{ from: range.from, to: range.to }], ti: 0, joined: false };
    this.savePart(range);
    this.playPart(play);
  }

  playPart(play) {
    const r = this.partPlayed();
    if (!r) return;
    this.partNote = null; // a new part: an old note no longer applies
    this.drawPart();
    this.player.selectPart(r.from, r.to, { play });
  }

  // Waqf signs for Next part: the V1 layout's words carry them; on V2 pages
  // they come from each ayah's whole text, fetched once Part is used (then
  // cached on the device)
  ensureVerseTexts() {
    if (!this.pageData || this.pageData.edition === 'v1' || this.verseTexts) return;
    const page = this.currentPage;
    this.verseTexts = {};
    quranLoader.loadVerseTexts(page).then((texts) => {
      if (this.currentPage !== page || this.pageData?.edition === 'v1') return;
      this.verseTexts = texts || {};
      this.endsCache.clear();
      this.syncPlayerBar();
    });
  }

  // A natural end follows the page's i-th word: a waqf sign or the reciter's
  // own stop (rule 4). The ayah's last word is one too (adjacentPart knows).
  endsAfter(i) {
    const w = this.pageWords[i];
    if (!w) return false;
    const id = this.player.reciterId;
    const chapter = peekChapter(id, surahOf(w.key));
    const cacheKey = `${id}|${w.key}|${chapter ? 1 : 0}`;
    let ends = this.endsCache.get(cacheKey);
    if (!ends) {
      const v1 = this.pageData?.edition === 'v1';
      ends = new Set(naturalEnds({
        texts: v1 ? this.pageWords.filter((x) => x.key === w.key) : null,
        verseText: v1 ? '' : this.verseTexts?.[w.key] || '',
        words: chapter?.verses.get(w.key)?.words || [],
      }).ends);
      this.endsCache.set(cacheKey, ends);
    }
    return ends.has(w.pos);
  }

  // The part after (1) or before (-1) the current one
  adjacentToPart(dir) {
    const p = this.part;
    const cur = p && this.partIndexes(p.trail[p.ti]);
    const n = cur && adjacentPart(this.pageWords, cur, dir, (i) => this.endsAfter(i));
    return n ? this.rangeAt(n) : null;
  }

  canStepPart(dir) {
    if (!this.part) return false;
    if (dir < 0 && this.part.ti > 0) return true;
    return !!this.adjacentToPart(dir);
  }

  // Previous / Next part. Next adds to the trail that Join plays; Previous
  // goes back along it, then before it.
  stepPart(dir) {
    const p = this.part;
    if (!p) return;
    const play = this.player.isActive || this.player.status === 'ended';
    if (dir < 0 && p.ti > 0) {
      p.ti--;
    } else {
      const range = this.adjacentToPart(dir);
      if (!range) return;
      if (surahOf(range.from.key) !== surahOf(p.trail[0].from.key)) {
        p.trail = [range]; // into the next surah: a new trail (Join can't cross files)
        p.ti = 0;
      } else if (dir > 0) {
        p.trail = p.trail.slice(0, p.ti + 1).concat([range]);
        p.ti++;
      } else {
        p.trail = [range].concat(p.trail);
      }
    }
    p.joined = false;
    this.savePart(p.trail[p.ti]);
    this.playPart(play);
  }

  // Join: the trail from its first part to the current one, as one stretch;
  // again for the current part alone
  toggleJoin() {
    const p = this.part;
    if (!p || p.ti === 0) return;
    p.joined = !p.joined;
    this.playPart(true);
  }

  // The played stretch's word boxes on the page
  partWordEls() {
    const ix = this.partIndexes(this.partPlayed());
    const out = [];
    if (ix) {
      for (let i = ix.i0; i <= ix.i1; i++) {
        const el = this.wordBox(this.pageWords[i]);
        if (el) out.push(el);
      }
    }
    return out;
  }

  partAllHidden(els = this.partWordEls()) {
    return els.length > 0 && els.every((el) => !this.revealedWords.has(el.dataset.key));
  }

  // Hide: the part's words become blocks (a tap on one peeks); Show reveals them
  toggleHidePart() {
    const els = this.partWordEls();
    if (!els.length) return;
    this.setRevealedForElements(els, this.partAllHidden(els));
    this.syncPlayerBar();
  }

  // Back to whole ayahs on the page; the caller sees to the player
  leavePart() {
    this.part = null;
    this.partPick = null;
    this.partHover = null;
    this.partNote = null;
    this.drawPart();
  }

  // ✕ and Esc: stop choosing; else leave the part for its first ayah, paused
  exitPart() {
    if (this.partPick) {
      this.stopChoosing();
      return;
    }
    const r = this.partPlayed();
    this.leavePart();
    if (r) this.player.select(r.from.key, { play: false });
    this.syncPlayback();
  }

  // --- Saved parts (the last part per ayah, on this device) ---

  readSavedParts() {
    try {
      const v = JSON.parse(localStorage.getItem(PARTS_KEY) || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  savePart(range) {
    if (!range?.from || !range?.to) return;
    this.savedParts[range.from.key] = { from: range.from, to: range.to, at: Date.now() };
    const keys = Object.keys(this.savedParts);
    if (keys.length > MAX_SAVED_PARTS) {
      keys.sort((a, b) => (this.savedParts[a].at || 0) - (this.savedParts[b].at || 0))
        .slice(0, keys.length - MAX_SAVED_PARTS)
        .forEach((k) => delete this.savedParts[k]);
    }
    try {
      localStorage.setItem(PARTS_KEY, JSON.stringify(this.savedParts));
    } catch {
      // storage full or blocked
    }
  }

  // The part to bring back on Part: the loaded ayah's last part, or with
  // nothing loaded the latest one on this page
  savedPartToResume() {
    const p = this.player;
    const usable = (r) => (r?.from && r?.to && this.partIndexes(r) ? r : null);
    if (p.key && p.status !== 'idle') return p.part ? null : usable(this.savedParts[p.key]);
    let best = null;
    this.getOrderedVerseKeys().forEach((k) => {
      const r = usable(this.savedParts[k]);
      if (r && (!best || (r.at || 0) > (best.at || 0))) best = r;
    });
    return best;
  }

  // --- The part on the page ---

  // The highlighter stroke under the part, the word picked first and, with a
  // mouse, a preview while choosing. Drawn again after every render().
  drawPart() {
    const grid = this.container.querySelector('.mushaf-page-grid');
    if (!grid) return;
    grid.classList.toggle('is-choosing', !!this.partPick);
    grid.querySelectorAll('.mushaf-word-box.in-part, .mushaf-word-box.part-pick').forEach((el) => {
      el.classList.remove('in-part', 'part-pick');
    });
    const boxes = (ix) => {
      const out = [];
      if (ix) {
        for (let i = ix.i0; i <= ix.i1; i++) {
          const el = this.wordBox(this.pageWords[i]);
          if (el) out.push(el);
        }
      }
      return out;
    };
    const part = boxes(this.partIndexes(this.partPlayed()));
    part.forEach((el) => el.classList.add('in-part'));
    const first = this.partPick?.first;
    let preview = [];
    if (first) {
      this.wordBox(first)?.classList.add('part-pick');
      const hover = this.partHover && surahOf(this.partHover.key) === surahOf(first.key) ? this.partHover : first;
      preview = boxes(this.partIndexes({ from: first, to: hover }));
    }
    this.partStrokes = { part, preview };
    if (this.partRO) {
      this.partRO.disconnect();
      if (part.length || preview.length) {
        this.partRO.observe(grid);
        [...part, ...preview].forEach((el) => this.partRO.observe(el));
      }
    }
    this.placePartStrokes();
  }

  // One stroke per line, from the part's rightmost word on it to its leftmost
  placePartStrokes() {
    const grid = this.container.querySelector('.mushaf-page-grid');
    if (!grid) return;
    grid.querySelectorAll('.pm-part-stroke').forEach((el) => el.remove());
    const { part = [], preview = [] } = this.partStrokes || {};
    const draw = (els, cls) => {
      const byLine = new Map();
      els.forEach((el, k) => {
        const line = el.isConnected ? el.closest('.mushaf-line') : null;
        if (!line) return;
        const L = el.offsetLeft;
        const R = L + el.offsetWidth;
        const cur = byLine.get(line);
        if (!cur) {
          byLine.set(line, { L, R, s: k === 0, e: k === els.length - 1 });
        } else {
          cur.L = Math.min(cur.L, L);
          cur.R = Math.max(cur.R, R);
          if (k === els.length - 1) cur.e = true;
        }
      });
      byLine.forEach((r, line) => {
        if (r.R <= r.L) return;
        const d = document.createElement('i');
        d.className = `pm-part-stroke${cls}${r.s ? ' cap-s' : ''}${r.e ? ' cap-e' : ''}`;
        d.setAttribute('aria-hidden', 'true');
        d.style.left = `${r.L - 2}px`;
        d.style.width = `${r.R - r.L + 4}px`;
        line.appendChild(d);
      });
    };
    draw(part, '');
    if (this.partPick) draw(preview, ' is-preview');
  }

  // The Part chip, and Join and Hide while a part is loaded
  syncPartControls(bar, s) {
    const $ = (sel) => bar.querySelector(sel);
    const inPart = !!(this.part && s.part);
    const unavailable = this.partsUnavailableNote();
    const chip = $('#pm-part');
    chip.classList.toggle('on', !!this.partPick);
    chip.classList.toggle('is-unavailable', !!unavailable);
    chip.setAttribute('aria-pressed', String(!!this.partPick));
    chip.setAttribute('aria-disabled', String(!!unavailable));
    const label = unavailable
      || (this.partPick ? 'Stop choosing a part'
        : inPart ? 'Choose another part: tap its first and its last word'
          : 'Part: tap the first and the last word of a stretch to loop it');
    chip.setAttribute('aria-label', label);
    chip.title = label;

    const tools = $('#pm-part-tools');
    tools.hidden = !inPart;
    if (!inPart) return;
    const p = this.part;
    const n = p.ti + 1;
    const join = $('#pm-join');
    join.disabled = p.ti === 0;
    join.classList.toggle('on', p.joined);
    join.setAttribute('aria-pressed', String(p.joined));
    $('#pm-join-lbl').textContent = p.joined ? `1–${n}` : 'Join';
    const joinLabel = p.joined ? `Playing parts 1 to ${n} together. Tap for part ${n} alone`
      : p.ti > 0 ? `Join: play parts 1 to ${n} together`
        : 'Join: after Next part, play the parts together';
    join.setAttribute('aria-label', joinLabel);
    join.title = joinLabel;

    const hidden = this.partAllHidden();
    const hide = $('#pm-hide-part');
    hide.classList.toggle('on', hidden);
    hide.setAttribute('aria-pressed', String(hidden));
    $('#pm-hide-lbl').textContent = hidden ? 'Show' : 'Hide';
    const icon = $('#pm-hide-icon');
    if (icon.dataset.state !== String(hidden)) {
      icon.innerHTML = hidden ? ICONS.show : ICONS.hide;
      icon.dataset.state = String(hidden);
    }
    const hideLabel = hidden ? 'Show the part’s words again' : 'Hide the part, to recite it from memory. Tap a block to peek';
    hide.setAttribute('aria-label', hideLabel);
    hide.title = hideLabel;
  }

  // --- Keyboard (while the Page Map is open) ---

  handleKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (!this.container.querySelector('#pm-player')) return; // the page isn't showing
    if (e.key === 'Escape') {
      if (this.closeSheets()) e.preventDefault();
      else if (this.partPick || this.part) {
        e.preventDefault();
        this.exitPart();
      }
      return;
    }
    const t = e.target;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
    if (document.querySelector('.modal-overlay.active, .modal.active')) return;
    const p = this.player;
    switch (e.key) {
      case ' ':
      case 'Spacebar':
        // A focused button or link does its own thing on Space
        if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return;
        e.preventDefault();
        p.toggle();
        break;
      case 'ArrowLeft':
        if (!p.key) return;
        e.preventDefault();
        if (e.shiftKey) {
          if (this.part) this.stepPart(-1);
          else p.prevAyah();
        } else p.backWord();
        break;
      case 'ArrowRight':
        if (!p.key) return;
        e.preventDefault();
        if (e.shiftKey) {
          if (this.part) this.stepPart(1);
          else p.nextAyah();
        } else p.fwdWord();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        p.cycleRepeat();
        break;
      default:
    }
  }

  // Index the page's words in reading order and find each ayah's first word on this page.
  processPageWords() {
    this.wordSequence = [];
    this.firstWordAnchors = new Set();
    this.pageWords = [];
    this.wordAt = new Map();
    const seenVerses = new Set();

    this.pageData.lines.forEach(lineObj => {
      lineObj.words.forEach((word, idx) => {
        if (word.type !== 'word') return;
        const key = `silhouette-${this.currentPage}-${lineObj.line}-${idx}`;
        this.wordSequence.push(key);
        if (word.verse_key && word.position) {
          this.wordAt.set(`${word.verse_key}:${word.position}`, this.pageWords.length);
          this.pageWords.push({ key: word.verse_key, pos: Number(word.position), text: word.text || '' });
        }
        if (word.verse_key && !seenVerses.has(word.verse_key)) {
          seenVerses.add(word.verse_key);
          this.firstWordAnchors.add(key);
        }
      });
    });
  }

  // --- Repetition Counter ---

  _todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  async loadRepetitionData() {
    this.repHistory = (await db.getProgress('repetition-history')) || {};
    this.listenHistory = (await db.getProgress(LISTEN_HISTORY_KEY)) || {};
    try {
      this.liveCounts = JSON.parse(localStorage.getItem('repetition-live') || '{}');
    } catch {
      this.liveCounts = {};
    }
    // Verse/group selections are page-specific, so clear them on each page load.
    this.counterVerse = null;
    this.counterGroupFrom = null;
    this.counterGroupTo = null;
  }

  _saveHistory() {
    db.saveProgress('repetition-history', this.repHistory);
  }

  _saveLive() {
    Object.keys(this.liveCounts).forEach(k => {
      if (!this.liveCounts[k]) delete this.liveCounts[k];
    });
    localStorage.setItem('repetition-live', JSON.stringify(this.liveCounts));
  }

  // What the counter is currently pointed at, based on mode + selections.
  getCurrentTarget() {
    if (this.counterMode === 'page') {
      return { valid: true, mode: 'page', key: `page-${this.currentPage}`, label: `Page ${this.currentPage}` };
    }
    if (this.counterMode === 'verse') {
      if (!this.counterVerse) return { valid: false, mode: 'verse', key: null, label: 'Pick a verse' };
      return { valid: true, mode: 'verse', key: `verse-${this.counterVerse}`, label: `Verse ${this.counterVerse}` };
    }
    // group
    if (!this.counterGroupFrom || !this.counterGroupTo) {
      return { valid: false, mode: 'group', key: null, label: 'Pick start & end verses' };
    }
    const keys = this.getOrderedVerseKeys();
    let a = keys.indexOf(this.counterGroupFrom);
    let b = keys.indexOf(this.counterGroupTo);
    if (a === -1 || b === -1) return { valid: false, mode: 'group', key: null, label: 'Pick start & end verses' };
    if (a > b) [a, b] = [b, a];
    const from = keys[a], to = keys[b];
    return { valid: true, mode: 'group', key: `group-${from}~${to}`, label: `${from} – ${to}` };
  }

  getLive(key) {
    return (key && this.liveCounts[key]) || 0;
  }

  // --- Listened reps (auto-counted: one per pass the player heard to the end) ---
  // Kept apart from the manual counter: Recited is what you tally, Listened is
  // what the player counts. Stored per ayah under their own key, so the
  // existing 'repetition-history' records are never touched.

  listenedToday(verseKey) {
    return this.listenHistory[`verse-${verseKey}`]?.sessions?.[this._todayStr()] || 0;
  }

  addListened(verseKey) {
    if (!verseKey) return;
    const key = `verse-${verseKey}`;
    if (!this.listenHistory[key]) {
      this.listenHistory[key] = { mode: 'verse', label: `Verse ${verseKey}`, sessions: {} };
    }
    const today = this._todayStr();
    const sessions = this.listenHistory[key].sessions;
    sessions[today] = (sessions[today] || 0) + 1;
    db.saveProgress(LISTEN_HISTORY_KEY, this.listenHistory);

    this.syncPlayerBar();
    const chip = this.container.querySelector('#pm-listened');
    if (chip) {
      chip.classList.remove('bump');
      void chip.offsetWidth; // restart the animation
      chip.classList.add('bump');
    }
    this.refreshCounterPanel();
  }

  // Listened stats summed over a set of ayahs: { total, today, sessions }
  getListenStats(verseKeys) {
    const sessions = {};
    verseKeys.forEach((vk) => {
      const h = this.listenHistory[`verse-${vk}`];
      if (!h?.sessions) return;
      Object.entries(h.sessions).forEach(([date, n]) => {
        sessions[date] = (sessions[date] || 0) + n;
      });
    });
    const total = Object.values(sessions).reduce((s, n) => s + n, 0);
    return { total, today: sessions[this._todayStr()] || 0, sessions };
  }

  // The ayahs a counter target covers (a page target covers every ayah on it)
  _listenKeysFor(target) {
    if (!target.valid) return [];
    if (target.mode === 'page') return this.getOrderedVerseKeys();
    if (target.mode === 'verse') return [target.key.slice(6)];
    const [from, to] = target.key.slice(6).split('~');
    const keys = this.getOrderedVerseKeys();
    let a = keys.indexOf(from);
    let b = keys.indexOf(to);
    if (a === -1 || b === -1) return [];
    if (a > b) [a, b] = [b, a];
    return keys.slice(a, b + 1);
  }

  // The player's "Listened today" chip: point the counter at that ayah and show it
  openCounterFor(verseKey) {
    this.counterMode = 'verse';
    this.counterVerse = verseKey;
    localStorage.setItem('repetition-mode', 'verse');
    this.counterOpen = true;
    localStorage.setItem('pagemap-counter-open', '1');
    const panel = document.getElementById('pagemap-counter-panel');
    if (!panel) return;
    panel.classList.add('open');
    this.refreshCounterPanel();
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this._flashCurrentTarget();
  }

  // Saved-history stats for a target: grand total, today's committed count, and the raw sessions map.
  getStats(key) {
    const h = key && this.repHistory[key];
    const sessions = h ? h.sessions : {};
    const total = Object.values(sessions).reduce((s, n) => s + n, 0);
    const today = sessions[this._todayStr()] || 0;
    return { total, today, sessions };
  }

  // --- Counter mutations (state only; callers refresh the panel) ---

  adjustCount(delta) {
    const t = this.getCurrentTarget();
    if (!t.valid) return;
    this.liveCounts[t.key] = Math.max(0, this.getLive(t.key) + delta);
    this._saveLive();
  }

  resetLive() {
    const t = this.getCurrentTarget();
    if (!t.valid) return;
    this.liveCounts[t.key] = 0;
    this._saveLive();
  }

  // Commit the live tally into today's dated history entry, then zero the live count.
  saveSession() {
    const t = this.getCurrentTarget();
    if (!t.valid) return false;
    const live = this.getLive(t.key);
    if (live <= 0) return false;

    if (!this.repHistory[t.key]) {
      this.repHistory[t.key] = { mode: t.mode, label: t.label, sessions: {} };
    }
    const today = this._todayStr();
    this.repHistory[t.key].label = t.label;
    this.repHistory[t.key].sessions[today] = (this.repHistory[t.key].sessions[today] || 0) + live;
    this.liveCounts[t.key] = 0;
    this._saveHistory();
    this._saveLive();
    return true;
  }

  clearTargetHistory(key) {
    delete this.repHistory[key];
    this.liveCounts[key] = 0;
    this._saveHistory();
    this._saveLive();
  }

  // Saved targets that live on the current page, most recently practiced first.
  // Each entry can be clicked in the panel to re-select that target and keep counting.
  getPageTargets() {
    const keys = this.getOrderedVerseKeys();
    const onPage = (vk) => keys.includes(vk);
    const entries = [];

    Object.entries(this.repHistory).forEach(([key, h]) => {
      let belongs = false;
      if (key === `page-${this.currentPage}`) {
        belongs = true;
      } else if (key.startsWith('verse-')) {
        belongs = onPage(key.slice(6));
      } else if (key.startsWith('group-')) {
        const [from, to] = key.slice(6).split('~');
        belongs = onPage(from) && onPage(to);
      }
      if (!belongs) return;

      const dates = Object.keys(h.sessions);
      const total = Object.values(h.sessions).reduce((s, n) => s + n, 0);
      if (total <= 0) return;
      entries.push({ key, mode: h.mode, label: h.label, total, lastDate: dates.sort().pop() || '' });
    });

    entries.sort((a, b) => b.lastDate.localeCompare(a.lastDate));
    return entries;
  }

  // Point the counter at a previously saved target (from the Recent list).
  selectTarget(key) {
    if (key.startsWith('page-')) {
      this.counterMode = 'page';
    } else if (key.startsWith('verse-')) {
      this.counterMode = 'verse';
      this.counterVerse = key.slice(6);
    } else if (key.startsWith('group-')) {
      const [from, to] = key.slice(6).split('~');
      this.counterMode = 'group';
      this.counterGroupFrom = from;
      this.counterGroupTo = to;
    }
    localStorage.setItem('repetition-mode', this.counterMode);
  }

  // --- Counter panel rendering ---

  _formatSessionDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  renderCounterPanelInner() {
    const t = this.getCurrentTarget();
    const keys = this.getOrderedVerseKeys();
    const live = this.getLive(t.key);
    const stats = this.getStats(t.key);
    // Show "live" numbers so the tallies feel responsive before saving.
    const todayShown = stats.today + live;
    const totalShown = stats.total + live;

    const tab = (mode, txt) =>
      `<button class="rep-mode-tab ${this.counterMode === mode ? 'active' : ''}" data-rep-mode="${mode}">${txt}</button>`;

    const opts = (selected) =>
      `<option value="">—</option>` +
      keys.map(k => `<option value="${k}" ${k === selected ? 'selected' : ''}>${k}</option>`).join('');

    let targetHtml = '';
    if (this.counterMode === 'page') {
      targetHtml = `<div class="rep-target-page">Page ${this.currentPage}</div>`;
    } else if (this.counterMode === 'verse') {
      targetHtml = `
        <label class="rep-field">
          <span>Verse</span>
          <select id="rep-verse-select" class="rep-select">${opts(this.counterVerse)}</select>
        </label>`;
    } else {
      targetHtml = `
        <div class="rep-group-fields">
          <label class="rep-field"><span>From</span><select id="rep-group-from" class="rep-select">${opts(this.counterGroupFrom)}</select></label>
          <label class="rep-field"><span>To</span><select id="rep-group-to" class="rep-select">${opts(this.counterGroupTo)}</select></label>
        </div>`;
    }

    // Listened (counted by the player) next to Recited (tallied here)
    const listen = this.getListenStats(this._listenKeysFor(t));
    const headphones = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"/><path d="M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/></svg>';

    const dates = [...new Set([...Object.keys(stats.sessions), ...Object.keys(listen.sessions)])]
      .filter((date) => (stats.sessions[date] || 0) + (listen.sessions[date] || 0) > 0)
      .sort((a, b) => b.localeCompare(a));
    const sessionRows = dates
      .map((date) => {
        const recited = stats.sessions[date] || 0;
        const heard = listen.sessions[date] || 0;
        return `
          <div class="rep-history-row">
            <span>${this._formatSessionDate(date)}</span>
            <span class="rep-history-nums">
              <span class="rep-history-count" title="Recited">${recited ? `${recited}×` : '–'}</span>
              <span class="rep-history-listened" title="Listened">${heard ? `${headphones}${heard}` : ''}</span>
            </span>
          </div>`;
      })
      .join('');

    const recentRows = this.getPageTargets()
      .map(e => {
        const heard = this.getListenStats(this._listenKeysFor({ valid: true, mode: e.mode, key: e.key })).total;
        return `
        <div class="rep-recent-row ${e.key === t.key ? 'active' : ''}" data-rep-target="${e.key}" title="Click to select and continue counting">
          <span class="rep-recent-label">${e.label}</span>
          <span class="rep-recent-total" title="Recited">${e.total}×</span>
          ${heard ? `<span class="rep-recent-listened" title="Listened">${headphones}${heard}</span>` : ''}
          <button class="rep-recent-delete" data-rep-delete="${e.key}" title="Delete saved history for ${e.label}">×</button>
        </div>`;
      })
      .join('');

    const disabled = t.valid ? '' : 'disabled';
    const saveDisabled = (t.valid && live > 0) ? '' : 'disabled';
    // One-line summary for the collapsed header on phones
    const summary = t.valid
      ? `${t.label} · ${todayShown} recited${listen.today ? `, ${listen.today} listened` : ''} today`
      : t.label;

    return `
      <div class="rep-panel-head">
        <span class="rep-panel-title">Repetition Counter</span>
        <!-- Phones: the header opens and closes the counter (CSS shows one or the other) -->
        <button type="button" class="rep-panel-toggle" id="rep-panel-toggle" aria-expanded="${this.counterOpen}" aria-controls="rep-panel-body">
          <span class="rep-panel-title">Repetition Counter</span>
          <span class="rep-panel-summary">${summary}</span>
          <svg class="rep-panel-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      </div>

      <div class="rep-panel-body" id="rep-panel-body">
      <div class="rep-mode-tabs">
        ${tab('verse', 'Verse')}
        ${tab('group', 'Group')}
        ${tab('page', 'Page')}
      </div>

      <div class="rep-target">${targetHtml}</div>

      <div class="rep-count-wrap">
        <button class="rep-adjust" id="rep-minus" ${disabled} aria-label="Decrease">−</button>
        <div class="rep-count" id="rep-count">${t.valid ? live : '—'}</div>
        <button class="rep-adjust" id="rep-plus" ${disabled} aria-label="Increase">+</button>
      </div>
      <div class="rep-count-hint">${t.valid ? 'recited this session' : t.label}</div>

      <div class="rep-actions">
        <button class="btn-gold" id="rep-save" ${saveDisabled}>Save</button>
        <button class="btn-outline" id="rep-reset" ${saveDisabled}>Reset</button>
      </div>

      <div class="rep-stats rep-stats-2">
        <div class="rep-stat-row">
          <span class="rep-stat-name">Recited</span>
          <span>Today <strong id="rep-today">${todayShown}</strong></span>
          <span>Total <strong id="rep-total">${totalShown}</strong></span>
        </div>
        <div class="rep-stat-row rep-stat-listened" title="Counted by the player: one for each time an ayah played to its end">
          <span class="rep-stat-name">${headphones}Listened</span>
          <span>Today <strong id="rep-listened-today">${t.valid ? listen.today : 0}</strong></span>
          <span>Total <strong id="rep-listened-total">${t.valid ? listen.total : 0}</strong></span>
        </div>
      </div>

      <div class="rep-history-head">
        <span>Recent on this page</span>
      </div>
      <div class="rep-recent" id="rep-recent">
        ${recentRows || `<div class="rep-history-empty">No saved targets yet</div>`}
      </div>

      <div class="rep-history-head">
        <span>History <span class="rep-history-legend">recited · ${headphones}listened</span></span>
        ${stats.total > 0 ? `<button class="rep-clear" id="rep-clear" title="Clear the saved recited reps for this target">Clear</button>` : ''}
      </div>
      <div class="rep-history" id="rep-history">
        ${sessionRows || `<div class="rep-history-empty">No saved reps yet</div>`}
      </div>
      </div>
    `;
  }

  refreshCounterPanel() {
    const panel = document.getElementById('pagemap-counter-panel');
    if (!panel) return;
    panel.innerHTML = this.renderCounterPanelInner();
    this.bindCounterPanel();
  }

  bindCounterPanel() {
    const panel = document.getElementById('pagemap-counter-panel');
    if (!panel) return;

    // Phones: open / close the counter under the page (remembered on this device)
    panel.querySelector('#rep-panel-toggle')?.addEventListener('click', (e) => {
      this.counterOpen = !this.counterOpen;
      localStorage.setItem('pagemap-counter-open', this.counterOpen ? '1' : '0');
      panel.classList.toggle('open', this.counterOpen);
      e.currentTarget.setAttribute('aria-expanded', this.counterOpen);
    });

    panel.querySelectorAll('.rep-mode-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.counterMode = btn.dataset.repMode;
        localStorage.setItem('repetition-mode', this.counterMode);
        this.refreshCounterPanel();
      });
    });

    panel.querySelector('#rep-verse-select')?.addEventListener('change', (e) => {
      this.counterVerse = e.target.value || null;
      this.refreshCounterPanel();
    });
    panel.querySelector('#rep-group-from')?.addEventListener('change', (e) => {
      this.counterGroupFrom = e.target.value || null;
      this.refreshCounterPanel();
    });
    panel.querySelector('#rep-group-to')?.addEventListener('change', (e) => {
      this.counterGroupTo = e.target.value || null;
      this.refreshCounterPanel();
    });

    panel.querySelector('#rep-minus')?.addEventListener('click', () => {
      this.adjustCount(-1);
      this.refreshCounterPanel();
    });
    panel.querySelector('#rep-plus')?.addEventListener('click', () => {
      this.adjustCount(1);
      this.refreshCounterPanel();
    });
    panel.querySelector('#rep-reset')?.addEventListener('click', () => {
      this.resetLive();
      this.refreshCounterPanel();
    });
    panel.querySelector('#rep-save')?.addEventListener('click', () => {
      if (this.saveSession()) {
        this._flashCurrentTarget();
        this.refreshCounterPanel();
      }
    });
    panel.querySelector('#rep-clear')?.addEventListener('click', () => {
      const t = this.getCurrentTarget();
      if (t.valid && confirm(`Clear the saved recited reps for ${t.label}? Listened reps are kept.`)) {
        this.clearTargetHistory(t.key);
        this.refreshCounterPanel();
      }
    });

    // Recent targets: click a row to re-select that target; × deletes its history.
    panel.querySelectorAll('.rep-recent-row').forEach(row => {
      row.addEventListener('click', () => {
        this.selectTarget(row.dataset.repTarget);
        this.refreshCounterPanel();
        this._flashCurrentTarget();
      });
    });
    panel.querySelectorAll('.rep-recent-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.repDelete;
        const label = this.repHistory[key]?.label || key;
        if (confirm(`Delete the saved recited reps for ${label}? Listened reps are kept.`)) {
          this.clearTargetHistory(key);
          this.refreshCounterPanel();
        }
      });
    });
  }

  // The verse keys covered by the current target (for highlight/flash on the map).
  _targetVerseKeys() {
    if (this.counterMode === 'verse' && this.counterVerse) return [this.counterVerse];
    if (this.counterMode === 'group' && this.counterGroupFrom && this.counterGroupTo) {
      const keys = this.getOrderedVerseKeys();
      let a = keys.indexOf(this.counterGroupFrom);
      let b = keys.indexOf(this.counterGroupTo);
      if (a === -1 || b === -1) return [];
      if (a > b) [a, b] = [b, a];
      return keys.slice(a, b + 1);
    }
    return []; // page mode: no specific highlight
  }

  _flashCurrentTarget() {
    const verseKeys = this._targetVerseKeys();
    const words = [];
    verseKeys.forEach(vk => {
      this.container.querySelectorAll(`.mushaf-word-box[data-verse-key="${vk}"]`).forEach(w => words.push(w));
    });
    words.forEach(w => w.classList.add('verse-locate-flash'));
    setTimeout(() => words.forEach(w => w.classList.remove('verse-locate-flash')), 1600);
  }

  // A word is visible if explicitly revealed, or shown as an anchor in first-word mode
  isWordShown(key) {
    if (this.revealedWords.has(key)) return true;
    return this.studyMode === 'first-word' && this.firstWordAnchors.has(key);
  }

  // Look up the cached English gloss for a rendered word box, if any
  getWordTranslation(box) {
    const verseKey = box.dataset.verseKey;
    const position = box.dataset.position;
    if (!verseKey || !position) return null;
    return this.wordTranslations[`${verseKey}:${position}`] || null;
  }

  showWordTooltip(box) {
    const text = this.getWordTranslation(box);
    if (!text) return;

    this.hideWordTooltip();

    const tooltip = document.createElement('div');
    tooltip.id = 'mushaf-word-tooltip';
    tooltip.className = 'mushaf-word-tooltip';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);

    const boxRect = box.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let left = boxRect.left + boxRect.width / 2 - tipRect.width / 2;
    let top = boxRect.top - tipRect.height - 8;

    if (left < 4) left = 4;
    if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
    if (top < 4) top = boxRect.bottom + 8; // flip below if no room above

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  hideWordTooltip() {
    document.getElementById('mushaf-word-tooltip')?.remove();
  }

  // Briefly pop up the translation tooltip over a word that was just revealed
  // (Translations toggle). Reuses the hover tooltip; only one flash at a time,
  // so a slider sweep shows each word's gloss as the reveal edge passes it.
  flashWordGloss(box) {
    if (!this.showGlosses || !box) return;
    this.showWordTooltip(box);
    clearTimeout(this._glossFlashTimer);
    this._glossFlashTimer = setTimeout(() => this.hideWordTooltip(), 1600);
  }

  getNextSequentialKey() {
    return this.wordSequence.find(key => !this.revealedWords.has(key)) || null;
  }

  saveRevealed() {
    db.saveProgress(`pagemap-revealed-${this.currentPage}`, Array.from(this.revealedWords));
  }

  // Update reveal state for a list of word-box elements, persist, and refresh the progress UI
  setRevealedForElements(elements, reveal) {
    let lastNewlyRevealed = null;
    elements.forEach(el => {
      const key = el.dataset.key;
      if (!key) return; // skip ayah-end markers
      if (reveal) {
        if (!this.revealedWords.has(key)) lastNewlyRevealed = el;
        this.revealedWords.add(key);
      } else {
        this.revealedWords.delete(key);
      }
      this.clearPartialReveal(el);
      el.classList.toggle('revealed', this.isWordShown(key));
    });
    this.saveRevealed();
    this.updateSilhouetteProgress();
    this.syncLineSliders();
    this.flashWordGloss(lastNewlyRevealed);
  }

  clearPartialReveal(el) {
    el.classList.remove('partial');
    el.style.removeProperty('--reveal-pct');
  }

  // Measure a line's word boxes and stretch the slider track to overlay exactly
  // the horizontal span the words occupy, so the thumb position maps 1:1 to a
  // pixel reveal boundary. Returns { rects, right, span } or null.
  measureSlider(slider) {
    const lineEl = slider.closest('.mushaf-line');
    if (!lineEl) return null;
    const boxes = Array.from(lineEl.querySelectorAll('.mushaf-word-box[data-key]'));
    if (!boxes.length) return null;

    const lineRect = lineEl.getBoundingClientRect();
    let right = -Infinity;
    let left = Infinity;
    const rects = boxes.map(box => {
      const r = box.getBoundingClientRect();
      if (r.right > right) right = r.right;
      if (r.left < left) left = r.left;
      return { box, r };
    });
    const span = right - left;
    if (span <= 0) return null;

    // Overlay the slider track precisely on the word area
    slider.style.left = `${left - lineRect.left}px`;
    slider.style.right = 'auto';
    slider.style.width = `${span}px`;

    return { rects, right, left, span };
  }

  // Slider value (0–1000) corresponding to the current revealed run from the
  // line's start edge (right side, reading direction).
  sliderValueFromState(geo) {
    let f = 0;
    for (const { box, r } of geo.rects) {
      if (this.revealedWords.has(box.dataset.key)) {
        f = (geo.right - r.left) / geo.span; // boundary at this word's left edge
      } else {
        break;
      }
    }
    return Math.round(f * 1000);
  }

  // Reveal words up to fraction f (0 = nothing, 1 = whole line), measured from
  // the right. The word straddling the boundary is partially revealed so the
  // reveal edge tracks the thumb exactly.
  applySliderFraction(geo, f) {
    let lastNewlyRevealed = null;
    geo.rects.forEach(({ box, r }) => {
      const key = box.dataset.key;
      const wordRightFrac = (geo.right - r.right) / geo.span;
      const wordLeftFrac = (geo.right - r.left) / geo.span;

      if (f >= wordLeftFrac - 1e-4) {
        if (!this.revealedWords.has(key)) lastNewlyRevealed = box;
        this.revealedWords.add(key);
        this.clearPartialReveal(box);
        box.classList.add('revealed');
      } else if (f > wordRightFrac) {
        this.revealedWords.delete(key);
        box.classList.remove('revealed');
        box.classList.add('partial');
        const pct = ((f - wordRightFrac) / (wordLeftFrac - wordRightFrac)) * 100;
        box.style.setProperty('--reveal-pct', `${pct}%`);
      } else {
        this.revealedWords.delete(key);
        this.clearPartialReveal(box);
        box.classList.toggle('revealed', this.isWordShown(key));
      }
    });
    this.flashWordGloss(lastNewlyRevealed);
  }

  // Re-measure every visible slider and snap its thumb to the current reveal
  // state (used after Hide/Show All, menu actions, resize, and font load).
  syncLineSliders() {
    this.container.querySelectorAll('.line-reveal-slider').forEach(slider => {
      const geo = this.measureSlider(slider);
      if (geo) slider.value = this.sliderValueFromState(geo);
    });
  }

  progressText(revealed, total, pct) {
    return `Revealed ${revealed} / ${total} · ${pct}%`;
  }

  updateSilhouetteProgress() {
    const total = this.wordSequence.length;
    const revealed = this.revealedWords.size;
    const pct = total ? Math.round((revealed / total) * 100) : 0;

    const bar = document.getElementById('sil-progress-bar');
    if (bar) bar.style.width = `${pct}%`;
    const text = document.getElementById('sil-progress-text');
    if (text) text.textContent = this.progressText(revealed, total, pct);

    // A peek, Show all or a slider can change what the part's Hide chip says
    const playerBar = this.container.querySelector('#pm-player');
    if (playerBar && this.part) this.syncPartControls(playerBar, this.player.getState());

    // Refresh the sequential-mode next-word hint
    this.container.querySelectorAll('.mushaf-word-box.next-word-hint').forEach(el => el.classList.remove('next-word-hint'));
    if (this.studyMode === 'sequential') {
      const nextKey = this.getNextSequentialKey();
      if (nextKey) {
        this.container.querySelector(`.mushaf-word-box[data-key="${nextKey}"]`)?.classList.add('next-word-hint');
      }
    }
  }

  // --- Sub-feature 1: Page Silhouette (Block Mode) ---
  renderSilhouette() {
    let linesHtml = '';
    
    // Inject @font-face rules dynamically for the fonts used on this page
    const fonts = new Set();
    this.pageData.lines.forEach(l => {
      l.words.forEach(w => {
        if (w.font) fonts.add(w.font);
      });
    });

    // Tajweed mode renders Uthmani text rather than the one-glyph-per-word
    // page fonts (a single glyph can't be coloured letter by letter), so the
    // @font-face downloads are skipped entirely.
    let fontStyles = '';
    if (!this.tajweedMode) fonts.forEach(fontName => {
      let fontUrl;
      let format;
      
      if (this.currentEdition === 'v1') {
        fontUrl = `https://verses.quran.foundation/fonts/quran/hafs/v1/woff2/${fontName}.woff2`;
        format = 'woff2';
      } else {
        fontUrl = fontName === 'QCF4_QBSML' 
          ? 'https://raw.githubusercontent.com/MohamadHajjRabee/quran-qcf4/main/fonts/QCF4_QBSML.ttf'
          : `https://raw.githubusercontent.com/MohamadHajjRabee/quran-qcf4/main/fonts/${fontName}_W.ttf`;
        format = 'truetype';
      }
      
      fontStyles += `
        @font-face {
          font-family: '${fontName}';
          src: url('${fontUrl}') format('${format}');
        }
      `;
    });
    
    this.pageData.lines.forEach((lineObj) => {
      let wordsHtml = '';
      
      lineObj.words.forEach((word, idx) => {
        const isEnd = word.type === 'end';
        const wordKey = `silhouette-${this.currentPage}-${lineObj.line}-${idx}`;
        
        if (word.type === 'surah_header') {
          const surahName = this.pageData.surahs.find(s => s.id === word.sura)?.name_arabic || '';
          wordsHtml += `
            <div class="mushaf-surah-header" style="flex-grow: 1; height: 100%; display: flex; align-items: center; justify-content: center; margin: 0 4px; border: 1px dashed var(--accent-gold); border-radius: 8px; background-color: rgba(212, 175, 55, 0.05);">
              <span style="font-family: var(--font-arabic); font-size: clamp(1rem, 3.5vw, 1.5rem); line-height: 1; color: var(--accent-gold);">سُورَةُ ${surahName}</span>
            </div>
          `;
        } else if (word.type === 'bismillah') {
          wordsHtml += `
            <div class="mushaf-bismillah" style="flex-grow: 1; height: 100%; display: flex; align-items: center; justify-content: center; margin: 0 4px;">
              <span style="font-family: var(--font-arabic); font-size: clamp(1.1rem, 4vw, 1.6rem); line-height: 1; color: var(--text-primary);">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</span>
            </div>
          `;
        } else if (isEnd) {
          // Extract verse number from key "87:5" -> "5"
          const verseNum = word.verse_key ? word.verse_key.split(':')[1] : '';
          wordsHtml += `<span class="mushaf-word-box ayah-end-block" data-verse-key="${word.verse_key || ''}">${verseNum}</span>`;
        } else if (word.type === 'word') {
          // Render blank blocks using proportional flex-grow to prevent container overflow
          // Render the exact QCF4 character (word.char) to get perfect Madinah Mushaf calligraphy
          const markType = this.markedWords.get(wordKey);
          const isShown = this.isWordShown(wordKey);

          // In tajweed mode substitute the coloured Uthmani markup for the
          // glyph. Falls back to the layout's own text if this word has no
          // entry, so a word-count mismatch degrades to uncoloured text
          // instead of a blank box.
          let inner;
          let fontFamily;
          if (this.tajweedMode) {
            const tajweedHtml = this.tajweed[`${word.verse_key}:${word.position}`];
            inner = `<span class="word-glyph tajweed-word">${tajweedHtml || word.text}</span>`;
            fontFamily = 'var(--font-arabic)';
          } else {
            inner = `<span class="word-glyph">${word.char}</span>`;
            fontFamily = `'${word.font}'`;
          }

          wordsHtml += `
            <span class="mushaf-word-box ${markType ? `marked-${markType}` : ''} ${isShown ? 'revealed' : ''}"
                  data-key="${wordKey}"
                  data-verse-key="${word.verse_key || ''}"
                  data-position="${word.position || ''}"
                  data-text="${word.text}"
                  style="font-family: ${fontFamily}; font-size: clamp(1.1rem, 4vw, 1.65rem); line-height: 1; flex-shrink: 1;">
              ${inner}
            </span>
          `;
        }
      });

      // Per-line reading slider. Uses a fine 0–1000 range that JS maps to the
      // line's actual pixel width, so the thumb aligns with the reveal edge.
      let sliderHtml = '';
      if (this.sliderMode && lineObj.words.some(w => w.type === 'word')) {
        sliderHtml = `<input type="range" class="line-reveal-slider" data-line="${lineObj.line}" min="0" max="1000" step="1" value="0">`;
      }

      linesHtml += `
        <div class="mushaf-line" data-line="${lineObj.line}">
          <span class="mushaf-line-number">${lineObj.line}</span>
          ${wordsHtml}
          <span class="mushaf-line-right-number">${lineObj.line}</span>
          ${sliderHtml}
        </div>
      `;
    });

    const total = this.wordSequence.length;
    const revealed = this.revealedWords.size;
    const pct = total ? Math.round((revealed / total) * 100) : 0;

    return `
      <style>
        ${fontStyles}
        .mushaf-word-box.next-word-hint {
          border-color: var(--accent-gold-hover) !important;
          background-color: rgba(212, 175, 55, 0.12) !important;
        }
      </style>
      <!-- Reveal progress and actions, one row above the page (the how-to text
           lives in the View sheet, so the page gets the height) -->
      <div class="pm-progress">
        <div class="progress-bar-container pm-progress-bar">
          <div id="sil-progress-bar" class="progress-bar" style="width: ${pct}%"></div>
        </div>
        <div class="pm-progress-row">
          <span id="sil-progress-text" class="pm-progress-text">${this.progressText(revealed, total, pct)}</span>
          <span class="pm-progress-actions">
            <button type="button" id="sil-reveal-next-btn" class="btn-quiet" ${this.studyMode !== 'sequential' ? 'hidden' : ''}>Reveal next →</button>
            <button type="button" id="sil-show-all-btn" class="btn-quiet">Show all</button>
            <button type="button" id="sil-hide-all-btn" class="btn-quiet">Hide all</button>
          </span>
        </div>
      </div>
      <div class="mushaf-page-container">
        <div class="mushaf-page-grid">
          ${linesHtml}
        </div>
      </div>
      ${this.tajweedMode ? this.renderTajweedLegend() : ''}
    `;
  }

  renderTajweedLegend() {
    const rules = [
      ['--tj-ghunnah', 'Ghunnah'],
      ['--tj-qalqalah', 'Qalqalah'],
      ['--tj-ikhafa', 'Ikhfa'],
      ['--tj-idgham', 'Idgham (with ghunnah)'],
      ['--tj-idgham-quiet', 'Idgham (without ghunnah)'],
      ['--tj-iqlab', 'Iqlab'],
      ['--tj-madda-normal', 'Madd (2 counts)'],
      ['--tj-madda-permissible', 'Madd (permissible)'],
      ['--tj-madda-obligatory', 'Madd (obligatory)'],
      ['--tj-madda-necessary', 'Madd (necessary)'],
      ['--tj-silent', 'Silent / hamzat wasl'],
    ];
    return `
      <div class="tajweed-legend">
        ${rules.map(([cssVar, label]) =>
          `<span><i style="background-color: var(${cssVar});"></i>${label}</span>`
        ).join('')}
      </div>
    `;
  }

  setupEvents() {
    // Navigate to Writing Practice
    const writeBtn = document.getElementById('pagemap-write-btn');
    if (writeBtn) {
      writeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.app && window.app.navigateToWritingPage) {
          window.app.navigateToWritingPage(this.currentPage);
        }
      });
    }
    
    // Page History toggle
    const historyBtn = document.getElementById('pagemap-history-btn');
    if (historyBtn) {
      historyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showHistory = !this.showHistory;
        this.render();
        this.setupEvents();
      });
    }
    
    // Page History item clicks
    this.container.querySelectorAll('.pagemap-history-item').forEach(item => {
      item.addEventListener('click', () => {
        const page = parseInt(item.dataset.page);
        if (page && page !== this.currentPage) {
          this.showHistory = false;
          // Also update the surah-selector's current page display
          if (window.app && window.app.surahSelector) {
            window.app.surahSelector.setCurrentPage(page);
          }
          this.loadPage(page);
        }
      });
    });
    
    // Clear history button
    const clearHistoryBtn = document.getElementById('pagemap-clear-history');
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._clearHistory();
        this.render();
        this.setupEvents();
      });
    }
    
    // Close history panel when clicking outside
    if (this.showHistory) {
      const closeHistoryOnOutsideClick = (e) => {
        const wrapper = this.container.querySelector('.pagemap-history-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
          this.showHistory = false;
          this.render();
          this.setupEvents();
          document.removeEventListener('mousedown', closeHistoryOnOutsideClick);
        }
      };
      setTimeout(() => {
        document.addEventListener('mousedown', closeHistoryOnOutsideClick);
      }, 10);
    }

    // Silhouette grid interaction (the only view now, so its handlers always bind)
    const grid = this.container.querySelector('.mushaf-page-grid');
    if (grid) {
      let pressTimer = null;
      let isLongPress = false;
      let startX = 0;
      let startY = 0;
      
      const startPress = (e) => {
        if (e.type === 'mousedown' && e.button !== 0) return;
        const target = e.target;
        const targetNum = target.closest('.mushaf-word-box') || target.closest('.mushaf-line-number') || target.closest('.mushaf-line-right-number');
        if (!targetNum) return;
        
        isLongPress = false;
        startX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        startY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
        
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          isLongPress = true;
          this.showContextMenu(targetNum, startX, startY);
        }, 500);
      };
      
      const cancelPress = (e) => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };
      
      const movePress = (e) => {
        if (!pressTimer) return;
        const currentX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        const currentY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
        if (Math.abs(currentX - startX) > 10 || Math.abs(currentY - startY) > 10) {
          cancelPress();
        }
      };
      
      grid.addEventListener('mousedown', startPress);
      grid.addEventListener('mouseup', cancelPress);
      grid.addEventListener('mouseleave', cancelPress);
      grid.addEventListener('mousemove', movePress);
      
      grid.addEventListener('touchstart', startPress, { passive: true });
      grid.addEventListener('touchend', cancelPress, { passive: true });
      grid.addEventListener('touchcancel', cancelPress, { passive: true });
      grid.addEventListener('touchmove', movePress, { passive: true });
      
      // Hover tooltip: show the English word-by-word gloss for a displayed (revealed) word
      grid.addEventListener('mouseover', (e) => {
        // Choosing with a mouse: the part previews from the first word to this one
        if (this.partPick?.first) {
          const w = e.target.closest('.mushaf-word-box[data-position]:not(.ayah-end-block)');
          const next = w ? { key: w.dataset.verseKey, pos: Number(w.dataset.position) } : null;
          if (!sameWord(next, this.partHover)) {
            this.partHover = next;
            this.drawPart();
          }
        }
        const box = e.target.closest('.mushaf-word-box');
        if (!box || box.classList.contains('ayah-end-block') || !box.classList.contains('revealed')) return;
        this.showWordTooltip(box);
      });
      grid.addEventListener('mouseout', (e) => {
        if (e.target.closest('.mushaf-word-box')) this.hideWordTooltip();
      });

      grid.addEventListener('contextmenu', (e) => {
        const target = e.target;
        const targetNum = target.closest('.mushaf-word-box') || target.closest('.mushaf-line-number') || target.closest('.mushaf-line-right-number');
        if (targetNum) {
          e.preventDefault();
          this.showContextMenu(targetNum, e.clientX, e.clientY);
        }
      });

      grid.addEventListener('click', (e) => {
        if (isLongPress) {
          e.preventDefault();
          e.stopPropagation();
          isLongPress = false;
          return;
        }

        const box = e.target.closest('.mushaf-word-box');
        if (!box) return;

        if (box.classList.contains('ayah-end-block')) {
          // The ayah number plays its recitation (tap again to pause / continue).
          // Hiding and showing the ayah lives in its long-press menu.
          if (box.dataset.verseKey) this.toggleAyahAudio(box.dataset.verseKey);
        } else if (this.partPick && box.dataset.verseKey && box.dataset.position) {
          // Choosing a part: the tap picks a word instead of revealing it
          this.pickPartWord(box);
        } else if (box.dataset.key) {
          this.setRevealedForElements([box], !this.revealedWords.has(box.dataset.key));
        }
      });

      // Study mode switcher (Free / Sequential / First Word Anchors)
      this.container.querySelectorAll('.study-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.studyMode = btn.dataset.studyMode;
          localStorage.setItem('pagemap-study-mode', this.studyMode);
          this.render();
          this.setupEvents();
        });
      });

      // Sequential reveal button
      document.getElementById('sil-reveal-next-btn')?.addEventListener('click', () => {
        const nextKey = this.getNextSequentialKey();
        if (!nextKey) return;
        const el = this.container.querySelector(`.mushaf-word-box[data-key="${nextKey}"]`);
        if (el) this.setRevealedForElements([el], true);
      });

      // Hide All / Show All
      document.getElementById('sil-hide-all-btn')?.addEventListener('click', () => {
        this.revealedWords.clear();
        this.saveRevealed();
        this.container.querySelectorAll('.mushaf-word-box[data-key]').forEach(el => {
          this.clearPartialReveal(el);
          el.classList.toggle('revealed', this.isWordShown(el.dataset.key));
        });
        this.updateSilhouetteProgress();
        this.syncLineSliders();
      });

      document.getElementById('sil-show-all-btn')?.addEventListener('click', () => {
        this.wordSequence.forEach(key => this.revealedWords.add(key));
        this.saveRevealed();
        this.container.querySelectorAll('.mushaf-word-box[data-key]').forEach(el => {
          this.clearPartialReveal(el);
          el.classList.add('revealed');
        });
        this.updateSilhouetteProgress();
        this.syncLineSliders();
      });

      // Translations toggle: briefly pops up the English gloss when a word is
      // revealed (tap, menu action, or reading slider). State only — reveal
      // state and sliders are untouched.
      document.getElementById('sil-gloss-toggle-btn')?.addEventListener('click', (e) => {
        this.showGlosses = !this.showGlosses;
        localStorage.setItem('pagemap-show-glosses', this.showGlosses ? '1' : '0');
        e.currentTarget.classList.toggle('active', this.showGlosses);
        e.currentTarget.setAttribute('aria-pressed', this.showGlosses);
      });

      // Tajweed toggle: swaps glyph rendering for coloured Uthmani text. The
      // markup is fetched lazily the first time it's switched on, then cached.
      // Reveal state is keyed by line/index, so it survives the re-render.
      document.getElementById('sil-tajweed-toggle-btn')?.addEventListener('click', async (e) => {
        this.tajweedMode = !this.tajweedMode;
        localStorage.setItem('pagemap-tajweed-mode', this.tajweedMode ? '1' : '0');
        e.currentTarget.classList.toggle('active', this.tajweedMode);
        e.currentTarget.setAttribute('aria-pressed', this.tajweedMode);

        if (this.tajweedMode && !Object.keys(this.tajweed).length) {
          this.tajweed = await quranLoader.loadTajweed(this.currentPage) || {};
        }
        this.render();
        this.setupEvents();
      });

      // Reading Sliders toggle: adds/removes the per-line reveal sliders
      document.getElementById('sil-slider-toggle-btn')?.addEventListener('click', () => {
        this.sliderMode = !this.sliderMode;
        localStorage.setItem('pagemap-slider-mode', this.sliderMode ? '1' : '0');
        this.render();
        this.setupEvents();
      });

      // Per-line reading sliders: dragging right-to-left sweeps a reveal edge
      // across the line. The thumb's pixel position is the edge, so the word it
      // sits over is partially revealed (clipped from its right side) and words
      // to the right are fully shown — thumb and reveal edge stay aligned.
      this.container.querySelectorAll('.line-reveal-slider').forEach(slider => {
        let geo = this.measureSlider(slider);
        if (geo) slider.value = this.sliderValueFromState(geo);

        const remeasure = () => { geo = this.measureSlider(slider); };

        const apply = () => {
          if (!geo) remeasure();
          if (!geo) return;
          const f = (parseInt(slider.value, 10) || 0) / 1000;
          this.applySliderFraction(geo, f);
        };

        // Re-measure when the user grabs the slider (fonts/layout are settled by then)
        slider.addEventListener('pointerdown', remeasure);
        slider.addEventListener('input', apply);
        slider.addEventListener('change', () => {
          apply();
          this.saveRevealed();
          this.updateSilhouetteProgress();
        });
      });

      // Keep thumbs aligned as fonts finish loading, on the next frame, and on resize
      if (this._sliderResizeHandler) {
        window.removeEventListener('resize', this._sliderResizeHandler);
        this._sliderResizeHandler = null;
      }
      if (this.container.querySelector('.line-reveal-slider')) {
        this._sliderResizeHandler = () => this.syncLineSliders();
        window.addEventListener('resize', this._sliderResizeHandler);
        requestAnimationFrame(() => this.syncLineSliders());
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => this.syncLineSliders());
        }
      }

      // Position the sequential-mode hint on initial render
      this.updateSilhouetteProgress();
    }

    // Repetition counter panel (present whenever the silhouette is rendered)
    this.bindCounterPanel();

    // Recitation player bar (always docked while the page shows)
    this.bindPlayerBar();

    // View sheet: its button, close button and backdrop. The toggles inside it
    // keep the ids (and handlers) they had in the toolbar.
    document.getElementById('pagemap-view-btn')?.addEventListener('click', () => {
      this.setSheet('view', !this.viewOpen);
    });
    this.container.querySelectorAll('.pm-view-wrapper [data-sheet-close="view"]').forEach((el) => {
      el.addEventListener('click', () => this.closeSheets());
    });
    this.syncSheets();

    // Mushaf edition select event listener
    const editionSelect = document.getElementById('mushaf-edition-select');
    if (editionSelect) {
      editionSelect.addEventListener('change', (e) => {
        this.currentEdition = e.target.value;
        localStorage.setItem('mushaf-edition', this.currentEdition);

        // Reload layouts with selected edition
        this.loadPage(this.currentPage);
      });
    }
  }

  // Scroll to and flash a verse on the currently loaded page. Used when jumping
  // here from another module (e.g. Voice Finder) that located a specific ayah.
  // The caller invokes this after loadPage() has rendered the silhouette, so the
  // per-word verse-key elements already exist. The flash is purely visual and
  // doesn't touch persisted reveal state.
  highlightVerse(verseKey) {
    const words = this.container.querySelectorAll(`.mushaf-word-box[data-verse-key="${verseKey}"]`);
    if (words.length === 0) return;

    words[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    words.forEach(w => w.classList.add('verse-locate-flash'));
    setTimeout(() => {
      words.forEach(w => w.classList.remove('verse-locate-flash'));
    }, 3200);
  }

  getOrderedVerseKeys() {
    const keys = [];
    this.pageData.lines.forEach(lineObj => {
      lineObj.words.forEach(word => {
        if (word.verse_key && !keys.includes(word.verse_key)) {
          keys.push(word.verse_key);
        }
      });
    });
    return keys;
  }

  showContextMenu(target, clientX, clientY) {
    this.closeContextMenu();

    const isAyah = target.classList.contains('ayah-end-block');
    const isWord = target.classList.contains('mushaf-word-box') && !isAyah;
    let title = '';
    let optionsHtml = '';

    if (isWord) {
      const wordKey = target.dataset.key;
      const currentType = this.markedWords.get(wordKey);
      const translation = this.getWordTranslation(target);
      title = `Word Options`;
      const markButtons = MISTAKE_TYPES.map(({ type, label, cssVar }) => `
        <button class="context-menu-item mark-option ${currentType === type ? 'active' : ''}"
                style="color: var(${cssVar});" data-action="set-mark" data-value="${wordKey}" data-type="${type}">
          <span class="mark-swatch mark-swatch-${type}"></span>${label}${currentType === type ? ' ✓' : ''}
        </button>
      `).join('');
      optionsHtml = `
        ${translation ? `<div class="context-menu-translation">${translation}</div>` : ''}
        ${markButtons}
        ${currentType ? `<button class="context-menu-item" data-action="unmark" data-value="${wordKey}">Unmark Word</button>` : ''}
      `;
    } else if (isAyah) {
      const verseKey = target.dataset.verseKey;
      if (!verseKey) return;
      
      const [surahNum, ayahNum] = verseKey.split(':');
      title = `Ayah ${ayahNum}`;

      // The audio item follows the player: Pause while this ayah plays,
      // Continue when it's paused part-way, otherwise Play.
      const s = this.player.getState();
      const isLoaded = s.key === verseKey && s.status !== 'idle';
      const isActive = isLoaded && (s.status === 'playing' || s.status === 'loading' || s.status === 'gap');
      const canContinue = isLoaded && s.status === 'paused' && s.position > 0;
      const audioStyle = 'style="color: var(--accent-gold); font-weight: bold;"';
      const audioItem = isActive
        ? `<button class="context-menu-item" ${audioStyle} data-action="pause-audio" data-value="${verseKey}">❚❚ Pause</button>`
        : `<button class="context-menu-item" ${audioStyle} data-action="play-audio" data-value="${verseKey}">▶ ${canContinue ? 'Continue' : 'Play Ayah Audio'}</button>`;
      const replayItem = isLoaded && s.status !== 'error' && (s.position > 0 || s.status === 'ended')
        ? `<button class="context-menu-item" data-action="replay-audio" data-value="${verseKey}">↺ Replay from the start</button>`
        : '';

      optionsHtml = `
        ${audioItem}
        ${replayItem}
        <button class="context-menu-item" data-action="reveal-verse" data-value="${verseKey}">Unhide Ayah ${ayahNum}</button>
        <button class="context-menu-item" data-action="hide-verse" data-value="${verseKey}">Hide Ayah ${ayahNum}</button>
        <button class="context-menu-item" data-action="reveal-before" data-value="${verseKey}">Unhide Ayahs Before</button>
        <button class="context-menu-item" data-action="hide-before" data-value="${verseKey}">Hide Ayahs Before</button>
        <button class="context-menu-item" data-action="reveal-after" data-value="${verseKey}">Unhide Ayahs After</button>
        <button class="context-menu-item" data-action="hide-after" data-value="${verseKey}">Hide Ayahs After</button>
      `;
    } else {
      const lineEl = target.closest('.mushaf-line');
      if (!lineEl) return;
      const lineNum = parseInt(lineEl.dataset.line);
      title = `Line ${lineNum}`;
      
      optionsHtml = `
        <button class="context-menu-item" data-action="reveal-line" data-value="${lineNum}">Unhide Line ${lineNum}</button>
        <button class="context-menu-item" data-action="hide-line" data-value="${lineNum}">Hide Line ${lineNum}</button>
        <button class="context-menu-item" data-action="reveal-lines-before" data-value="${lineNum}">Unhide Lines Before</button>
        <button class="context-menu-item" data-action="hide-lines-before" data-value="${lineNum}">Hide Lines Before</button>
        <button class="context-menu-item" data-action="reveal-lines-after" data-value="${lineNum}">Unhide Lines After</button>
        <button class="context-menu-item" data-action="hide-lines-after" data-value="${lineNum}">Hide Lines After</button>
      `;
    }

    const menu = document.createElement('div');
    menu.id = 'mushaf-context-menu';
    menu.className = 'mushaf-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    menu.style.zIndex = '9999';
    menu.style.padding = '8px';
    menu.style.minWidth = '180px';
    menu.style.display = 'flex';
    menu.style.flexDirection = 'column';
    menu.style.gap = '4px';
    
    menu.innerHTML = `
      <div style="font-size: 0.8rem; font-weight: bold; color: var(--accent-gold); padding: 4px 8px 8px 8px; border-bottom: 1px solid var(--border-color); margin-bottom: 4px; text-align: center;">
        ${title}
      </div>
      ${optionsHtml}
    `;

    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
    if (rect.left < 0) {
      menu.style.left = `10px`;
    }
    if (rect.top < 0) {
      menu.style.top = `10px`;
    }

    // Close on a tap outside or on Esc. closeContextMenu() removes these again.
    const outsideClickListener = (e) => {
      if (!menu.contains(e.target)) this.closeContextMenu();
    };
    const escListener = (e) => {
      if (e.key === 'Escape') this.closeContextMenu();
    };
    document.addEventListener('keydown', escListener);
    const listenTimer = setTimeout(() => {
      document.addEventListener('mousedown', outsideClickListener);
      document.addEventListener('touchstart', outsideClickListener);
    }, 10);
    this._menuCleanup = () => {
      clearTimeout(listenTimer);
      document.removeEventListener('keydown', escListener);
      document.removeEventListener('mousedown', outsideClickListener);
      document.removeEventListener('touchstart', outsideClickListener);
    };

    menu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const action = item.dataset.action;
        const val = item.dataset.value;
        this.executeContextMenuAction(action, val, item.dataset.type);
        this.closeContextMenu();
      });
    });
  }

  closeContextMenu() {
    this._menuCleanup?.();
    this._menuCleanup = null;
    const existing = document.getElementById('mushaf-context-menu');
    if (existing) {
      existing.remove();
    }
  }

  // Collect word-box elements for a range of verse keys (before/after a given verse)
  _wordsForVerseRange(pivotKey, direction) {
    const keys = this.getOrderedVerseKeys();
    const index = keys.indexOf(pivotKey);
    if (index === -1) return [];
    const rangeKeys = direction === 'before' ? keys.slice(0, index) : keys.slice(index + 1);
    const elements = [];
    rangeKeys.forEach(k => {
      this.container.querySelectorAll(`.mushaf-word-box[data-verse-key="${k}"]`).forEach(w => elements.push(w));
    });
    return elements;
  }

  _wordsForLineRange(from, to) {
    const elements = [];
    for (let l = from; l <= to; l++) {
      const lineEl = this.container.querySelector(`.mushaf-line[data-line="${l}"]`);
      if (lineEl) {
        lineEl.querySelectorAll('.mushaf-word-box').forEach(w => elements.push(w));
      }
    }
    return elements;
  }

  executeContextMenuAction(action, value, type) {
    const p = this.player;
    if (action === 'play-audio') {
      // Continue the loaded ayah where it paused, or start this one
      if (p.key === value && p.status !== 'idle') p.play();
      else p.select(value, { play: true });
    } else if (action === 'pause-audio') {
      if (p.key === value) p.pause();
    } else if (action === 'replay-audio') {
      if (p.key === value) {
        p.seek(0);
        if (!p.isActive) p.play();
      }
    } else if (action === 'reveal-verse' || action === 'hide-verse') {
      const words = Array.from(this.container.querySelectorAll(`.mushaf-word-box[data-verse-key="${value}"]`));
      this.setRevealedForElements(words, action === 'reveal-verse');
    } else if (action === 'reveal-before' || action === 'hide-before') {
      this.setRevealedForElements(this._wordsForVerseRange(value, 'before'), action === 'reveal-before');
    } else if (action === 'reveal-after' || action === 'hide-after') {
      this.setRevealedForElements(this._wordsForVerseRange(value, 'after'), action === 'reveal-after');
    } else if (action === 'reveal-line' || action === 'hide-line') {
      const lineNum = parseInt(value);
      this.setRevealedForElements(this._wordsForLineRange(lineNum, lineNum), action === 'reveal-line');
    } else if (action === 'reveal-lines-before' || action === 'hide-lines-before') {
      this.setRevealedForElements(this._wordsForLineRange(1, parseInt(value) - 1), action === 'reveal-lines-before');
    } else if (action === 'reveal-lines-after' || action === 'hide-lines-after') {
      this.setRevealedForElements(this._wordsForLineRange(parseInt(value) + 1, 15), action === 'reveal-lines-after');
    } else if (action === 'set-mark' || action === 'unmark') {
      const wordEl = this.container.querySelector(`.mushaf-word-box[data-key="${value}"]`);
      const currentType = this.markedWords.get(value);
      if (currentType && wordEl) {
        wordEl.classList.remove(`marked-${currentType}`);
      }

      // Re-selecting the active type acts as a toggle-off, same as Unmark
      if (action === 'unmark' || currentType === type) {
        this.markedWords.delete(value);
      } else {
        this.markedWords.set(value, type);
        if (wordEl) {
          wordEl.classList.add(`marked-${type}`);
        }
      }
      db.saveProgress(`pagemap-marked-${this.currentPage}`, Array.from(this.markedWords.entries()));
    }
  }
}

