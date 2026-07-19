// Quran Firm Plant - Memorization Tracker Module
// Records which verses the user has memorized or is currently memorizing,
// shows per-surah and whole-Quran progress, and joins in the repetition
// counts saved by the Page Map's repetition counter (verse-mode entries).

import { db } from '../data/db.js';
import { quranLoader } from '../data/loader.js';
import { SURAH_LIST } from '../components/surah-selector.js';

// Fixed total for the Hafs mushaf; equals the sum of all 114 surah verse counts.
export const TOTAL_QURAN_VERSES = 6236;

const STATUS_LABELS = { none: 'Not started', memorizing: 'Memorizing', memorized: 'Memorized' };

export class MemorizationModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);

    this.data = null;            // Map<surahNum, { surah, totalAyahs, verses: { ayah: {status, date} } }>
    this.repIndex = null;        // Map<"surah:ayah", { total, today }>
    this.view = 'overview';      // 'overview' | 'memorizing' | 'memorized'
    this.expandedSurah = null;   // surah number whose verse list is open
    this.surahTextCache = new Map(); // surah -> sorted ayah records from the text store
    this.pickerOpen = false;
    this.pickerSelected = new Set(); // surah numbers ticked for bulk marking
    this.pickerAnchor = null;        // last ticked surah, for shift-click ranges
    this.applying = false;           // guards against repeated bulk-apply clicks
    this.rangeError = null;
  }

  // The header surah selector doesn't scope this module; ignore changes.
  loadSurah() {}

  _todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  daysSince(dateStr) {
    const then = new Date(dateStr + 'T00:00:00');
    return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
  }

  formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // --- Data ---

  async loadData() {
    // Older databases were seeded without English translations; backfill once
    // so the verse rows can show them. Non-fatal if offline.
    try {
      await quranLoader.ensureTranslations();
    } catch (e) {
      console.warn('Could not backfill translations (offline?):', e);
    }

    const entries = await db.getProgressByPrefix('memorization-');
    this.data = new Map();
    entries.forEach(({ value }) => {
      if (value && value.surah) this.data.set(value.surah, value);
    });
    this.buildRepIndex(await db.getProgress('repetition-history'));
  }

  // Only verse-mode counter entries map cleanly onto single verses; page- and
  // group-mode repetitions would need page->verse expansion and are not shown.
  buildRepIndex(repHistory) {
    this.repIndex = new Map();
    if (!repHistory) return;
    const today = this._todayStr();
    Object.entries(repHistory).forEach(([key, entry]) => {
      const m = key.match(/^verse-(\d+):(\d+)$/);
      if (!m || !entry?.sessions) return;
      const total = Object.values(entry.sessions).reduce((s, n) => s + n, 0);
      this.repIndex.set(`${m[1]}:${m[2]}`, { total, today: entry.sessions[today] || 0 });
    });
  }

  async getSurahTextCached(surahNum) {
    if (!this.surahTextCache.has(surahNum)) {
      this.surahTextCache.set(surahNum, await db.getSurahText(surahNum));
    }
    return this.surahTextCache.get(surahNum);
  }

  // Load any uncached surahs in one DB pass. Much cheaper than awaiting
  // getSurahTextCached in a loop, which rescans the whole text store each time.
  async primeSurahTextCache(surahNums) {
    const missing = surahNums.filter(n => !this.surahTextCache.has(n));
    if (missing.length === 0) return;
    const fetched = await db.getSurahTexts(missing);
    fetched.forEach((ayahs, num) => this.surahTextCache.set(num, ayahs));
  }

  surahMeta(surahNum) {
    return SURAH_LIST.find(s => s.id === surahNum);
  }

  getStatus(surahNum, ayah) {
    return this.data.get(surahNum)?.verses?.[ayah]?.status || 'none';
  }

  // Bulk status write: one record put (or delete) per call. Verses already in
  // the requested status keep their original date, so re-applying a range
  // doesn't reset "started memorizing" ages.
  async setRangeStatus(surahNum, from, to, status) {
    let record = this.data.get(surahNum);
    if (!record) {
      const ayahs = await this.getSurahTextCached(surahNum);
      record = { surah: surahNum, totalAyahs: ayahs.length, verses: {} };
    }
    const today = this._todayStr();
    for (let a = from; a <= to; a++) {
      if (status === 'none') {
        delete record.verses[a];
      } else if (record.verses[a]?.status !== status) {
        record.verses[a] = { status, date: today };
      }
    }
    if (Object.keys(record.verses).length === 0) {
      this.data.delete(surahNum);
      await db.deleteProgress(`memorization-${surahNum}`);
    } else {
      this.data.set(surahNum, record);
      await db.saveProgress(`memorization-${surahNum}`, record);
    }
  }

  async setVerseStatus(surahNum, ayah, status) {
    await this.setRangeStatus(surahNum, ayah, ayah, status);
  }

  computeStats() {
    let memorized = 0;
    let memorizing = 0;
    const bySurah = [];
    [...this.data.values()].sort((a, b) => a.surah - b.surah).forEach(rec => {
      let m = 0, w = 0;
      Object.values(rec.verses).forEach(v => {
        if (v.status === 'memorized') m++;
        else if (v.status === 'memorizing') w++;
      });
      memorized += m;
      memorizing += w;
      bySurah.push({ surah: rec.surah, memorized: m, memorizing: w, total: rec.totalAyahs });
    });
    return { memorized, memorizing, bySurah, globalPct: (memorized / TOTAL_QURAN_VERSES) * 100 };
  }

  // --- Rendering ---

  async render() {
    if (!this.data) {
      this.container.innerHTML = `
        <div style="display: flex; justify-content: center; align-items: center; height: 200px;">
          <div class="status-indicator">
            <span class="status-dot animate-pulse" style="background-color: var(--accent-gold);"></span>
            <span>Loading your memorization record...</span>
          </div>
        </div>
      `;
      await this.loadData();
    }

    // Preload verse text needed by the active view before building HTML.
    if (this.view === 'memorizing') {
      const needed = [...this.data.values()]
        .filter(rec => Object.values(rec.verses).some(v => v.status === 'memorizing'))
        .map(rec => rec.surah);
      await this.primeSurahTextCache(needed);
    } else if (this.expandedSurah != null) {
      await this.getSurahTextCached(this.expandedSurah);
    }

    const stats = this.computeStats();
    const body = this.view === 'memorizing' ? this.renderMemorizing(stats)
      : this.view === 'memorized' ? this.renderMemorized(stats)
      : this.renderOverview(stats);

    this.container.innerHTML = `
      <div class="memo-root">
        <div class="memo-tabs">
          <button class="btn-outline ${this.view === 'overview' ? 'memo-tab-active' : ''}" data-action="tab" data-view="overview">Overview</button>
          <button class="btn-outline ${this.view === 'memorizing' ? 'memo-tab-active' : ''}" data-action="tab" data-view="memorizing">
            Currently Memorizing${stats.memorizing ? ` <span class="memo-tab-badge">${stats.memorizing}</span>` : ''}
          </button>
          <button class="btn-outline ${this.view === 'memorized' ? 'memo-tab-active' : ''}" data-action="tab" data-view="memorized">
            Memorized${stats.memorized ? ` <span class="memo-tab-badge">${stats.memorized}</span>` : ''}
          </button>
        </div>
        ${body}
        ${this.pickerOpen ? this.renderPicker() : ''}
      </div>
    `;

    this.bindEvents();
  }

  renderOverview(stats) {
    const statCards = `
      <div class="memo-stats-row">
        <div class="memo-stat-card">
          <span class="memo-stat-count">${stats.globalPct < 10 ? stats.globalPct.toFixed(2) : stats.globalPct.toFixed(1)}%</span>
          <span class="memo-stat-label">of the Quran memorized</span>
        </div>
        <div class="memo-stat-card">
          <span class="memo-stat-count">${stats.memorized}</span>
          <span class="memo-stat-label">verses memorized</span>
        </div>
        <div class="memo-stat-card">
          <span class="memo-stat-count">${stats.memorizing}</span>
          <span class="memo-stat-label">verses in progress</span>
        </div>
        <div class="memo-stat-card">
          <span class="memo-stat-count">${stats.bySurah.length}</span>
          <span class="memo-stat-label">surahs started</span>
        </div>
      </div>
    `;

    // Surahs with saved progress, plus a freshly picked (still empty) surah.
    const surahNums = stats.bySurah.map(s => s.surah);
    if (this.expandedSurah != null && !surahNums.includes(this.expandedSurah)) {
      surahNums.push(this.expandedSurah);
      surahNums.sort((a, b) => a - b);
    }

    let listHtml = surahNums.map(n => this.renderSurahCard(n, stats)).join('');
    if (!listHtml) {
      listHtml = `
        <div class="card" style="text-align: center; padding: 48px; max-width: 640px; margin: 0 auto;">
          <h3 style="color: var(--accent-gold); margin-bottom: 12px;">Nothing tracked yet</h3>
          <p style="color: var(--text-secondary); line-height: 1.7;">
            Add a surah and mark the verses you have memorized or are working on.<br>
            Your progress across the whole Quran will show up here.
          </p>
        </div>
      `;
    }

    return `
      ${statCards}
      <div class="blank-page-controls">
        <button class="btn-gold" data-action="open-picker">+ Add Surah</button>
      </div>
      ${listHtml}
    `;
  }

  renderSurahCard(surahNum, stats) {
    const meta = this.surahMeta(surahNum);
    const s = stats.bySurah.find(x => x.surah === surahNum);
    const record = this.data.get(surahNum);
    const total = s?.total ?? record?.totalAyahs ?? this.surahTextCache.get(surahNum)?.length ?? 0;
    const memorized = s?.memorized ?? 0;
    const memorizing = s?.memorizing ?? 0;
    const pct = total ? (memorized / total) * 100 : 0;
    const wPct = total ? (memorizing / total) * 100 : 0;
    const expanded = this.expandedSurah === surahNum;

    return `
      <div class="card memo-surah-card ${expanded ? 'expanded' : ''}">
        <button class="memo-surah-header" data-action="expand-surah" data-surah="${surahNum}">
          <span class="memo-surah-names">
            <span class="quran-text memo-surah-arabic">${meta?.name || ''}</span>
            <span class="memo-surah-en">${surahNum}. ${meta?.nameEn || `Surah ${surahNum}`}</span>
          </span>
          <span class="memo-surah-counts">${memorized} / ${total} memorized${memorizing ? ` · ${memorizing} in progress` : ''}</span>
          <span class="memo-surah-pct">${Math.round(pct)}%</span>
          <span class="memo-expand-chevron">${expanded ? '▾' : '▸'}</span>
        </button>
        <div class="memo-bar">
          <span class="memo-bar-done" style="width: ${pct}%"></span>
          <span class="memo-bar-working" style="width: ${wPct}%"></span>
        </div>
        ${expanded ? this.renderExpandedSurah(surahNum, total) : ''}
      </div>
    `;
  }

  renderExpandedSurah(surahNum, total) {
    const ayahs = this.surahTextCache.get(surahNum) || [];
    const rows = ayahs.map(a => this.renderVerseRow(surahNum, a)).join('');

    return `
      <div class="memo-range-form">
        <label>Verses</label>
        <input type="number" class="memo-range-input" id="memo-range-from" min="1" max="${total}" value="1" aria-label="From verse">
        <span>–</span>
        <input type="number" class="memo-range-input" id="memo-range-to" min="1" max="${total}" value="${total}" aria-label="To verse">
        <select id="memo-range-status" class="memo-range-select">
          <option value="memorized">Memorized</option>
          <option value="memorizing">Memorizing</option>
          <option value="none">Not started</option>
        </select>
        <button class="btn-gold" data-action="apply-range" data-surah="${surahNum}">Apply</button>
        <button class="btn-outline" data-action="whole-surah" data-surah="${surahNum}">Whole surah</button>
        ${this.rangeError ? `<span class="memo-range-error">${this.rangeError}</span>` : ''}
      </div>
      <div class="memo-verse-list">${rows}</div>
    `;
  }

  renderVerseRow(surahNum, ayahData) {
    const ayah = ayahData.ayah;
    const entry = this.data.get(surahNum)?.verses?.[ayah];
    const status = entry?.status || 'none';
    const rep = this.repIndex.get(`${surahNum}:${ayah}`);

    const dateLine = entry
      ? `<span class="memo-status-date">${this.formatDate(entry.date)}${status === 'memorizing' ? ` · ${this.daysLabel(entry.date)}` : ''}</span>`
      : '';

    return `
      <div class="memo-verse-row">
        <span class="memo-verse-num">${ayah}</span>
        <span class="memo-verse-texts">
          <span class="memo-verse-arabic" dir="rtl">${ayahData.text || ''}</span>
          <span class="memo-verse-translation">${ayahData.translation || ''}</span>
        </span>
        ${rep?.total ? `<span class="memo-rep-badge" title="Repetitions saved on the Page Map counter">${rep.total}×${rep.today ? ` · ${rep.today} today` : ''}</span>` : ''}
        <span class="memo-status-col">
          ${this.renderStatusPicker(surahNum, ayah, status)}
          ${dateLine}
        </span>
      </div>
    `;
  }

  // Status chip + drop-down. Picking a status directly beats cycling through
  // the other two to reach it.
  renderStatusPicker(surahNum, ayah, status) {
    const options = ['memorized', 'memorizing', 'none'].map(s => `
      <button class="memo-status-option is-${s} ${s === status ? 'current' : ''}" role="menuitem"
              data-action="set-status" data-surah="${surahNum}" data-ayah="${ayah}" data-status="${s}">
        <span class="memo-status-swatch is-${s}"></span>${STATUS_LABELS[s]}
      </button>
    `).join('');

    return `
      <span class="memo-status-wrap">
        <button class="memo-status-btn is-${status}" data-action="open-status-menu"
                aria-haspopup="menu" aria-expanded="false" title="Change status">
          ${STATUS_LABELS[status]}<span class="memo-status-caret" aria-hidden="true">▾</span>
        </button>
        <span class="memo-status-menu" role="menu">${options}</span>
      </span>
    `;
  }

  daysLabel(dateStr) {
    const d = this.daysSince(dateStr);
    return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
  }

  renderMemorizing(stats) {
    const items = [];
    this.data.forEach(rec => {
      Object.entries(rec.verses).forEach(([ayah, v]) => {
        if (v.status === 'memorizing') items.push({ surah: rec.surah, ayah: parseInt(ayah), date: v.date });
      });
    });
    // Oldest first — the verses that have been "in progress" longest on top.
    items.sort((a, b) => a.date === b.date ? (a.surah - b.surah || a.ayah - b.ayah) : a.date.localeCompare(b.date));

    if (items.length === 0) {
      return `
        <div class="card" style="text-align: center; padding: 48px; max-width: 640px; margin: 0 auto;">
          <h3 style="color: var(--accent-gold); margin-bottom: 12px;">Nothing in progress</h3>
          <p style="color: var(--text-secondary); line-height: 1.7;">
            Verses you mark as <strong>Memorizing</strong> in the Overview appear here,
            with how long you've been working on each.
          </p>
        </div>
      `;
    }

    const rows = items.map(({ surah, ayah, date }) => {
      const meta = this.surahMeta(surah);
      const ayahData = (this.surahTextCache.get(surah) || []).find(a => a.ayah === ayah);
      const rep = this.repIndex.get(`${surah}:${ayah}`);
      return `
        <div class="memo-verse-row memo-verse-jump" data-action="jump-verse" data-surah="${surah}" data-ayah="${ayah}"
             title="Jump to this verse on the Visual Page Map">
          <span class="memo-verse-num memo-verse-ref">${meta?.nameEn || 'Surah'} ${surah}:${ayah}</span>
          <span class="memo-verse-texts">
            <span class="memo-verse-arabic" dir="rtl">${ayahData?.text || ''}</span>
            <span class="memo-verse-translation">${ayahData?.translation || ''}</span>
          </span>
          <span class="memo-status-col">
            <span class="memo-status-date">Started ${this.formatDate(date)} · ${this.daysLabel(date)}</span>
            ${rep?.total ? `<span class="memo-rep-badge">${rep.total}×${rep.today ? ` · ${rep.today} today` : ''}</span>` : ''}
          </span>
          <button class="btn-gold memo-mark-btn" data-action="mark-memorized" data-surah="${surah}" data-ayah="${ayah}">Mark memorized</button>
        </div>
      `;
    }).join('');

    return `<div class="card" style="padding: 16px 20px;">${rows}</div>`;
  }

  // Memorized view: one collapsible card per surah that has any fully-memorized
  // verses, listing only those verses. Clicking a verse jumps to the Page Map.
  renderMemorized(stats) {
    const surahs = stats.bySurah.filter(s => s.memorized > 0);

    if (surahs.length === 0) {
      return `
        <div class="card" style="text-align: center; padding: 48px; max-width: 640px; margin: 0 auto;">
          <h3 style="color: var(--accent-gold); margin-bottom: 12px;">Nothing memorized yet</h3>
          <p style="color: var(--text-secondary); line-height: 1.7;">
            Verses you mark as <strong>Memorized</strong> in the Overview appear here,
            grouped by surah. Click any verse to see it on the Visual Page Map.
          </p>
        </div>
      `;
    }

    return surahs.map(s => this.renderMemorizedSurahCard(s)).join('');
  }

  renderMemorizedSurahCard(s) {
    const surahNum = s.surah;
    const meta = this.surahMeta(surahNum);
    const total = s.total || 0;
    const pct = total ? (s.memorized / total) * 100 : 0;
    const expanded = this.expandedSurah === surahNum;

    return `
      <div class="card memo-surah-card ${expanded ? 'expanded' : ''}">
        <button class="memo-surah-header" data-action="expand-surah" data-surah="${surahNum}">
          <span class="memo-surah-names">
            <span class="quran-text memo-surah-arabic">${meta?.name || ''}</span>
            <span class="memo-surah-en">${surahNum}. ${meta?.nameEn || `Surah ${surahNum}`}</span>
          </span>
          <span class="memo-surah-counts">${s.memorized} / ${total} memorized</span>
          <span class="memo-surah-pct">${Math.round(pct)}%</span>
          <span class="memo-expand-chevron">${expanded ? '▾' : '▸'}</span>
        </button>
        <div class="memo-bar">
          <span class="memo-bar-done" style="width: ${pct}%"></span>
        </div>
        ${expanded ? this.renderMemorizedVerses(surahNum) : ''}
      </div>
    `;
  }

  renderMemorizedVerses(surahNum) {
    const record = this.data.get(surahNum);
    const ayahs = this.surahTextCache.get(surahNum) || [];
    const rows = ayahs
      .filter(a => record?.verses?.[a.ayah]?.status === 'memorized')
      .map(a => {
        const entry = record.verses[a.ayah];
        const rep = this.repIndex.get(`${surahNum}:${a.ayah}`);
        return `
          <div class="memo-verse-row memo-verse-jump" data-action="jump-verse" data-surah="${surahNum}" data-ayah="${a.ayah}"
               title="Jump to this verse on the Visual Page Map">
            <span class="memo-verse-num">${a.ayah}</span>
            <span class="memo-verse-texts">
              <span class="memo-verse-arabic" dir="rtl">${a.text || ''}</span>
              <span class="memo-verse-translation">${a.translation || ''}</span>
            </span>
            ${rep?.total ? `<span class="memo-rep-badge" title="Repetitions saved on the Page Map counter">${rep.total}×${rep.today ? ` · ${rep.today} today` : ''}</span>` : ''}
            <span class="memo-status-col">
              <span class="memo-status-date">${this.formatDate(entry.date)}</span>
              <span class="memo-jump-hint">Go to page map →</span>
            </span>
          </div>
        `;
      }).join('');

    return `<div class="memo-verse-list">${rows}</div>`;
  }

  renderPicker() {
    const tracked = new Set(this.data.keys());
    const rows = SURAH_LIST.map(s => {
      const selected = this.pickerSelected.has(s.id);
      return `
      <button class="memo-picker-row ${tracked.has(s.id) ? 'tracked' : ''} ${selected ? 'selected' : ''}" data-action="pick-surah" data-surah="${s.id}"
              data-search="${s.id} ${s.nameEn.toLowerCase()} ${s.name}">
        <span class="memo-picker-check ${selected ? 'checked' : ''}" data-action="toggle-pick" data-surah="${s.id}"
              title="Tick to include in bulk marking (Shift-click ticks a range)"></span>
        <span class="memo-picker-num">${s.id}</span>
        <span>${s.nameEn}</span>
        <span class="quran-text memo-picker-arabic" dir="rtl">${s.name}</span>
        ${tracked.has(s.id) ? '<span class="memo-picker-tracked">tracked</span>' : ''}
      </button>
    `;
    }).join('');

    const n = this.pickerSelected.size;
    return `
      <div class="memo-modal-backdrop" data-action="close-picker"></div>
      <div class="modal active memo-picker-modal">
        <div class="modal-header">
          <span class="modal-title">Add Surah</span>
          <button class="modal-close" data-action="close-picker">×</button>
        </div>
        <div class="modal-body">
          <input type="text" class="search-input" id="memo-picker-search" placeholder="Search by number or name..." autocomplete="off">
          <p class="memo-picker-hint">Click a surah to open its verse list — or tick a box to start a bulk selection. While anything is ticked, clicking a row ticks it too (Shift-click ticks a whole range); mark them all at once below.</p>
          <div class="memo-picker-list">${rows}</div>
        </div>
        <div class="memo-picker-footer ${n ? '' : 'hidden'}">
          <span id="memo-picker-count">${n} selected</span>
          <select id="memo-picker-status" class="memo-range-select">
            <option value="memorized">Memorized</option>
            <option value="memorizing">Memorizing</option>
          </select>
          <button class="btn-outline" data-action="clear-picks">Clear</button>
          <button class="btn-gold" id="memo-picker-apply" data-action="apply-picks">Mark ${n} surah${n === 1 ? '' : 's'}</button>
        </div>
      </div>
    `;
  }

  togglePick(surah, shiftKey, root) {
    if (shiftKey && this.pickerAnchor != null && this.pickerAnchor !== surah) {
      // Tick everything between the last tick and this one, skipping
      // rows hidden by the search filter.
      const lo = Math.min(this.pickerAnchor, surah);
      const hi = Math.max(this.pickerAnchor, surah);
      root.querySelectorAll('.memo-picker-row').forEach(row => {
        const s = parseInt(row.dataset.surah);
        if (s >= lo && s <= hi && row.style.display !== 'none') this.pickerSelected.add(s);
      });
    } else if (this.pickerSelected.has(surah)) {
      this.pickerSelected.delete(surah);
    } else {
      this.pickerSelected.add(surah);
    }
    this.pickerAnchor = surah;
    this.updatePickerSelectionUI(root);
  }

  // In-place update of tick marks and the footer, so toggling doesn't wipe
  // the search filter text or the list's scroll position via a full render.
  updatePickerSelectionUI(root) {
    const n = this.pickerSelected.size;
    root.querySelectorAll('.memo-picker-row').forEach(row => {
      const on = this.pickerSelected.has(parseInt(row.dataset.surah));
      row.classList.toggle('selected', on);
      row.querySelector('.memo-picker-check')?.classList.toggle('checked', on);
    });
    root.querySelector('.memo-picker-footer')?.classList.toggle('hidden', n === 0);
    const count = root.querySelector('#memo-picker-count');
    if (count) count.textContent = `${n} selected`;
    const apply = root.querySelector('#memo-picker-apply');
    if (apply) apply.textContent = `Mark ${n} surah${n === 1 ? '' : 's'}`;
  }

  // --- Events ---

  closeStatusMenus(root) {
    root.querySelectorAll('.memo-status-wrap.open').forEach(w => {
      w.classList.remove('open');
      w.querySelector('.memo-status-btn')?.setAttribute('aria-expanded', 'false');
    });
  }

  bindEvents() {
    const root = this.container.querySelector('.memo-root');
    if (!root) return;

    // A click or Escape anywhere else dismisses an open status drop-down.
    // Re-registered each render, so drop the previous listeners first.
    if (this.dismissHandler) {
      document.removeEventListener('click', this.dismissHandler, true);
      document.removeEventListener('keydown', this.escHandler);
    }
    this.dismissHandler = (e) => {
      if (!e.target.closest('.memo-status-wrap')) this.closeStatusMenus(root);
    };
    this.escHandler = (e) => { if (e.key === 'Escape') this.closeStatusMenus(root); };
    document.addEventListener('click', this.dismissHandler, true);
    document.addEventListener('keydown', this.escHandler);

    root.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      const surah = el.dataset.surah ? parseInt(el.dataset.surah) : null;

      switch (action) {
        case 'tab':
          this.view = el.dataset.view;
          this.rangeError = null;
          this.render();
          break;

        case 'expand-surah':
          this.expandedSurah = this.expandedSurah === surah ? null : surah;
          this.rangeError = null;
          this.render();
          break;

        case 'apply-range': {
          const from = parseInt(document.getElementById('memo-range-from')?.value);
          const to = parseInt(document.getElementById('memo-range-to')?.value);
          const status = document.getElementById('memo-range-status')?.value;
          const total = (await this.getSurahTextCached(surah)).length;
          if (!from || !to || from < 1 || to > total || from > to) {
            this.rangeError = `Enter a valid range between 1 and ${total}.`;
            this.render();
            return;
          }
          this.rangeError = null;
          await this.setRangeStatus(surah, from, to, status);
          this.render();
          break;
        }

        case 'whole-surah': {
          const status = document.getElementById('memo-range-status')?.value || 'memorized';
          const total = (await this.getSurahTextCached(surah)).length;
          this.rangeError = null;
          await this.setRangeStatus(surah, 1, total, status);
          this.render();
          break;
        }

        case 'open-status-menu': {
          const wrap = el.closest('.memo-status-wrap');
          const wasOpen = wrap.classList.contains('open');
          this.closeStatusMenus(root);
          wrap.classList.toggle('open', !wasOpen);
          el.setAttribute('aria-expanded', String(!wasOpen));
          break;
        }

        case 'set-status': {
          this.closeStatusMenus(root);
          const ayah = parseInt(el.dataset.ayah);
          const status = el.dataset.status;
          if (status === this.getStatus(surah, ayah)) break;
          await this.setVerseStatus(surah, ayah, status);
          this.render();
          break;
        }

        case 'mark-memorized':
          await this.setVerseStatus(surah, parseInt(el.dataset.ayah), 'memorized');
          this.render();
          break;

        case 'jump-verse':
          window.app?.navigateToPageMap(surah, parseInt(el.dataset.ayah));
          break;

        case 'open-picker':
          this.pickerOpen = true;
          this.pickerSelected.clear();
          this.pickerAnchor = null;
          this.render();
          break;

        case 'close-picker':
          this.pickerOpen = false;
          this.pickerSelected.clear();
          this.render();
          break;

        case 'pick-surah':
          // While a bulk selection is in progress, a click anywhere on a row
          // toggles it instead of opening the verse list — otherwise narrowly
          // missing the checkbox closes the modal and loses the selection.
          if (this.pickerSelected.size > 0) {
            this.togglePick(surah, e.shiftKey, root);
            break;
          }
          this.pickerOpen = false;
          this.pickerSelected.clear();
          this.expandedSurah = surah;
          this.view = 'overview';
          this.render();
          break;

        case 'toggle-pick':
          this.togglePick(surah, e.shiftKey, root);
          break;

        case 'clear-picks':
          this.pickerSelected.clear();
          this.pickerAnchor = null;
          this.updatePickerSelectionUI(root);
          break;

        case 'apply-picks': {
          // Marking many surahs takes a moment; ignore repeat clicks so the
          // work isn't queued up several times over.
          if (this.applying) break;
          const status = document.getElementById('memo-picker-status')?.value || 'memorized';
          const picked = [...this.pickerSelected].sort((a, b) => a - b);
          this.applying = true;
          const applyBtn = root.querySelector('#memo-picker-apply');
          if (applyBtn) {
            applyBtn.disabled = true;
            applyBtn.textContent = `Marking ${picked.length}...`;
          }
          try {
            await this.primeSurahTextCache(picked);
            for (const s of picked) {
              const total = (await this.getSurahTextCached(s)).length;
              await this.setRangeStatus(s, 1, total, status);
            }
          } finally {
            this.applying = false;
          }
          this.pickerOpen = false;
          this.pickerSelected.clear();
          this.pickerAnchor = null;
          this.view = 'overview';
          this.render();
          break;
        }
      }
    });

    // Picker search filter (input events don't bubble as clicks)
    const search = root.querySelector('#memo-picker-search');
    if (search) {
      search.focus();
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        root.querySelectorAll('.memo-picker-row').forEach(row => {
          row.style.display = !q || row.dataset.search.includes(q) ? '' : 'none';
        });
      });
    }
  }
}
