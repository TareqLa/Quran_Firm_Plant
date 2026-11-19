// Quran Firm Plant - Mistake Dashboard & Drill Module
// Aggregates every marked mistake word across the mushaf into one dashboard
// (totals by type, weak pages, word list) and drills them with quiz questions
// whose format matches the mistake type.

import { db } from '../data/db.js';
import { quranLoader } from '../data/loader.js';
import { MISTAKE_TYPES } from './page-map.js';
import { collectAllMistakes, summarize, stripTashkeel } from '../utils/mistake-aggregator.js';
import { generateHarakaDistractors } from '../utils/haraka-distractors.js';
import { normalizeArabic, levenshteinDistance } from '../utils/normalize.js';
import { quranASR, QuranASR } from '../utils/asr.js';
import { getAsrEngine, setAsrEngine } from '../utils/asr-engine-pref.js';
import { arabicKeyboardHtml, bindArabicKeyboard } from '../components/arabic-keyboard.js';

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sample(arr, n) {
  return shuffle(arr).slice(0, n);
}

export class MistakesModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);

    this.records = null;   // MistakeRecord[] from the aggregator
    this.summary = null;
    this.filterType = null;
    this.filterPage = null; // page number, or 'surah' for surah-context marks
    this.view = 'dashboard'; // 'dashboard' | 'drill'

    // Drill state
    this.queue = [];
    this.qIndex = 0;
    this.score = 0;
    this.streak = 0;
    this.results = []; // { record, correct, skipped }
    this.answered = false;
    this.isCorrect = false;
    this.wasSkipped = false;
    this.currentQuestion = null;

    // Speech recognition for pronunciation questions (same dual-engine setup
    // as the Recitation Quiz: browser SpeechRecognition or on-device Whisper).
    this.recognition = null;
    this.isRecording = false;
    this.isTranscribing = false;
    this.whisperSupported = QuranASR.isSupported();
    this.useWhisper = this.whisperSupported && getAsrEngine() === 'whisper';
    this.destroyed = false; // set by destroy() when the app leaves this page
    this.initSpeechRecognition();
  }

  // The header surah selector doesn't scope this module; ignore changes.
  loadSurah() {}

  // Called by the app before it switches to another module: release the microphone
  // so nothing keeps recording after the user has left My Mistakes.
  destroy() {
    this.destroyed = true;
    if (this.recognition) {
      const recognition = this.recognition;
      // Detach first: abort() still fires error/end, which would touch the next page
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* never started */ }
      this.recognition = null;
    }
    // Shared singleton: a recording left running would also be stopped by the next mic tap
    if (quranASR.isRecording) quranASR.cancelRecording();
    this.isRecording = false;
    this.isTranscribing = false;
  }

  async render() {
    if (!this.records) {
      this.container.innerHTML = `
        <div style="display: flex; justify-content: center; align-items: center; height: 200px;">
          <div class="status-indicator">
            <span class="status-dot animate-pulse" style="background-color: var(--accent-gold);"></span>
            <span>Collecting your marked mistakes...</span>
          </div>
        </div>
      `;
      this.records = await collectAllMistakes();
      // Left the page while collecting: the dashboard would be drawn over the next one
      if (this.destroyed) return;
      this.summary = summarize(this.records);
    }

    if (this.view === 'drill') {
      this.renderDrill();
    } else {
      this.renderDashboard();
    }
  }

  // Records matching the active type/page filters.
  filteredRecords() {
    return this.records.filter(r => {
      if (this.filterType && r.type !== this.filterType) return false;
      if (this.filterPage != null) {
        const pageKey = r.page != null ? r.page : 'surah';
        if (pageKey !== this.filterPage) return false;
      }
      return true;
    });
  }

  // Only resolved records with actual text can be turned into questions.
  drillableRecords() {
    return this.filteredRecords().filter(r => !r.unresolved && r.text);
  }

  // Inject @font-face rules for the QCF fonts used by listed glyphs
  // (same URL scheme as PageMapModule.renderSilhouette).
  renderFontStyles(records) {
    const edition = localStorage.getItem('mushaf-edition') || 'v2';
    const fonts = new Set();
    records.forEach(r => { if (r.glyph?.font) fonts.add(r.glyph.font); });

    let css = '';
    fonts.forEach(fontName => {
      let fontUrl, format;
      if (edition === 'v1') {
        fontUrl = `https://verses.quran.foundation/fonts/quran/hafs/v1/woff2/${fontName}.woff2`;
        format = 'woff2';
      } else {
        fontUrl = fontName === 'QCF4_QBSML'
          ? 'https://raw.githubusercontent.com/MohamadHajjRabee/quran-qcf4/main/fonts/QCF4_QBSML.ttf'
          : `https://raw.githubusercontent.com/MohamadHajjRabee/quran-qcf4/main/fonts/${fontName}_W.ttf`;
        format = 'truetype';
      }
      css += `@font-face { font-family: '${fontName}'; src: url('${fontUrl}') format('${format}'); }\n`;
    });
    return css ? `<style>${css}</style>` : '';
  }

  wordHtml(record, sizeRem = 1.6) {
    if (record.glyph) {
      return `<span style="font-family: '${record.glyph.font}'; font-size: ${sizeRem}rem; line-height: 1.4;">${record.glyph.char}</span>`;
    }
    return `<span class="quran-text" style="font-size: ${sizeRem}rem; line-height: 1.4;">${record.text || '؟'}</span>`;
  }

  // --- Dashboard ---

  renderDashboard() {
    if (this.summary.total === 0) {
      this.container.innerHTML = `
        <div class="card" style="text-align: center; padding: 48px; max-width: 640px; margin: 0 auto;">
          <h3 style="color: var(--accent-gold); margin-bottom: 12px;">No mistakes marked yet</h3>
          <p style="color: var(--text-secondary); line-height: 1.7;">
            Mark the words you stumble on and they will show up here for review and drilling.<br><br>
            In <strong>Visual Page Map</strong>: long-press (or right-click) a word and pick the mistake type.<br>
            In <strong>Writing Practice</strong>: tap the golden review dot under a word.
          </p>
        </div>
      `;
      return;
    }

    const filtered = this.filteredRecords();
    const drillable = this.drillableRecords();

    // Stat cards, one per mistake type
    const statCards = MISTAKE_TYPES.map(({ type, label, cssVar }) => {
      const count = this.summary.byType[type] || 0;
      const active = this.filterType === type;
      return `
        <button class="mistake-stat-card ${active ? 'active' : ''}" data-type="${type}"
                style="--stat-color: var(${cssVar}); --stat-tint: var(${cssVar}-tint);" ${count === 0 ? 'disabled' : ''}>
          <span class="mistake-stat-count">${count}</span>
          <span class="mistake-stat-label">${label}</span>
        </button>
      `;
    }).join('');

    // Weak pages (top 10)
    const weakRows = this.summary.byPage.slice(0, 10).map(p => {
      const label = p.page === 'surah' ? 'Surah practice' : `Page ${p.page}`;
      const active = this.filterPage === p.page;
      const dots = MISTAKE_TYPES
        .filter(({ type }) => p.byType[type])
        .map(({ type, cssVar }) => `<span class="weak-page-dot" style="background: var(${cssVar});" title="${p.byType[type]} ${type}"></span>`)
        .join('');
      return `
        <button class="weak-page-row ${active ? 'active' : ''}" data-page="${p.page}">
          <span>${label}</span>
          <span class="weak-page-dots">${dots}</span>
          <span class="weak-page-count">${p.count}</span>
        </button>
      `;
    }).join('');

    // Word list grouped by page
    const groups = new Map();
    filtered.forEach(r => {
      const key = r.page != null ? `Page ${r.page}` : 'Surah practice';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    let listHtml = '';
    groups.forEach((recs, groupLabel) => {
      const rows = recs.map(r => {
        const typeInfo = MISTAKE_TYPES.find(t => t.type === r.type);
        const location = r.verseKey ? r.verseKey : (r.unresolved ? r.rawKey : '');
        return `
          <div class="mistake-word-row">
            <span class="mistake-word-text" dir="rtl">${r.unresolved ? '<em style="font-size: 0.85rem; color: var(--text-muted);">unresolvable mark</em>' : this.wordHtml(r)}</span>
            <span class="mistake-type-badge mark-swatch-${r.type}" style="color: var(${typeInfo?.cssVar});">${typeInfo?.label || r.type}</span>
            <span class="mistake-word-loc">${location}</span>
            <span class="mistake-word-actions">
              ${r.surah && r.ayah ? `<button class="btn-outline locate-btn" data-surah="${r.surah}" data-ayah="${r.ayah}">Locate</button>` : ''}
              ${r.page != null ? `<button class="btn-outline write-btn" data-page="${r.page}">Write</button>` : ''}
            </span>
          </div>
        `;
      }).join('');
      listHtml += `
        <div class="card" style="padding: 16px 20px; margin-bottom: 16px;">
          <h4 style="color: var(--accent-gold); margin-bottom: 12px;">${groupLabel}</h4>
          ${rows}
        </div>
      `;
    });

    // Drill button label reflects active filters
    const typeLabel = this.filterType ? MISTAKE_TYPES.find(t => t.type === this.filterType)?.label.toLowerCase() : 'mistake';
    const pageLabel = this.filterPage != null ? (this.filterPage === 'surah' ? ' from surah practice' : ` on page ${this.filterPage}`) : '';
    const drillLabel = `Drill ${drillable.length} ${typeLabel}${drillable.length === 1 ? '' : 's'}${pageLabel}`;

    this.container.innerHTML = `
      ${this.renderFontStyles(filtered)}
      <div class="mistake-stats-row">${statCards}</div>

      <div class="mistake-dashboard-grid">
        <div>
          <div class="blank-page-controls" style="margin-bottom: 16px;">
            <button id="start-drill-btn" class="btn-gold" ${drillable.length === 0 ? 'disabled' : ''}>${drillLabel}</button>
            ${this.filterType || this.filterPage != null ? '<button id="clear-filters-btn" class="btn-outline">Clear filters</button>' : ''}
          </div>
          ${listHtml || '<div class="card" style="padding: 24px; color: var(--text-secondary);">No marks match the current filters.</div>'}
        </div>
        <div>
          <div class="card" style="padding: 16px 20px;">
            <h4 style="color: var(--accent-gold); margin-bottom: 12px;">Weak Pages</h4>
            ${weakRows}
          </div>
        </div>
      </div>
    `;

    this.setupDashboardEvents();
  }

  setupDashboardEvents() {
    this.container.querySelectorAll('.mistake-stat-card').forEach(card => {
      card.addEventListener('click', () => {
        const type = card.dataset.type;
        this.filterType = this.filterType === type ? null : type;
        this.renderDashboard();
      });
    });

    this.container.querySelectorAll('.weak-page-row').forEach(row => {
      row.addEventListener('click', () => {
        const raw = row.dataset.page;
        const page = raw === 'surah' ? 'surah' : parseInt(raw);
        this.filterPage = this.filterPage === page ? null : page;
        this.renderDashboard();
      });
    });

    document.getElementById('clear-filters-btn')?.addEventListener('click', () => {
      this.filterType = null;
      this.filterPage = null;
      this.renderDashboard();
    });

    this.container.querySelectorAll('.locate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.app.navigateToPageMap(parseInt(btn.dataset.surah), parseInt(btn.dataset.ayah));
      });
    });

    this.container.querySelectorAll('.write-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.app.navigateToWritingPage(parseInt(btn.dataset.page));
      });
    });

    document.getElementById('start-drill-btn')?.addEventListener('click', () => this.startDrill());
  }

  // --- Drill ---

  async startDrill() {
    this.queue = shuffle(this.drillableRecords());
    if (this.queue.length === 0) return;
    this.qIndex = 0;
    this.score = 0;
    this.streak = 0;
    this.results = [];
    this.view = 'drill';
    await this.showQuestion();
  }

  async showQuestion() {
    this.answered = false;
    this.isCorrect = false;
    this.wasSkipped = false;
    this.userAnswer = null;
    this.currentQuestion = null;

    // Build the question for the current record; unbuildable records
    // (missing ayah text etc.) are skipped silently.
    while (this.qIndex < this.queue.length && !this.currentQuestion) {
      this.currentQuestion = await this.buildQuestion(this.queue[this.qIndex]);
      if (!this.currentQuestion) this.qIndex++;
    }

    if (this.destroyed) return; // left the page while the question was being built
    this.renderDrill();
  }

  async buildQuestion(record) {
    try {
      if (record.type === 'haraka') {
        const q = this.buildHarakaQuestion(record);
        if (q) return q;
      }
      if (record.type === 'meaning') {
        const q = await this.buildMeaningQuestion(record);
        if (q) return q;
      }
      if (record.type === 'pronunciation') {
        const q = await this.buildPronunciationQuestion(record);
        if (q) return q;
      }
      // word / forgotten, and the fallback for the other types when their
      // required data (harakat, glosses) isn't available.
      return await this.buildClozeQuestion(record);
    } catch (e) {
      console.error('Failed to build drill question:', e);
      return null;
    }
  }

  buildHarakaQuestion(record) {
    const bare = stripTashkeel(record.text);
    if (bare === record.text) return null; // no diacritics to quiz on
    const distractors = generateHarakaDistractors(record.text, 3);
    if (distractors.length === 0) return null;
    return {
      kind: 'haraka',
      record,
      prompt: bare,
      options: shuffle([record.text, ...distractors]),
      correct: record.text, // raw string equality — the options differ only in tashkeel
    };
  }

  async buildMeaningQuestion(record) {
    if (record.page == null || !record.verseKey || !record.position) return null;
    const map = await quranLoader.loadWordTranslations(record.page);
    const correct = map?.[`${record.verseKey}:${record.position}`];
    if (!correct) return null;
    const others = [...new Set(Object.values(map))].filter(v => v !== correct);
    if (others.length < 3) return null;
    return {
      kind: 'meaning',
      record,
      options: shuffle([correct, ...sample(others, 3)]),
      correct,
    };
  }

  async buildPronunciationQuestion(record) {
    if (!record.surah || !record.ayah) return null;
    const ayahData = await db.getAyah(record.surah, record.ayah);
    return {
      kind: 'pronunciation',
      record,
      ayahText: ayahData?.text || '',
    };
  }

  async buildClozeQuestion(record) {
    if (!record.surah || !record.ayah) return null;
    const ayahData = await db.getAyah(record.surah, record.ayah);
    if (!ayahData?.text) return null;

    const words = ayahData.text.split(/\s+/);
    // QCF layout position and quran-json tokenization can differ, so match by
    // normalized text first and only fall back to the position index.
    const normTarget = normalizeArabic(record.text);
    let blankIdx = words.findIndex(w => normalizeArabic(w) === normTarget);
    if (blankIdx === -1 && record.position) {
      blankIdx = Math.min(record.position - 1, words.length - 1);
    }
    if (blankIdx < 0) blankIdx = 0;
    const correct = words[blankIdx];

    // Answered by typing (or tapping the on-screen keyboard) — no options.
    // Grading strips tashkeel, so the word skeleton is what's tested.
    return {
      kind: 'cloze',
      record,
      display: words.map((w, i) => i === blankIdx ? '<span class="cloze-blank">____</span>' : w).join(' '),
      correct,
    };
  }

  renderDrill() {
    const total = this.queue.length;

    // Past the last question: results screen
    if (!this.currentQuestion || this.qIndex >= total) {
      this.renderDrillResults();
      return;
    }

    const q = this.currentQuestion;
    const typeInfo = MISTAKE_TYPES.find(t => t.type === q.record.type);

    let body = '';
    if (q.kind === 'haraka') {
      body = `
        <div class="line-connector-prompt card">
          <span class="prompt-label">You marked this word for <strong style="color: var(${typeInfo?.cssVar});">${typeInfo?.label}</strong>. Which vocalization is correct?</span>
          <div class="prompt-verse quran-text" dir="rtl" style="margin-top: 16px; font-size: 2.2rem;">${q.prompt}</div>
          <span class="prompt-label" style="color: var(--accent-gold);">${q.record.verseKey || ''}</span>
        </div>
        <div class="line-connector-options drill-options" style="margin-top: 12px;">
          ${q.options.map((opt, i) => this.optionBtnHtml(opt, i, q, 'quran-text drill-arabic-option')).join('')}
        </div>
      `;
    } else if (q.kind === 'cloze') {
      body = `
        <div class="line-connector-prompt card">
          <span class="prompt-label">Type the missing word (marked as <strong style="color: var(${typeInfo?.cssVar});">${typeInfo?.label}</strong>):</span>
          <div class="prompt-verse quran-text" dir="rtl" style="margin-top: 16px;">${q.display}</div>
          <span class="prompt-label" style="color: var(--accent-gold);">${q.record.verseKey || ''}</span>
        </div>
        ${!this.answered ? `
        <div class="drill-type-area">
          <div style="display: flex; gap: 8px; justify-content: center;">
            <input id="drill-cloze-input" class="quran-text drill-cloze-input" dir="rtl" type="text"
                   placeholder="اكتب الكلمة" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button id="drill-cloze-check" class="btn-gold">Check</button>
          </div>
          <p style="font-size: 0.8rem; color: var(--text-muted); text-align: center; margin: 8px 0 0;">
            Harakat are optional — spelling is what counts. No Arabic keyboard? Tap the letters below.
          </p>
          ${arabicKeyboardHtml()}
        </div>` : ''}
      `;
    } else if (q.kind === 'meaning') {
      body = `
        <div class="line-connector-prompt card">
          <span class="prompt-label">What does this word mean?</span>
          <div class="prompt-verse" dir="rtl" style="margin-top: 16px;">${this.wordHtml(q.record, 2.4)}</div>
          <span class="prompt-label" style="color: var(--accent-gold);">${q.record.verseKey || ''}</span>
        </div>
        <div class="line-connector-options drill-options" style="margin-top: 12px;">
          ${q.options.map((opt, i) => this.optionBtnHtml(opt, i, q, '')).join('')}
        </div>
      `;
    } else if (q.kind === 'pronunciation') {
      body = `
        <div class="line-connector-prompt card">
          <span class="prompt-label">Recite this word aloud (marked as <strong style="color: var(${typeInfo?.cssVar});">Wrong Pronunciation</strong>):</span>
          <div class="prompt-verse" dir="rtl" style="margin-top: 16px;">${this.wordHtml(q.record, 2.4)}</div>
          ${q.ayahText ? `<div class="quran-text" dir="rtl" style="font-size: 1.1rem; color: var(--text-secondary); margin-top: 12px;">${q.ayahText}</div>` : ''}
          <span class="prompt-label" style="color: var(--accent-gold);">${q.record.verseKey || ''}</span>
        </div>
        <div class="card" style="display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 24px; text-align: center;">
          <div class="mic-btn-container" style="width: 100px; height: 100px;">
            <div class="mic-pulse-ring"></div>
            <button id="drill-mic-btn" class="mic-btn" style="width: 76px; height: 76px;" title="Start Reciting" ${this.answered ? 'disabled' : ''}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              </svg>
            </button>
          </div>
          <div id="drill-transcription" style="font-size: 1rem; color: var(--text-secondary); font-style: italic;">
            Tap the microphone and recite the word (its ayah is fine too)...
          </div>
          <div style="display: flex; gap: 12px; align-items: center;">
            ${this.recognition && this.whisperSupported ? `
              <button id="drill-engine-toggle" class="btn-outline" style="padding: 3px 10px; font-size: 0.78rem;">
                ${this.useWhisper ? 'On-device Whisper' : 'Browser (live)'}
              </button>` : ''}
            ${!this.answered ? '<button id="drill-skip-btn" class="btn-outline">Skip (no mic)</button>' : ''}
          </div>
        </div>
      `;
    }

    // Feedback card after answering
    let feedback = '';
    if (this.answered) {
      const heading = this.wasSkipped ? 'Skipped' : (this.isCorrect ? 'Correct!' : 'Incorrect');
      const color = this.wasSkipped ? 'var(--text-secondary)' : (this.isCorrect ? 'var(--color-success)' : 'var(--color-error)');
      const answerLine = q.kind === 'meaning'
        ? `<p>Correct answer: <strong>${q.correct}</strong></p>`
        : q.kind === 'pronunciation'
          ? `<div class="quran-text" dir="rtl" style="font-size: 1.8rem; color: var(--accent-gold);">${q.record.text}</div>`
          : `<div class="quran-text" dir="rtl" style="font-size: 1.8rem; color: var(--accent-gold);">${q.correct}</div>`;
      const typedLine = (q.kind === 'cloze' && !this.isCorrect && !this.wasSkipped && this.userAnswer)
        ? `<p style="color: var(--text-secondary); margin-top: 8px;">You typed: <span class="quran-text" dir="rtl" style="font-size: 1.3rem; color: var(--color-error);">${this.userAnswer}</span></p>`
        : '';
      feedback = `
        <div class="card" style="text-align: center; margin-top: 20px;">
          <h4 style="color: ${color}; margin-bottom: 12px;">${heading}</h4>
          ${answerLine}
          ${typedLine}
          <button id="drill-next-btn" class="btn-gold" style="margin-top: 16px;">
            ${this.qIndex + 1 >= total ? 'Show Results' : 'Next Question'}
          </button>
        </div>
      `;
    }

    this.container.innerHTML = `
      ${this.renderFontStyles([q.record])}
      <div class="blank-page-controls" style="margin-bottom: 24px;">
        <div class="toolbar-group">
          <button id="drill-back-btn" class="btn-outline">← Dashboard</button>
        </div>
        <div class="toolbar-group" style="margin-left: auto; color: var(--text-secondary); font-size: 0.9rem; align-items: center; gap: 16px;">
          <span>Question <strong>${this.qIndex + 1}/${total}</strong></span>
          <span>Score: <strong>${this.score}</strong></span>
          <span style="border-left: 1px solid var(--border-color); padding-left: 16px; color: var(--accent-gold);">Streak: <strong>🔥 ${this.streak}</strong></span>
        </div>
      </div>
      <div class="line-connector-card" style="margin-top: 12px;">
        ${body}
        ${feedback}
      </div>
    `;

    this.setupDrillEvents();
  }

  optionBtnHtml(opt, i, q, extraClass) {
    let cls = '';
    if (this.answered) {
      if (opt === q.correct) cls = 'correct';
      else if (opt === this.userAnswer) cls = 'incorrect';
    }
    return `<button class="option-btn drill-option ${extraClass} ${cls}" dir="rtl" data-idx="${i}" ${this.answered ? 'disabled' : ''}>${opt}</button>`;
  }

  setupDrillEvents() {
    document.getElementById('drill-back-btn')?.addEventListener('click', () => {
      this.stopListening();
      this.view = 'dashboard';
      this.renderDashboard();
    });

    const q = this.currentQuestion;
    if (!q) return;

    if (!this.answered) {
      this.container.querySelectorAll('.drill-option').forEach(btn => {
        btn.addEventListener('click', () => {
          const opt = q.options[parseInt(btn.dataset.idx)];
          this.submitAnswer(opt === q.correct, opt);
        });
      });

      if (q.kind === 'cloze') {
        const input = document.getElementById('drill-cloze-input');
        const checkTyped = () => {
          const typed = input?.value.trim();
          if (!typed) return;
          this.submitAnswer(normalizeArabic(typed) === normalizeArabic(q.correct), typed);
        };
        document.getElementById('drill-cloze-check')?.addEventListener('click', checkTyped);
        input?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') checkTyped();
        });
        if (input) bindArabicKeyboard(this.container, input);
      }

      if (q.kind === 'pronunciation') {
        document.getElementById('drill-mic-btn')?.addEventListener('click', () => this.toggleMic());
        document.getElementById('drill-skip-btn')?.addEventListener('click', () => {
          this.stopListening();
          this.submitAnswer(false, null, true);
        });
        document.getElementById('drill-engine-toggle')?.addEventListener('click', () => {
          if (this.isRecording || this.isTranscribing) return;
          this.useWhisper = !this.useWhisper;
          setAsrEngine(this.useWhisper ? 'whisper' : 'browser');
          const btn = document.getElementById('drill-engine-toggle');
          if (btn) btn.innerText = this.useWhisper ? 'On-device Whisper' : 'Browser (live)';
        });
      }
    }

    document.getElementById('drill-next-btn')?.addEventListener('click', () => {
      this.qIndex++;
      this.showQuestion();
    });
  }

  submitAnswer(correct, userAnswer = null, skipped = false) {
    if (this.answered) return;
    this.answered = true;
    this.isCorrect = correct;
    this.wasSkipped = skipped;
    this.userAnswer = userAnswer;
    if (correct) {
      this.score++;
      this.streak++;
    } else {
      this.streak = 0;
    }
    this.results.push({ record: this.currentQuestion.record, correct, skipped });

    // Hook point for future features: timestamped attempt history and
    // auto-graduation (unmarking a word after N correct answers across days)
    // would both be persisted from here, writing back to
    // `pagemap-marked-{page}` / the `writing-marks` localStorage array.
    // this._onQuestionAnswered(this.currentQuestion.record, correct);

    this.renderDrill();
  }

  renderDrillResults() {
    const missed = this.results.filter(r => !r.correct);
    const byType = {};
    this.results.forEach(r => {
      const t = r.record.type;
      if (!byType[t]) byType[t] = { correct: 0, total: 0 };
      byType[t].total++;
      if (r.correct) byType[t].correct++;
    });

    const typeRows = MISTAKE_TYPES.filter(({ type }) => byType[type]).map(({ type, label, cssVar }) => `
      <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border-color);">
        <span style="color: var(${cssVar});">${label}</span>
        <strong>${byType[type].correct} / ${byType[type].total}</strong>
      </div>
    `).join('');

    const missedRows = missed.map(({ record }) => `
      <div class="mistake-word-row">
        <span class="mistake-word-text" dir="rtl">${this.wordHtml(record)}</span>
        <span class="mistake-word-loc">${record.verseKey || ''}</span>
        <span class="mistake-word-actions">
          ${record.surah && record.ayah ? `<button class="btn-outline locate-btn" data-surah="${record.surah}" data-ayah="${record.ayah}">Locate</button>` : ''}
        </span>
      </div>
    `).join('');

    this.container.innerHTML = `
      ${this.renderFontStyles(missed.map(m => m.record))}
      <div class="card" style="text-align: center; padding: 32px; max-width: 640px; margin: 0 auto;">
        <h3 style="color: var(--accent-gold); margin-bottom: 8px;">Drill Complete</h3>
        <p style="font-size: 2rem; margin-bottom: 16px;"><strong>${this.score} / ${this.results.length}</strong></p>
        <div style="text-align: left; margin-bottom: 20px;">${typeRows}</div>
        ${missed.length ? `
          <h4 style="color: var(--text-secondary); margin-bottom: 12px; text-align: left;">Still shaky — review these:</h4>
          <div style="text-align: left;">${missedRows}</div>
        ` : '<p style="color: var(--color-success);">Every question answered correctly — well done!</p>'}
        <button id="drill-back-btn" class="btn-gold" style="margin-top: 20px;">Back to Dashboard</button>
      </div>
    `;

    document.getElementById('drill-back-btn')?.addEventListener('click', () => {
      this.view = 'dashboard';
      this.renderDashboard();
    });
    this.container.querySelectorAll('.locate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.app.navigateToPageMap(parseInt(btn.dataset.surah), parseInt(btn.dataset.ayah));
      });
    });
  }

  // --- Pronunciation question speech recognition ---

  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    this.recognition = new SpeechRecognition();
    this.recognition.lang = 'ar-SA';
    this.recognition.continuous = false;
    this.recognition.interimResults = false;

    this.recognition.onstart = () => {
      this.isRecording = true;
      const micBtn = document.getElementById('drill-mic-btn');
      if (micBtn) {
        micBtn.classList.add('listening');
        micBtn.style.backgroundColor = 'var(--color-error)';
      }
      const box = document.getElementById('drill-transcription');
      if (box) box.innerText = 'Listening...';
    };

    this.recognition.onerror = () => {
      this.isRecording = false;
      this.updateMicUI();
      const box = document.getElementById('drill-transcription');
      if (box) box.innerText = 'Error capturing audio. Tap the mic to try again, or Skip.';
    };

    this.recognition.onend = () => {
      this.isRecording = false;
      this.updateMicUI();
    };

    this.recognition.onresult = (e) => {
      if (e.results.length > 0) {
        const transcript = e.results[0][0].transcript;
        const box = document.getElementById('drill-transcription');
        if (box) {
          box.dir = 'rtl';
          box.innerText = transcript;
        }
        this.checkPronunciation(transcript);
      }
    };
  }

  updateMicUI() {
    const micBtn = document.getElementById('drill-mic-btn');
    if (micBtn) {
      micBtn.classList.remove('listening');
      micBtn.style.backgroundColor = '';
    }
  }

  stopListening() {
    if (this.isRecording) {
      try { this.recognition?.stop(); } catch { /* already stopped */ }
      this.isRecording = false;
    }
  }

  async toggleMic() {
    if (this.useWhisper) {
      await this.toggleWhisperMic();
      return;
    }
    if (!this.recognition) {
      alert('Speech Recognition not supported in this browser. Use Chrome/Edge, or press Skip.');
      return;
    }
    if (this.isRecording) this.recognition.stop();
    else this.recognition.start();
  }

  async toggleWhisperMic() {
    if (this.isTranscribing) return;
    const box = document.getElementById('drill-transcription');
    const micBtn = document.getElementById('drill-mic-btn');

    if (!quranASR.isRecording) {
      try {
        if (!quranASR.modelReady) {
          if (box) box.innerText = 'Loading recitation model (first time only)...';
          await quranASR.ensureLoaded((pct, phase) => {
            if (box) box.innerText = phase === 'warming'
              ? 'Preparing the on-device recitation model...'
              : `Loading Tarteel Whisper model... ${pct}%`;
          });
        }
        if (this.destroyed) return; // left the page while the model loaded
        this.isRecording = true;
        if (micBtn) {
          micBtn.classList.add('listening');
          micBtn.style.backgroundColor = 'var(--color-error)';
        }
        if (box) box.innerText = 'Listening... recite, then tap the mic to stop.';
        await quranASR.startRecording((text) => {
          if (text && box) {
            box.dir = 'rtl';
            box.innerText = text;
          }
        });
        // Left the page while the browser was still opening the mic
        if (this.destroyed) quranASR.cancelRecording();
      } catch (e) {
        if (this.destroyed) return;
        console.error('On-device ASR failed:', e);
        this.useWhisper = false;
        if (box) box.innerText = 'On-device recognition failed. Tap the mic to use the browser engine, or Skip.';
      }
    } else {
      this.isRecording = false;
      this.isTranscribing = true;
      this.updateMicUI();
      if (box) box.innerText = 'Transcribing your recitation on-device...';
      try {
        const text = await quranASR.stopAndTranscribe();
        // Left the page while transcribing: grading would redraw the drill over the new page
        if (this.destroyed) return;
        this.isTranscribing = false;
        if (!text) {
          if (box) box.innerText = 'No speech detected. Tap the mic and try again.';
          return;
        }
        if (box) {
          box.dir = 'rtl';
          box.innerText = text;
        }
        this.checkPronunciation(text);
      } catch (e) {
        if (this.destroyed) return;
        console.error('Transcription failed:', e);
        this.isTranscribing = false;
        if (box) box.innerText = 'Transcription failed. Tap the mic and try again, or Skip.';
      }
    }
  }

  checkPronunciation(transcript) {
    if (this.answered) return;
    const q = this.currentQuestion;
    if (!q || q.kind !== 'pronunciation') return;

    const normSaid = normalizeArabic(transcript);
    const normTarget = normalizeArabic(q.record.text);

    // The user may recite the whole ayah around the word — a containment
    // check passes that too; otherwise fuzzy-match the word itself.
    let correct = normSaid.includes(normTarget);
    if (!correct && normSaid && normTarget) {
      const dist = levenshteinDistance(normSaid, normTarget);
      const maxLen = Math.max(normSaid.length, normTarget.length);
      correct = (1 - dist / maxLen) > 0.6;
    }
    this.submitAnswer(correct);
  }
}
