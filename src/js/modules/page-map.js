// Quran Firm Plant - Visual Mushaf Page Map Module
// Renders page grids, silhouettes, and cross-line transitions to build visual memory.

import { db } from '../data/db.js';
import { quranLoader } from '../data/loader.js';
import { audioPlayer } from '../components/audio-player.js';

const STORAGE_KEY_LAST_PAGE = 'pagemap-last-page';
const STORAGE_KEY_HISTORY = 'pagemap-page-history';
const MAX_HISTORY_ITEMS = 30;

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

    // Selected mushaf edition (v1 or v2)
    this.currentEdition = localStorage.getItem('mushaf-edition') || 'v2';
    
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

      const [pageData, wordTranslations] = await Promise.all([
        quranLoader.loadPage(pageNumber, this.currentEdition),
        quranLoader.loadWordTranslations(pageNumber)
      ]);
      this.pageData = pageData;
      this.wordTranslations = wordTranslations || {};
      if (!this.pageData) {
        throw new Error('Failed to load layout from CDN or cache');
      }

      this.processPageWords();
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
    
    this.container.innerHTML = `
      <!-- Single toolbar: reveal mode (left) + view toggles & page actions (right) -->
      <div class="blank-page-controls" style="margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div class="toolbar-group" style="gap: 8px;">
          <div class="seg-control" role="group" aria-label="Reveal mode">
            <button class="seg-btn study-mode-btn ${this.studyMode === 'free' ? 'active' : ''}" data-study-mode="free">Free reveal</button>
            <button class="seg-btn study-mode-btn ${this.studyMode === 'sequential' ? 'active' : ''}" data-study-mode="sequential">Next word guide</button>
            <button class="seg-btn study-mode-btn ${this.studyMode === 'first-word' ? 'active' : ''}" data-study-mode="first-word">First word anchors</button>
          </div>
          <button id="sil-reveal-next-btn" class="btn-quiet" ${this.studyMode !== 'sequential' ? 'style="display:none;"' : ''}>Reveal next word →</button>
        </div>

        <div class="toolbar-group" style="gap: 8px; align-items: center;">
          <div class="seg-control" role="group" aria-label="View options">
            <button id="sil-slider-toggle-btn" class="seg-btn toggle-btn ${this.sliderMode ? 'active' : ''}" title="Show a per-line slider that sweeps words visible as you read" aria-pressed="${this.sliderMode}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="21" y1="6" x2="14" y2="6"/><line x1="10" y1="6" x2="3" y2="6"/>
                <line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="18" x2="16" y2="18"/><line x1="12" y1="18" x2="3" y2="18"/>
                <line x1="14" y1="4" x2="14" y2="8"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="16" x2="16" y2="20"/>
              </svg>
              Sliders
            </button>
            <button id="sil-gloss-toggle-btn" class="seg-btn toggle-btn ${this.showGlosses ? 'active' : ''}" title="Briefly pop up the English translation whenever a word is revealed" aria-pressed="${this.showGlosses}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/>
                <path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>
              </svg>
              Translations
            </button>
          </div>

          <!-- Write This Page Button -->
          <button id="pagemap-write-btn" class="btn-gold" style="display: flex; align-items: center; gap: 5px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            Write Page ${this.currentPage}
          </button>

          <!-- Page History Toggle (icon-only; label lives in the tooltip) -->
          <div class="pagemap-history-wrapper">
            <button id="pagemap-history-btn" class="btn-outline ${this.showHistory ? 'active' : ''}" title="Page history" aria-label="Page history" style="display: flex; align-items: center; position: relative; padding: 10px 12px;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
                  ${hasHistory ? history.map((entry, i) => {
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

          <select id="mushaf-edition-select" class="selector-input" title="Mushaf edition" style="padding: 6px 12px; font-size: 0.85rem; background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-secondary); border-radius: 4px; cursor: pointer; margin-bottom: 0;">
            <option value="v2" ${this.currentEdition === 'v2' ? 'selected' : ''}>Madinah V2 (Standard)</option>
            <option value="v1" ${this.currentEdition === 'v1' ? 'selected' : ''}>Madinah V1 (Classic 1405 AH)</option>
          </select>
        </div>
      </div>

      <!-- Main Display: silhouette (left/center) + repetition counter panel (right) -->
      <div class="pagemap-layout">
        <div id="pagemap-content-area" style="display: flex; flex-direction: column; align-items: center; flex: 1 1 auto; min-width: 0;">
          ${this.renderSilhouette()}
        </div>
        <aside id="pagemap-counter-panel" class="rep-panel">
          ${this.renderCounterPanelInner()}
        </aside>
      </div>
    `;
  }

  // Index the page's words in reading order and find each ayah's first word on this page.
  processPageWords() {
    this.wordSequence = [];
    this.firstWordAnchors = new Set();
    const seenVerses = new Set();

    this.pageData.lines.forEach(lineObj => {
      lineObj.words.forEach((word, idx) => {
        if (word.type !== 'word') return;
        const key = `silhouette-${this.currentPage}-${lineObj.line}-${idx}`;
        this.wordSequence.push(key);
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

    const sessionRows = Object.keys(stats.sessions)
      .sort((a, b) => b.localeCompare(a))
      .map(date => `<div class="rep-history-row"><span>${this._formatSessionDate(date)}</span><span class="rep-history-count">${stats.sessions[date]}×</span></div>`)
      .join('');

    const recentRows = this.getPageTargets()
      .map(e => `
        <div class="rep-recent-row ${e.key === t.key ? 'active' : ''}" data-rep-target="${e.key}" title="Click to select and continue counting">
          <span class="rep-recent-label">${e.label}</span>
          <span class="rep-recent-total">${e.total}×</span>
          <button class="rep-recent-delete" data-rep-delete="${e.key}" title="Delete saved history for ${e.label}">×</button>
        </div>`)
      .join('');

    const disabled = t.valid ? '' : 'disabled';
    const saveDisabled = (t.valid && live > 0) ? '' : 'disabled';

    return `
      <div class="rep-panel-head">
        <span class="rep-panel-title">Repetition Counter</span>
      </div>

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
      <div class="rep-count-hint">${t.valid ? 'reps this session' : t.label}</div>

      <div class="rep-actions">
        <button class="btn-gold" id="rep-save" ${saveDisabled}>Save</button>
        <button class="btn-outline" id="rep-reset" ${saveDisabled}>Reset</button>
      </div>

      <div class="rep-stats">
        <span>Today: <strong id="rep-today">${todayShown}</strong></span>
        <span>Total: <strong id="rep-total">${totalShown}</strong></span>
      </div>

      <div class="rep-history-head">
        <span>Recent on this page</span>
      </div>
      <div class="rep-recent" id="rep-recent">
        ${recentRows || `<div class="rep-history-empty">No saved targets yet</div>`}
      </div>

      <div class="rep-history-head">
        <span>History</span>
        ${stats.total > 0 ? `<button class="rep-clear" id="rep-clear" title="Clear saved history for this target">Clear</button>` : ''}
      </div>
      <div class="rep-history" id="rep-history">
        ${sessionRows || `<div class="rep-history-empty">No saved reps yet</div>`}
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
      if (t.valid && confirm(`Clear all saved repetition history for ${t.label}?`)) {
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
        if (confirm(`Delete all saved repetition history for ${label}?`)) {
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

  updateSilhouetteProgress() {
    const total = this.wordSequence.length;
    const revealed = this.revealedWords.size;
    const pct = total ? Math.round((revealed / total) * 100) : 0;

    const bar = document.getElementById('sil-progress-bar');
    if (bar) bar.style.width = `${pct}%`;
    const text = document.getElementById('sil-progress-text');
    if (text) text.innerText = `Revealed: ${revealed} / ${total} words (${pct}%)`;

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

    let fontStyles = '';
    fonts.forEach(fontName => {
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
          wordsHtml += `
            <span class="mushaf-word-box ${markType ? `marked-${markType}` : ''} ${isShown ? 'revealed' : ''}"
                  data-key="${wordKey}"
                  data-verse-key="${word.verse_key || ''}"
                  data-position="${word.position || ''}"
                  data-text="${word.text}"
                  style="font-family: '${word.font}'; font-size: clamp(1.1rem, 4vw, 1.65rem); line-height: 1; flex-shrink: 1;">
              <span class="word-glyph">${word.char}</span>
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
      <div style="width: 100%; max-width: 700px; margin: 0 auto 14px;">
        <div class="progress-bar-container" style="margin-bottom: 4px;">
          <div id="sil-progress-bar" class="progress-bar" style="width: ${pct}%"></div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <span id="sil-progress-text" style="font-size: 0.85rem; color: var(--text-secondary);">
            Revealed: ${revealed} / ${total} words (${pct}%)
          </span>
          <span style="display: flex; gap: 6px;">
            <button id="sil-show-all-btn" class="btn-quiet">Show all</button>
            <button id="sil-hide-all-btn" class="btn-quiet">Hide all</button>
          </span>
        </div>
      </div>
      <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 12px;">Tap blocks to reveal words. Long-press a word to mark it, or an ayah circle for ayah options & audio.</p>
      <div class="mushaf-page-container">
        <div class="mushaf-page-grid">
          ${linesHtml}
        </div>
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
          const verseKey = box.dataset.verseKey;
          if (verseKey) {
            const verseWords = Array.from(this.container.querySelectorAll(`.mushaf-word-box[data-verse-key="${verseKey}"]`))
              .filter(w => !w.classList.contains('ayah-end-block'));
            const allRevealed = verseWords.every(w => w.dataset.key && this.revealedWords.has(w.dataset.key));
            this.setRevealedForElements(verseWords, !allRevealed);
          }
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

      optionsHtml = `
        <button class="context-menu-item" style="color: var(--accent-gold); font-weight: bold;" data-action="play-audio" data-value="${verseKey}">▶ Play Ayah Audio</button>
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

    const outsideClickListener = (e) => {
      if (!menu.contains(e.target)) {
        this.closeContextMenu();
        document.removeEventListener('mousedown', outsideClickListener);
        document.removeEventListener('touchstart', outsideClickListener);
      }
    };
    
    setTimeout(() => {
      document.addEventListener('mousedown', outsideClickListener);
      document.addEventListener('touchstart', outsideClickListener);
    }, 10);

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

  async playAyahAudio(verseKey) {
    const [surahNum, ayahNum] = verseKey.split(':').map(Number);
    const ayah = await db.getAyah(surahNum, ayahNum);
    if (!ayah) return;

    audioPlayer.playGlobalVerse(ayah.globalId, verseKey);

    const marker = this.container.querySelector(`.ayah-end-block[data-verse-key="${verseKey}"]`);
    if (marker) {
      audioPlayer.onPlay((key) => {
        if (key === verseKey) marker.classList.add('playing');
      });
      const clear = (key) => {
        if (key === verseKey) marker.classList.remove('playing');
      };
      audioPlayer.onEnded(clear);
      audioPlayer.onPause(clear);
    }
  }

  executeContextMenuAction(action, value, type) {
    if (action === 'play-audio') {
      this.playAyahAudio(value);
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

