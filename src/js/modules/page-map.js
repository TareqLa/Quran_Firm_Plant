// Quran Firm Plant - Visual Mushaf Page Map Module
// Renders page grids, silhouettes, and cross-line transitions to build visual memory.

import { db } from '../data/db.js';
import { quranLoader } from '../data/loader.js';
import { audioPlayer } from '../components/audio-player.js';

const STORAGE_KEY_LAST_PAGE = 'pagemap-last-page';
const STORAGE_KEY_HISTORY = 'pagemap-page-history';
const MAX_HISTORY_ITEMS = 30;

export class PageMapModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);
    
    // Restore last opened page, fallback to 591 (Al-A'la)
    const savedPage = parseInt(localStorage.getItem(STORAGE_KEY_LAST_PAGE));
    this.currentPage = (savedPage >= 1 && savedPage <= 604) ? savedPage : 591;
    
    this.pageData = null;
    this.wordTranslations = {}; // "surah:ayah:position" -> English gloss, for hover/tap tooltip
    this.currentSubFeature = 'silhouette'; // 'silhouette', 'connector', 'coordinates', 'first-last'
    
    // Line connector game state
    this.connectorQuestion = null;
    
    // Coordinate finder state
    this.coordQuestion = null;
    this.coordSelectedLine = null;
    this.coordIsCorrect = null;
    
    // First/last word state
    this.flQuestion = null;
    this.flRevealed = false;

    // Selected mushaf edition (v1 or v2)
    this.currentEdition = localStorage.getItem('mushaf-edition') || 'v2';
    
    // Page history state
    this.showHistory = false;

    // Marked forgotten words
    this.markedWords = new Set();

    // Silhouette study state (merged from Blank Page module)
    this.studyMode = localStorage.getItem('pagemap-study-mode') || 'free'; // 'free' | 'sequential' | 'first-word'
    this.revealedWords = new Set();   // persisted revealed word keys for the current page
    this.wordSequence = [];           // word keys in reading order (for sequential mode & progress)
    this.firstWordAnchors = new Set(); // first word key of each ayah on the page
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
      const savedMarked = await db.getProgress(`pagemap-marked-${pageNumber}`);
      this.markedWords = new Set(savedMarked || []);

      const savedRevealed = await db.getProgress(`pagemap-revealed-${pageNumber}`);
      this.revealedWords = new Set(savedRevealed || []);

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
      <!-- Sub-feature Toggle Toolbar -->
      <div class="blank-page-controls" style="margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div class="toolbar-group">
          <button class="btn-outline sf-btn ${this.currentSubFeature === 'silhouette' ? 'active' : ''}" data-feature="silhouette">Page Silhouette</button>
          <button class="btn-outline sf-btn ${this.currentSubFeature === 'connector' ? 'active' : ''}" data-feature="connector">Line Connector Game</button>
          <button class="btn-outline sf-btn ${this.currentSubFeature === 'coordinates' ? 'active' : ''}" data-feature="coordinates">Coordinate Finder</button>
          <button class="btn-outline sf-btn ${this.currentSubFeature === 'first-last' ? 'active' : ''}" data-feature="first-last">First & Last Word Drill</button>
        </div>
        <div class="toolbar-group" style="gap: 8px;">
          <!-- Write This Page Button -->
          <button id="pagemap-write-btn" class="btn-gold" style="display: flex; align-items: center; gap: 5px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            Write Page ${this.currentPage}
          </button>
          
          <!-- Page History Toggle -->
          <div class="pagemap-history-wrapper">
            <button id="pagemap-history-btn" class="btn-outline ${this.showHistory ? 'active' : ''}" title="Page History" style="display: flex; align-items: center; gap: 5px; position: relative;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              History
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
          
          <label style="font-size: 0.85rem; color: var(--text-secondary); margin-right: 6px;">Mushaf:</label>
          <select id="mushaf-edition-select" class="selector-input" style="padding: 6px 12px; font-size: 0.85rem; background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 4px; cursor: pointer; margin-bottom: 0;">
            <option value="v2" ${this.currentEdition === 'v2' ? 'selected' : ''}>Madinah V2 (Standard)</option>
            <option value="v1" ${this.currentEdition === 'v1' ? 'selected' : ''}>Madinah V1 (Classic 1405 AH)</option>
          </select>
        </div>
      </div>

      <!-- Main Display -->
      <div id="pagemap-content-area" style="display: flex; flex-direction: column; align-items: center; width: 100%;">
        ${this.renderSubFeatureContent()}
      </div>
    `;

    // Dynamic initializations
    if (this.currentSubFeature === 'connector' && !this.connectorQuestion) {
      this.generateConnectorQuestion();
    }
    if (this.currentSubFeature === 'coordinates' && !this.coordQuestion) {
      this.generateCoordinateQuestion();
    }
    if (this.currentSubFeature === 'first-last' && !this.flQuestion) {
      this.generateFirstLastQuestion();
    }
  }

  renderSubFeatureContent() {
    switch (this.currentSubFeature) {
      case 'silhouette':
        return this.renderSilhouette();
      case 'connector':
        return this.renderConnector();
      case 'coordinates':
        return this.renderCoordinates();
      case 'first-last':
        return this.renderFirstLast();
      default:
        return '';
    }
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

  getNextSequentialKey() {
    return this.wordSequence.find(key => !this.revealedWords.has(key)) || null;
  }

  saveRevealed() {
    db.saveProgress(`pagemap-revealed-${this.currentPage}`, Array.from(this.revealedWords));
  }

  // Update reveal state for a list of word-box elements, persist, and refresh the progress UI
  setRevealedForElements(elements, reveal) {
    elements.forEach(el => {
      const key = el.dataset.key;
      if (!key) return; // skip ayah-end markers
      if (reveal) {
        this.revealedWords.add(key);
      } else {
        this.revealedWords.delete(key);
      }
      el.classList.toggle('revealed', this.isWordShown(key));
    });
    this.saveRevealed();
    this.updateSilhouetteProgress();
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
          const isMarked = this.markedWords.has(wordKey);
          const isShown = this.isWordShown(wordKey);
          wordsHtml += `
            <span class="mushaf-word-box ${isMarked ? 'marked-forgotten' : ''} ${isShown ? 'revealed' : ''}"
                  data-key="${wordKey}"
                  data-verse-key="${word.verse_key || ''}"
                  data-position="${word.position || ''}"
                  data-text="${word.text}"
                  style="font-family: '${word.font}'; font-size: clamp(1.1rem, 4vw, 1.65rem); line-height: 1; flex-shrink: 1;">
              ${word.char}
            </span>
          `;
        }
      });

      linesHtml += `
        <div class="mushaf-line" data-line="${lineObj.line}">
          <span class="mushaf-line-number">${lineObj.line}</span>
          ${wordsHtml}
          <span class="mushaf-line-right-number">${lineObj.line}</span>
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
      <div class="blank-page-controls" style="justify-content: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
        <div class="toolbar-group">
          <button class="btn-outline study-mode-btn ${this.studyMode === 'free' ? 'active' : ''}" data-study-mode="free">Free Reveal</button>
          <button class="btn-outline study-mode-btn ${this.studyMode === 'sequential' ? 'active' : ''}" data-study-mode="sequential">Next Word Guide</button>
          <button class="btn-outline study-mode-btn ${this.studyMode === 'first-word' ? 'active' : ''}" data-study-mode="first-word">First Word Anchors</button>
        </div>
        <div class="toolbar-group">
          <button id="sil-reveal-next-btn" class="btn-gold" ${this.studyMode !== 'sequential' ? 'style="display:none;"' : ''}>Reveal Next Word →</button>
          <button id="sil-hide-all-btn" class="btn-outline">Hide All</button>
          <button id="sil-show-all-btn" class="btn-outline">Show All</button>
        </div>
      </div>

      <div class="progress-bar-container" style="width: 100%; max-width: 700px; margin: 0 auto 4px;">
        <div id="sil-progress-bar" class="progress-bar" style="width: ${pct}%"></div>
      </div>
      <div id="sil-progress-text" style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 10px;">
        Revealed: ${revealed} / ${total} words (${pct}%)
      </div>

      <div style="display: flex; align-items: center; justify-content: center; gap: 14px; margin-bottom: 14px;">
        <button id="sil-prev-page" class="btn-outline" ${this.currentPage <= 1 ? 'disabled' : ''}>‹ Page ${this.currentPage - 1}</button>
        <h4 style="color: var(--text-secondary); margin: 0;">Page ${this.currentPage}</h4>
        <button id="sil-next-page" class="btn-outline" ${this.currentPage >= 604 ? 'disabled' : ''}>Page ${this.currentPage + 1} ›</button>
      </div>
      <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 12px;">Tap blocks to reveal words. Long-press a word to mark it, or an ayah circle for ayah options & audio.</p>
      <div class="mushaf-page-container">
        <div class="mushaf-page-grid">
          ${linesHtml}
        </div>
      </div>
    `;
  }

  // --- Sub-feature 2: Line Connector Game ---
  renderConnector() {
    if (!this.connectorQuestion) return 'Generating question...';

    const q = this.connectorQuestion;
    
    return `
      <div class="line-connector-card">
        <div class="line-connector-prompt card">
          <span class="prompt-label">End of Line ${q.lineIndex}</span>
          <div class="prompt-verse">${q.leftSnippet} <span class="prompt-word-gold">${q.lastWord}</span></div>
          <div class="status-indicator" style="justify-content: center; margin-top: 12px;">
            <span class="status-dot" style="background-color: var(--accent-gold);"></span>
            <span style="font-size: 0.85rem; text-transform: uppercase;">What is the first word of Line ${q.lineIndex + 1}?</span>
          </div>
        </div>

        <div class="line-connector-options">
          ${q.options.map(opt => `
            <button class="option-btn" data-option="${opt}">${opt}</button>
          `).join('')}
        </div>

        <div id="connector-feedback" class="card" style="display: none; text-align: center;">
          <h4 id="connector-feedback-title" style="margin-bottom: 8px;"></h4>
          <p id="connector-feedback-text"></p>
          <button id="next-connector-btn" class="btn-gold" style="margin-top: 16px;">Next Transition</button>
        </div>
      </div>
    `;
  }

  generateConnectorQuestion() {
    // Pick a line that has a next line
    const maxLine = this.pageData.lines.length;
    if (maxLine < 2) return;

    // Pick a random line from 1 to maxLine - 1
    const lineIndex = Math.floor(Math.random() * (maxLine - 1)) + 1;
    const currentLine = this.pageData.lines.find(l => l.line === lineIndex);
    const nextLine = this.pageData.lines.find(l => l.line === lineIndex + 1);

    // Get last word of current line
    const currentLineWords = currentLine.words.filter(w => w.type === 'word');
    const nextLineWords = nextLine.words.filter(w => w.type === 'word');

    if (currentLineWords.length === 0 || nextLineWords.length === 0) {
      // Retry
      this.generateConnectorQuestion();
      return;
    }

    const lastWordObj = currentLineWords[currentLineWords.length - 1];
    const firstWordObj = nextLineWords[0];

    const lastWord = lastWordObj.text;
    const correctAnswer = firstWordObj.text;

    // Get snippet leading to the last word
    const leftSnippet = currentLineWords.slice(-3, -1).map(w => w.text).join(' ');

    // Generate incorrect distractors from the page
    const allWords = [];
    this.pageData.lines.forEach(l => {
      l.words.forEach(w => {
        if (w.type === 'word' && w.text !== correctAnswer && w.text !== lastWord) {
          allWords.push(w.text);
        }
      });
    });

    // Pick 2 random distractors
    const uniqueDistractors = [...new Set(allWords)];
    const distractors = [];
    while (distractors.length < 2 && uniqueDistractors.length > 0) {
      const idx = Math.floor(Math.random() * uniqueDistractors.length);
      distractors.push(uniqueDistractors.splice(idx, 1)[0]);
    }
    
    // Handle edge case of too few words
    if (distractors.length < 2) {
      distractors.push('تَفْعَلُونَ');
      distractors.push('الْعَالَمِينَ');
    }

    const options = [correctAnswer, ...distractors].sort(() => Math.random() - 0.5);

    this.connectorQuestion = {
      lineIndex,
      lastWord,
      correctAnswer,
      leftSnippet,
      options
    };
  }

  // --- Sub-feature 3: Verse Coordinate Finder ---
  renderCoordinates() {
    if (!this.coordQuestion) return 'Generating question...';

    const q = this.coordQuestion;
    
    // Draw 15 lines of blocks (silhouette)
    let linesHtml = '';
    this.pageData.lines.forEach((lineObj) => {
      const isSelected = this.coordSelectedLine === lineObj.line;
      let lineStyle = 'cursor: pointer;';
      if (isSelected) {
        lineStyle += this.coordIsCorrect ? 'background-color: rgba(76, 175, 80, 0.15);' : 'background-color: rgba(244, 67, 54, 0.15);';
      }

      linesHtml += `
        <div class="mushaf-line coord-line" data-line="${lineObj.line}" style="${lineStyle}">
          <span class="mushaf-line-number">${lineObj.line}</span>
          <!-- Silhouette blocks -->
          ${lineObj.words.map(w => {
            const width = w.type === 'end' ? 20 : Math.max(25, w.text.length * 6);
            const radius = w.type === 'end' ? '50%' : '2px';
            const border = w.type === 'end' ? '1px solid var(--accent-gold)' : '1px solid var(--border-color)';
            return `<span style="width: ${width}px; height: 16px; border: ${border}; border-radius: ${radius}; margin: 0 1px; display: inline-block;"></span>`;
          }).join('')}
          <span class="mushaf-line-right-number">${lineObj.line}</span>
        </div>
      `;
    });

    return `
      <div class="line-connector-card">
        <div class="line-connector-prompt card">
          <span class="prompt-label">Coordinate Finder</span>
          <div style="font-size: 1.1rem; font-weight: 600; margin: 12px 0;">Where does this verse begin on Page ${this.currentPage}?</div>
          <div class="prompt-verse" style="font-size: 1.8rem; margin-bottom: 0;">${q.ayahText}</div>
          <span class="prompt-label" style="margin-top: 10px; display: block; color: var(--accent-gold);">${q.surahNameEn} : Ayah ${q.ayahNum}</span>
        </div>

        <div class="mushaf-page-container" style="max-width: 500px;">
          <div class="mushaf-page-grid" style="padding: 10px;">
            ${linesHtml}
          </div>
        </div>

        <div id="coord-feedback" class="card" style="display: ${this.coordSelectedLine ? 'block' : 'none'}; text-align: center;">
          <h4 style="color: ${this.coordIsCorrect ? 'var(--color-success)' : 'var(--color-error)'}; margin-bottom: 8px;">
            ${this.coordIsCorrect ? 'Correct!' : 'Try Again!'}
          </h4>
          <p>
            ${this.coordIsCorrect 
              ? `Yes! Ayah ${q.ayahNum} starts on Line ${q.correctLine}.` 
              : `Line ${this.coordSelectedLine} is incorrect. The ayah actually starts on Line ${q.correctLine}.`}
          </p>
          <button id="next-coord-btn" class="btn-gold" style="margin-top: 16px;">Next Verse</button>
        </div>
      </div>
    `;
  }

  async generateCoordinateQuestion() {
    // Pick an ayah that starts on this page
    // Gather all verse keys present in the word list of this page
    const verseKeys = [];
    this.pageData.lines.forEach(l => {
      l.words.forEach(w => {
        if (w.verse_key && !verseKeys.includes(w.verse_key)) {
          verseKeys.push(w.verse_key);
        }
      });
    });

    if (verseKeys.length === 0) return;

    // Pick a random verse key
    const verseKey = verseKeys[Math.floor(Math.random() * verseKeys.length)];
    const [surahNum, ayahNum] = verseKey.split(':').map(Number);

    // Find the first line where this verse key appears
    let correctLine = null;
    for (const l of this.pageData.lines) {
      const match = l.words.find(w => w.verse_key === verseKey);
      if (match) {
        correctLine = l.line;
        break;
      }
    }

    if (!correctLine) {
      this.generateCoordinateQuestion();
      return;
    }

    // Load actual text from DB
    const ayahObj = await db.getAyah(surahNum, ayahNum);
    if (!ayahObj) {
      this.generateCoordinateQuestion();
      return;
    }

    this.coordQuestion = {
      surahNum,
      ayahNum,
      ayahText: ayahObj.text,
      surahNameEn: ayahObj.surahNameEn,
      correctLine
    };
  }

  // --- Sub-feature 4: First & Last Word Drill ---
  renderFirstLast() {
    if (!this.flQuestion) return 'Generating question...';

    const q = this.flQuestion;
    
    return `
      <div class="line-connector-card" style="max-width: 500px;">
        <div class="card" style="text-align: center; padding: 40px; min-height: 250px; display: flex; flex-direction: column; justify-content: center; align-items: center;">
          <span class="prompt-label" style="margin-bottom: 20px;">First & Last Word Drill</span>
          <h2 style="font-size: 1.5rem; font-weight: 700; margin-bottom: 8px;">Line ${q.lineIndex} on Page ${this.currentPage}</h2>
          
          <div style="margin: 24px 0; width: 100%;">
            <div style="display: flex; justify-content: space-around; width: 100%;">
              <div>
                <div style="font-size: 0.8rem; color: var(--text-secondary); text-transform: uppercase;">First Word</div>
                <div class="quran-text" style="font-size: 2.2rem; color: var(--accent-gold); height: 50px; margin-top: 8px;">
                  ${this.flRevealed ? q.firstWord : '████'}
                </div>
              </div>
              <div style="border-right: 1px solid var(--border-color); height: 80px;"></div>
              <div>
                <div style="font-size: 0.8rem; color: var(--text-secondary); text-transform: uppercase;">Last Word</div>
                <div class="quran-text" style="font-size: 2.2rem; color: var(--accent-gold); height: 50px; margin-top: 8px;">
                  ${this.flRevealed ? q.lastWord : '████'}
                </div>
              </div>
            </div>
          </div>

          <div style="display: flex; gap: 12px; margin-top: 16px;">
            ${!this.flRevealed 
              ? `<button id="fl-reveal-btn" class="btn-gold">Reveal Answers</button>` 
              : `<button id="next-fl-btn" class="btn-gold">Next Line</button>`}
          </div>
        </div>
      </div>
    `;
  }

  generateFirstLastQuestion() {
    const maxLine = this.pageData.lines.length;
    const lineIndex = Math.floor(Math.random() * maxLine) + 1;
    const lineObj = this.pageData.lines.find(l => l.line === lineIndex);

    const words = lineObj.words.filter(w => w.type === 'word');
    if (words.length === 0) {
      this.generateFirstLastQuestion();
      return;
    }

    const firstWord = words[0].text;
    const lastWord = words[words.length - 1].text;

    this.flQuestion = {
      lineIndex,
      firstWord,
      lastWord
    };
    this.flRevealed = false;
  }

  setupEvents() {
    // Toggle sub-features
    this.container.querySelectorAll('.sf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.hideWordTooltip();
        this.container.querySelectorAll('.sf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentSubFeature = btn.dataset.feature;

        // Reset state for new questions
        this.connectorQuestion = null;
        this.coordQuestion = null;
        this.flQuestion = null;
        this.coordSelectedLine = null;
        
        this.render();
        this.setupEvents();
      });
    });
    
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

    // Silhouette block click handler with long press and toggle support
    if (this.currentSubFeature === 'silhouette') {
      const grid = this.container.querySelector('.mushaf-page-grid');
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
          el.classList.toggle('revealed', this.isWordShown(el.dataset.key));
        });
        this.updateSilhouetteProgress();
      });

      document.getElementById('sil-show-all-btn')?.addEventListener('click', () => {
        this.wordSequence.forEach(key => this.revealedWords.add(key));
        this.saveRevealed();
        this.container.querySelectorAll('.mushaf-word-box[data-key]').forEach(el => el.classList.add('revealed'));
        this.updateSilhouetteProgress();
      });

      // Previous / next page navigation (continuous study across a surah)
      const goToPage = (page) => {
        if (page < 1 || page > 604) return;
        if (window.app && window.app.surahSelector) {
          window.app.surahSelector.setCurrentPage(page);
        }
        this.loadPage(page);
      };
      document.getElementById('sil-prev-page')?.addEventListener('click', () => goToPage(this.currentPage - 1));
      document.getElementById('sil-next-page')?.addEventListener('click', () => goToPage(this.currentPage + 1));

      // Position the sequential-mode hint on initial render
      this.updateSilhouetteProgress();
    }

    // Line Connector options click handler
    if (this.currentSubFeature === 'connector' && this.connectorQuestion) {
      const feedbackCard = document.getElementById('connector-feedback');
      const feedbackTitle = document.getElementById('connector-feedback-title');
      const feedbackText = document.getElementById('connector-feedback-text');

      this.container.querySelectorAll('.option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const selected = btn.dataset.option;
          const correct = this.connectorQuestion.correctAnswer;
          
          this.container.querySelectorAll('.option-btn').forEach(b => {
            b.disabled = true;
            if (b.dataset.option === correct) {
              b.classList.add('correct');
            } else if (b.dataset.option === selected) {
              b.classList.add('incorrect');
            }
          });

          feedbackCard.style.display = 'block';
          if (selected === correct) {
            feedbackTitle.innerText = 'Correct!';
            feedbackTitle.style.color = 'var(--color-success)';
            feedbackText.innerText = `Great! "${correct}" is indeed the first word of Line ${this.connectorQuestion.lineIndex + 1}.`;
          } else {
            feedbackTitle.innerText = 'Incorrect';
            feedbackTitle.style.color = 'var(--color-error)';
            feedbackText.innerText = `The correct word starting Line ${this.connectorQuestion.lineIndex + 1} is "${correct}".`;
          }
        });
      });

      document.getElementById('next-connector-btn')?.addEventListener('click', () => {
        this.connectorQuestion = null;
        this.render();
        this.setupEvents();
      });
    }

    // Coordinate Finder line selector handler
    if (this.currentSubFeature === 'coordinates' && this.coordQuestion) {
      this.container.querySelectorAll('.coord-line').forEach(lineEl => {
        lineEl.addEventListener('click', () => {
          if (this.coordSelectedLine !== null) return; // Prevent double clicking
          
          const lineNum = parseInt(lineEl.dataset.line);
          const correct = this.coordQuestion.correctLine;
          
          this.coordSelectedLine = lineNum;
          this.coordIsCorrect = (lineNum === correct);
          
          this.render();
          this.setupEvents();
        });
      });

      document.getElementById('next-coord-btn')?.addEventListener('click', () => {
        this.coordQuestion = null;
        this.coordSelectedLine = null;
        this.render();
        this.setupEvents();
      });
    }

    // First/Last word drills event handlers
    if (this.currentSubFeature === 'first-last' && this.flQuestion) {
      document.getElementById('fl-reveal-btn')?.addEventListener('click', () => {
        this.flRevealed = true;
        this.render();
        this.setupEvents();
      });

      document.getElementById('next-fl-btn')?.addEventListener('click', () => {
        this.flQuestion = null;
        this.render();
        this.setupEvents();
      });
    }

    // Mushaf edition select event listener
    const editionSelect = document.getElementById('mushaf-edition-select');
    if (editionSelect) {
      editionSelect.addEventListener('change', (e) => {
        this.currentEdition = e.target.value;
        localStorage.setItem('mushaf-edition', this.currentEdition);
        
        // Reset subfeature states
        this.connectorQuestion = null;
        this.coordQuestion = null;
        this.flQuestion = null;
        this.coordSelectedLine = null;
        
        // Reload layouts with selected edition
        this.loadPage(this.currentPage);
      });
    }
  }

  // Scroll to and flash a verse on the currently loaded page. Used when jumping
  // here from another module (e.g. Voice Finder) that located a specific ayah.
  // Only the silhouette view has per-word verse-key elements, so it switches there
  // if another sub-feature was active; the flash is purely visual and doesn't
  // touch persisted reveal state.
  highlightVerse(verseKey) {
    if (this.currentSubFeature !== 'silhouette') {
      this.currentSubFeature = 'silhouette';
      this.connectorQuestion = null;
      this.coordQuestion = null;
      this.flQuestion = null;
      this.coordSelectedLine = null;
      this.render();
      this.setupEvents();
    }

    // render() above updates innerHTML synchronously, so the elements already
    // exist in the DOM — no need to wait a frame.
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
      const isMarked = this.markedWords.has(wordKey);
      const translation = this.getWordTranslation(target);
      title = `Word Options`;
      optionsHtml = `
        ${translation ? `<div class="context-menu-translation">${translation}</div>` : ''}
        <button class="context-menu-item" style="color: var(--color-error); font-weight: bold;" data-action="toggle-mark" data-value="${wordKey}">
          ${isMarked ? 'Unmark Word' : 'Mark as Forgotten (Red)'}
        </button>
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
        this.executeContextMenuAction(action, val);
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

  executeContextMenuAction(action, value) {
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
    } else if (action === 'toggle-mark') {
      if (this.markedWords.has(value)) {
        this.markedWords.delete(value);
      } else {
        this.markedWords.add(value);
      }
      db.saveProgress(`pagemap-marked-${this.currentPage}`, Array.from(this.markedWords));
      
      const wordEl = this.container.querySelector(`.mushaf-word-box[data-key="${value}"]`);
      if (wordEl) {
        wordEl.classList.toggle('marked-forgotten');
      }
    }
  }
}

