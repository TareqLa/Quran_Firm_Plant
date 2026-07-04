// Quran Firm Plant - Writing & Typing Practice Module
// Implements handwriting canvas, character-by-character typing test, and fill-in-the-blanks.

import { db } from '../data/db.js';
import { quranLoader } from '../data/loader.js';

export class WritingPracticeModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);
    this.currentSurah = 87; // Default Al-A'la
    this.items = [];
    this.currentIndex = 0; // Index in the current list
    this.mode = 'handwriting'; // 'handwriting', 'typing', 'blanks'

    // Canvas drawing state
    this.canvas = null;
    this.ctx = null;
    this.isDrawing = false;
    this.brushSize = 3;
    this.brushColor = '#e8dcc8'; // Cream text color
    this.eraserMode = false;
    this.showGhost = true;
    this.writingChecked = false;

    // Typing test state
    this.typedText = '';
    this.currentWordIdx = 0;

    // Blanks state
    this.blankAnswers = {}; // Map of "blankIdx" to user input
    this.blankVerified = false;

    // Page-context state (only populated when loaded via loadPage)
    this.pageData = null;
    this.pageNumber = null;
    this.currentLineWordIdx = 0; // word-tracing cursor for handwriting mode

    // Whole-page writing mode: trace over the entire page and scroll it with a side slider
    this.writeWholePage = false;
  }

  async loadSurah(surahNumber) {
    this.currentContext = `surah-${surahNumber}`;
    this.pageData = null;
    this.pageNumber = null;
    this.container.innerHTML = `
      <div style="display: flex; justify-content: center; align-items: center; height: 200px;">
        <div class="status-indicator">
          <span class="status-dot animate-pulse" style="background-color: var(--accent-gold);"></span>
          <span>Loading writing sheet...</span>
        </div>
      </div>
    `;

    try {
      const ayahs = await db.getSurahText(surahNumber);
      if (ayahs.length === 0) {
        throw new Error('No local text found');
      }

      this.items = ayahs.map(a => ({
        label: `Ayah ${a.ayah} of ${a.totalAyahs}`,
        shortLabel: `Ayah ${a.ayah}`,
        text: a.text
      }));

      this.currentIndex = 0;
      this.resetStates();
      this.render();
      this.setupEvents();
    } catch (e) {
      console.error(e);
      this.container.innerHTML = `
        <div class="card" style="text-align: center; padding: 40px;">
          <h3 style="color: var(--color-error); margin-bottom: 12px;">Failed to Load</h3>
          <p>Please initialize the main database first.</p>
        </div>
      `;
    }
  }

  async loadPage(pageNumber) {
    this.currentContext = `page-${pageNumber}`;
    this.container.innerHTML = `
      <div style="display: flex; justify-content: center; align-items: center; height: 200px;">
        <div class="status-indicator">
          <span class="status-dot animate-pulse" style="background-color: var(--accent-gold);"></span>
          <span>Loading writing sheet...</span>
        </div>
      </div>
    `;

    try {
      const edition = localStorage.getItem('mushaf-edition') || 'v2';
      const pageData = await quranLoader.loadPage(pageNumber, edition);
      this.pageData = pageData;
      this.pageNumber = pageNumber;
      this.pageEdition = edition;

      this.items = pageData.lines
        .filter(l => l.words.some(w => w.type === 'word'))
        .map(l => {
          const wordObjs = l.words.filter(w => w.type === 'word');
          const text = wordObjs.map(w => w.text).join(' ');
          return {
            label: `Page ${pageNumber}, Line ${l.line}`,
            shortLabel: `Line ${l.line}`,
            text: text,
            lineNumber: l.line,
            // Per-word mushaf glyphs (char + font). word.text is unreliable in the
            // V1 edition (it can be a single glyph), so the ghost renders these glyphs.
            glyphWords: wordObjs.map(w => ({ char: w.char, font: w.font, text: w.text }))
          };
        });

      if (this.items.length === 0) throw new Error('No words found on this page');

      this.currentIndex = 0;
      this.resetStates();
      this.render();
      this.setupEvents();
    } catch (e) {
      console.error(e);
      this.container.innerHTML = `
        <div class="card" style="text-align: center; padding: 40px;">
          <h3 style="color: var(--color-error); margin-bottom: 12px;">Failed to Load</h3>
          <p>Could not load page layout.</p>
        </div>
      `;
    }
  }

  resetStates() {
    this.writingChecked = false;
    this.typedText = '';
    this.currentWordIdx = 0;
    this.currentLineWordIdx = 0;
    this.blankAnswers = {};
    this.blankVerified = false;
  }

  render() {
    const q = this.items[this.currentIndex];
    if (!q) return;

    this.container.innerHTML = `
      <!-- Toolbar for switching sub-modes -->
      <div class="blank-page-controls" style="margin-bottom: 24px;">
        <div class="toolbar-group">
          <button class="btn-outline mode-btn ${this.mode === 'handwriting' ? 'active' : ''}" data-mode="handwriting">Handwriting Sheet</button>
          <button class="btn-outline mode-btn ${this.mode === 'typing' ? 'active' : ''}" data-mode="typing">Typing Recall</button>
          <button class="btn-outline mode-btn ${this.mode === 'blanks' ? 'active' : ''}" data-mode="blanks">Fill in the Blanks</button>
        </div>
        <div class="toolbar-group" style="margin-left: auto; gap: 8px; font-weight: 500;">
          <button id="prev-item-btn" class="btn-outline" ${this.currentIndex === 0 ? 'disabled' : ''}>← Prev</button>
          <span style="font-size: 0.9rem; color: var(--text-secondary); align-self: center;">${q.label}</span>
          <button id="next-item-btn" class="btn-outline" ${this.currentIndex === this.items.length - 1 ? 'disabled' : ''}>Next →</button>
        </div>
      </div>

      ${this.pageData ? this.renderMushafFontStyles() : ''}

      <!-- Main Activity Box -->
      <div class="card" style="width: 100%; max-width: 800px; margin: 0 auto; padding: 0;">
        ${this.renderActivityContent()}
      </div>
    `;

    // Mode-specific initializations
    if (this.mode === 'handwriting') {
      if (this.pageData && this.writeWholePage) {
        this.initWholePageCanvas();
      } else {
        this.initCanvas();
      }
    } else if (this.mode === 'typing') {
      this.initTyping();
    }
  }

  // Injects @font-face rules for the mushaf glyph fonts used on this page.
  // The ghost tracing words render per-word glyphs with these fonts.
  renderMushafFontStyles() {
    const fonts = new Set();
    this.pageData.lines.forEach(l => l.words.forEach(w => { if (w.font) fonts.add(w.font); }));

    let fontStyles = '';
    fonts.forEach(fontName => {
      let fontUrl, format;
      if (this.pageEdition === 'v1') {
        fontUrl = `https://verses.quran.foundation/fonts/quran/hafs/v1/woff2/${fontName}.woff2`;
        format = 'woff2';
      } else {
        fontUrl = fontName === 'QCF4_QBSML'
          ? 'https://raw.githubusercontent.com/MohamadHajjRabee/quran-qcf4/main/fonts/QCF4_QBSML.ttf'
          : `https://raw.githubusercontent.com/MohamadHajjRabee/quran-qcf4/main/fonts/${fontName}_W.ttf`;
        format = 'truetype';
      }
      fontStyles += `@font-face { font-family: '${fontName}'; src: url('${fontUrl}') format('${format}'); }`;
    });

    return `<style>${fontStyles}</style>`;
  }

  // Patches the DOM directly (no full re-render) so zoom/pan state survives while tracing words.
  // The whole line stays visible; we just move the highlighted word.
  syncWordTrace(tokens) {
    const ghostContainer = document.getElementById('canvas-ghost-word');
    if (ghostContainer) {
      ghostContainer.querySelectorAll('.ghost-word').forEach((el, i) => {
        el.classList.toggle('ghost-word-active', i === this.currentLineWordIdx);
      });
    }

    const label = document.getElementById('word-trace-label');
    if (label) label.textContent = `Word ${this.currentLineWordIdx + 1}/${tokens.length}`;

    const prevBtn = document.getElementById('word-prev-btn');
    const nextBtn = document.getElementById('word-next-btn');
    if (prevBtn) prevBtn.disabled = this.currentLineWordIdx === 0;
    if (nextBtn) nextBtn.disabled = this.currentLineWordIdx === tokens.length - 1;
  }

  // Scales the ghost line's font-size so the whole line fits across the canvas width.
  _fitGhostLine() {
    const ghost = document.getElementById('canvas-ghost-word');
    const wrapper = ghost?.parentElement;
    if (!ghost || !wrapper) return;

    ghost.style.fontSize = ''; // reset to the CSS base size before measuring
    const avail = wrapper.clientWidth * 0.94;
    if (!avail) return;

    const contentWidth = ghost.scrollWidth;
    if (contentWidth > avail) {
      const baseFs = parseFloat(getComputedStyle(ghost).fontSize);
      ghost.style.fontSize = (baseFs * avail / contentWidth) + 'px';
    }
  }

  // Returns the current line's words as { text, font } tokens. In page mode these are
  // the mushaf glyphs (word.text is unreliable in V1); in surah mode they're the
  // plain ayah words.
  _currentWordTokens() {
    const q = this.items[this.currentIndex];
    if (q.glyphWords && q.glyphWords.length) {
      return q.glyphWords.map(g => ({ text: g.char, font: g.font }));
    }
    return q.text.trim().split(/\s+/).map(t => ({ text: t, font: null }));
  }

  _ghostHtml(token) {
    if (!token) return '';
    return token.font
      ? `<span style="font-family: '${token.font}';">${token.text}</span>`
      : token.text;
  }

  // The full line, rendered as faint mushaf glyphs, with the current word highlighted —
  // so the user traces over the whole line as if writing directly on the Mushaf.
  _ghostLineHtml(tokens) {
    return tokens.map((t, i) => {
      const cls = i === this.currentLineWordIdx ? 'ghost-word ghost-word-active' : 'ghost-word';
      const style = t.font ? `font-family: '${t.font}';` : '';
      return `<span class="${cls}" style="${style}">${t.text}</span>`;
    }).join(' ');
  }

  _svgEye() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
      <circle cx="12" cy="12" r="3"></circle></svg>`;
  }
  _svgEraser() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M20 20H7L3 16l7-7 7 7-4 4z"></path>
      <path d="M12 9l6-6 4 4-6 6"></path></svg>`;
  }

  _renderHandwriting(q) {
    const tokens = this._currentWordTokens();
    const canWholePage = !!this.pageData;
    const whole = canWholePage && this.writeWholePage;

    const wordControls = whole ? '' : `
      <button id="word-prev-btn" class="brush-btn" title="Previous word" ${this.currentLineWordIdx === 0 ? 'disabled' : ''}>‹</button>
      <span id="word-trace-label" style="font-size: 0.8rem; color: var(--text-secondary); min-width: 56px; text-align: center;">Word ${this.currentLineWordIdx + 1}/${tokens.length}</span>
      <button id="word-next-btn" class="brush-btn" title="Next word" ${this.currentLineWordIdx === tokens.length - 1 ? 'disabled' : ''}>›</button>`;

    const pageToggle = canWholePage ? `
      <button id="pagewrite-toggle" class="brush-btn ${whole ? 'active' : ''}" title="${whole ? 'Switch to single line' : 'Write on the whole page'}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="3" width="16" height="18" rx="1"></rect>
          <line x1="8" y1="8" x2="16" y2="8"></line>
          <line x1="8" y1="12" x2="16" y2="12"></line>
          <line x1="8" y1="16" x2="13" y2="16"></line>
        </svg>
      </button>` : '';

    const label = whole ? `Write Page ${this.pageNumber}` : `Write ${q.shortLabel}`;
    const body = whole ? this._wholePageBodyHtml() : this._singleLineBodyHtml(tokens);

    return `
      <div class="canvas-card">
        <div class="canvas-toolbar">
          <div class="toolbar-group">
            <span class="prompt-label" style="color: var(--accent-gold);">${label}:</span>
          </div>
          <div class="toolbar-group">
            ${wordControls}
            ${pageToggle}
            <button id="ghost-toggle" class="brush-btn ${this.showGhost ? 'active' : ''}" title="Toggle Ghost Trace text">${this._svgEye()}</button>
            <button id="eraser-toggle" class="brush-btn ${this.eraserMode ? 'active' : ''}" title="Eraser">${this._svgEraser()}</button>
            <button id="canvas-clear" class="btn-outline" style="padding: 6px 12px; font-size: 0.8rem;">Clear</button>
          </div>
        </div>

        ${body}

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; width: 100%;">
          <button id="check-writing-btn" class="btn-gold">Check Writing</button>
          ${whole ? '' : `
            <div id="writing-answer-box" class="quran-text" style="display: ${this.writingChecked ? 'block' : 'none'}; font-size: 2.1rem; color: var(--accent-gold); margin-top: 8px;">
              ${tokens.map(t => this._ghostHtml(t)).join(' ')}
            </div>`}
        </div>
      </div>
    `;
  }

  _singleLineBodyHtml(tokens) {
    return `
      <div class="canvas-wrapper">
        <canvas id="writing-canvas" class="canvas-sheet"></canvas>
        <canvas id="canvas-lines" class="canvas-bg-lines"></canvas>
        <div class="canvas-ghost-word" id="canvas-ghost-word" style="display: ${this.showGhost ? 'block' : 'none'};">${this._ghostLineHtml(tokens)}</div>
      </div>`;
  }

  _wholePageBodyHtml() {
    return `
      <div class="pagewrite-row">
        <div class="pagewrite-viewport" id="pagewrite-viewport">
          <div class="pagewrite-inner" id="pagewrite-inner">
            <div class="canvas-ghost-page" id="canvas-ghost-page" style="display: ${this.showGhost ? 'block' : 'none'};">
              ${this._ghostPageHtml()}
            </div>
            <canvas id="writing-canvas" class="pagewrite-canvas"></canvas>
          </div>
        </div>
        <div class="pagewrite-slider-col">
          <span class="pagewrite-slider-hint">▲</span>
          <input type="range" id="pagewrite-slider" class="pagewrite-slider" min="0" max="1000" value="0" aria-label="Scroll page up and down">
          <span class="pagewrite-slider-hint">▼</span>
        </div>
      </div>`;
  }

  // The entire page rendered as faint mushaf glyphs, to trace over line by line.
  _ghostPageHtml() {
    return this.pageData.lines.map(lineObj => {
      let inner = '';
      lineObj.words.forEach(word => {
        if (word.type === 'word') {
          inner += `<span class="ghost-word" style="font-family: '${word.font}';">${word.char}</span>`;
        } else if (word.type === 'end') {
          const verseNum = word.verse_key ? word.verse_key.split(':')[1] : '';
          inner += `<span class="ghost-word ghost-ayah-end">${verseNum}</span>`;
        } else if (word.type === 'surah_header') {
          const surahName = this.pageData.surahs.find(s => s.id === word.sura)?.name_arabic || '';
          inner += `<span class="ghost-page-surah">سُورَةُ ${surahName}</span>`;
        } else if (word.type === 'bismillah') {
          inner += `<span class="ghost-page-bismillah">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</span>`;
        }
      });
      return `<div class="ghost-page-line">${inner}</div>`;
    }).join('');
  }

  renderActivityContent() {
    const q = this.items[this.currentIndex];

    if (this.mode === 'handwriting') {
      return this._renderHandwriting(q);
    }

    if (this.mode === 'typing') {
      return `
        <div class="typing-card">
          <div class="prompt-label" style="text-align: center;">Type the full text:</div>
          <div class="typing-prompt" id="typing-prompt-display">
            <!-- Populated via Javascript -->
          </div>
          <input type="text" id="typing-input-box" class="typing-input" placeholder="Type here in Arabic..." autocomplete="off">
          <div style="text-align: center; font-size: 0.8rem; color: var(--text-muted); margin-top: 8px;">
            Typing auto-validates character by character. Hit Space after each correct word.
          </div>
        </div>
      `;
    }

    if (this.mode === 'blanks') {
      const words = q.text.trim().split(/\s+/);
      // Let's blank out every 2nd or 3rd word, at least 1 and max 3
      const blankIndices = [];
      for (let i = 1; i < words.length; i += 2) {
        blankIndices.push(i);
        if (blankIndices.length >= 3) break;
      }
      if (blankIndices.length === 0) blankIndices.push(0); // safeguard

      let sentenceHtml = '';
      words.forEach((word, idx) => {
        const isBlank = blankIndices.includes(idx);
        if (isBlank) {
          const isCorrect = this.blankVerified && (this.blankAnswers[idx] || '').trim() === word;
          const isIncorrect = this.blankVerified && (this.blankAnswers[idx] || '').trim() !== word;
          let inputStyle = 'width: 130px; display: inline-block; font-size: 1.8rem; font-family: var(--font-arabic); vertical-align: middle; margin: 0 4px; padding: 4px; text-align: center; border-radius: var(--border-radius-sm); border: 2px solid var(--border-color); background-color: var(--bg-tertiary); color: var(--text-primary);';
          
          if (isCorrect) {
            inputStyle += 'border-color: var(--color-success); background-color: rgba(76, 175, 80, 0.15);';
          } else if (isIncorrect) {
            inputStyle += 'border-color: var(--color-error); background-color: rgba(244, 67, 54, 0.15);';
          }

          const val = this.blankAnswers[idx] || '';
          sentenceHtml += `
            <input type="text" class="blank-input-field" 
                   data-idx="${idx}" 
                   data-correct="${word}"
                   value="${val}" 
                   style="${inputStyle}" 
                   placeholder="؟؟؟" 
                   autocomplete="off" 
                   ${this.blankVerified ? 'disabled' : ''}>
          `;
        } else {
          sentenceHtml += `<span style="display: inline-block; margin: 0 6px; vertical-align: middle;">${word}</span>`;
        }
      });

      return `
        <div class="typing-card" style="padding: 40px 24px;">
          <div class="prompt-label" style="text-align: center; margin-bottom: 24px;">Fill in the missing words:</div>
          <div class="quran-text" style="text-align: center; line-height: 3; font-size: 2.2rem; direction: rtl;">
            ${sentenceHtml}
          </div>
          
          <div style="display: flex; flex-direction: column; align-items: center; gap: 16px; margin-top: 32px;">
            ${!this.blankVerified 
              ? `<button id="verify-blanks-btn" class="btn-gold" style="width: 200px; justify-content: center;">Check Answers</button>`
              : `
                <div style="text-align: center;">
                  <h4 style="margin-bottom: 12px; font-weight: 700;">Correct Verse:</h4>
                  <div class="quran-text" style="color: var(--accent-gold); font-size: 2rem;">${q.text}</div>
                  <button id="retry-blanks-btn" class="btn-outline" style="margin-top: 16px;">Try Again</button>
                </div>
              `}
          </div>
        </div>
      `;
    }

    return '';
  }

  // --- Handwriting Canvas logic ---
  initCanvas() {
    this.canvas = document.getElementById('writing-canvas');
    if (!this.canvas) return;

    this.ctx = this.canvas.getContext('2d');
    
    // Make canvas responsive to its bounds
    const resize = () => {
      const rect = this.canvas.parentNode.getBoundingClientRect();
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;

      // Draw background lines once resized
      this.drawBgLines();
      this._fitGhostLine();
    };

    resize();
    window.addEventListener('resize', resize);
    // Re-fit once the mushaf fonts finish loading (glyph widths change the line width)
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => this._fitGhostLine());
    }

    this._attachDrawingEvents();
  }

  _attachDrawingEvents() {
    // Mouse Events
    this.canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
    this.canvas.addEventListener('mousemove', (e) => this.draw(e));
    this.canvas.addEventListener('mouseup', () => this.stopDrawing());
    this.canvas.addEventListener('mouseleave', () => this.stopDrawing());

    // Touch Events (Mobile/Tablet)
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.startDrawing(e.touches[0]);
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      this.draw(e.touches[0]);
    }, { passive: false });
    this.canvas.addEventListener('touchend', () => this.stopDrawing());
  }

  // --- Whole-page writing: trace the entire page, scroll with the side slider ---
  initWholePageCanvas() {
    this.canvas = document.getElementById('writing-canvas');
    const viewport = document.getElementById('pagewrite-viewport');
    const inner = document.getElementById('pagewrite-inner');
    const ghost = document.getElementById('canvas-ghost-page');
    const slider = document.getElementById('pagewrite-slider');
    if (!this.canvas || !viewport || !inner) return;

    this.ctx = this.canvas.getContext('2d');

    // Size the canvas to the full rendered page so strokes are anchored to it and
    // preserved while scrolling. Re-run once fonts settle (glyph widths change height).
    const sizeCanvas = () => {
      const w = inner.clientWidth;
      const h = ghost ? ghost.offsetHeight : inner.scrollHeight;
      if (!w || !h) return;
      // Only resize (which clears strokes) if the dimensions actually changed
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.canvas.style.height = h + 'px';
      }
      this._syncPageSlider();
    };

    sizeCanvas();
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => sizeCanvas());
    }
    // A couple of retries in case layout/fonts settle slightly later
    setTimeout(sizeCanvas, 200);
    setTimeout(sizeCanvas, 600);

    // Side slider drives vertical scroll
    slider?.addEventListener('input', () => {
      const max = viewport.scrollHeight - viewport.clientHeight;
      viewport.scrollTop = (slider.value / 1000) * max;
    });
    // Keep slider in sync when scrolled via wheel/trackpad
    viewport.addEventListener('scroll', () => this._syncPageSlider());

    this._attachDrawingEvents();
  }

  _syncPageSlider() {
    const viewport = document.getElementById('pagewrite-viewport');
    const slider = document.getElementById('pagewrite-slider');
    if (!viewport || !slider) return;
    const max = viewport.scrollHeight - viewport.clientHeight;
    slider.value = max > 0 ? Math.round((viewport.scrollTop / max) * 1000) : 0;
  }

  drawBgLines() {
    const bgLinesCanvas = document.getElementById('canvas-lines');
    if (!bgLinesCanvas) return;
    const bgCtx = bgLinesCanvas.getContext('2d');
    
    bgLinesCanvas.width = this.canvas.width;
    bgLinesCanvas.height = this.canvas.height;
    
    bgCtx.strokeStyle = 'rgba(212, 175, 55, 0.25)';
    bgCtx.lineWidth = 1.5;

    // Draw notebook lines
    const lineSpacing = bgLinesCanvas.height / 3;
    
    // Line 1
    bgCtx.beginPath();
    bgCtx.moveTo(0, lineSpacing);
    bgCtx.lineTo(bgLinesCanvas.width, lineSpacing);
    bgCtx.stroke();

    // Line 2
    bgCtx.beginPath();
    bgCtx.moveTo(0, lineSpacing * 2);
    bgCtx.lineTo(bgLinesCanvas.width, lineSpacing * 2);
    bgCtx.stroke();
  }

  startDrawing(e) {
    this.isDrawing = true;
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);
    
    // Eraser truly clears to transparent (works over both the plain sheet and the page ghost)
    this.ctx.globalCompositeOperation = this.eraserMode ? 'destination-out' : 'source-over';

    this.ctx.beginPath();
    this.ctx.moveTo(x, y);

    // Draw dot on click
    this.ctx.arc(x, y, (this.eraserMode ? 25 : this.brushSize) / 2, 0, Math.PI * 2);
    this.ctx.fillStyle = this.brushColor;
    this.ctx.fill();
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
  }

  draw(e) {
    if (!this.isDrawing) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);

    this.ctx.globalCompositeOperation = this.eraserMode ? 'destination-out' : 'source-over';
    this.ctx.lineTo(x, y);
    this.ctx.strokeStyle = this.brushColor;
    this.ctx.lineWidth = this.eraserMode ? 25 : this.brushSize;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.stroke();
  }

  stopDrawing() {
    this.isDrawing = false;
  }

  clearCanvas() {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  // --- Typing Mode logic ---
  initTyping() {
    const q = this.items[this.currentIndex];
    const words = q.text.trim().split(/\s+/);

    const promptDisplay = document.getElementById('typing-prompt-display');
    const inputBox = document.getElementById('typing-input-box');
    if (!promptDisplay || !inputBox) return;

    // Render typing prompt words
    const renderPrompt = () => {
      promptDisplay.innerHTML = words.map((w, idx) => {
        let cls = '';
        if (idx < this.currentWordIdx) {
          cls = 'typed-correct';
        } else if (idx === this.currentWordIdx) {
          cls = 'current-word';
        }
        return `<span class="${cls}">${w}</span>`;
      }).join(' ');
    };

    renderPrompt();

    // Input listening
    inputBox.focus();
    
    inputBox.addEventListener('input', (e) => {
      const val = e.target.value;
      const targetWord = words[this.currentWordIdx];
      
      // Compare current typed stroke
      // Ignore trailing space for match check
      const trimmedVal = val.trim();
      const isCorrectStroke = targetWord.startsWith(trimmedVal);
      
      if (isCorrectStroke) {
        inputBox.classList.remove('error-stroke');
        inputBox.classList.add('correct-stroke');
      } else {
        inputBox.classList.remove('correct-stroke');
        inputBox.classList.add('error-stroke');
      }

      // Check if word completed on Space press or exact string match
      const lastChar = val[val.length - 1];
      if (trimmedVal === targetWord && (lastChar === ' ' || this.currentWordIdx === words.length - 1)) {
        this.currentWordIdx++;
        inputBox.value = '';
        inputBox.classList.remove('correct-stroke', 'error-stroke');
        
        if (this.currentWordIdx >= words.length) {
          // Finished the whole Ayah!
          // Add highlight animation
          promptDisplay.style.color = 'var(--color-success)';
          setTimeout(() => {
            promptDisplay.style.color = '';
            // Auto advance to next item
            if (this.currentIndex < this.items.length - 1) {
              this.currentIndex++;
              this.resetStates();
              this.render();
              this.setupEvents();
            } else {
              alert('Congratulations! You completed the typing recall for the entire text!');
            }
          }, 1000);
        } else {
          renderPrompt();
        }
      }
    });
  }

  setupEvents() {
    const q = this.items[this.currentIndex];

    // Prev / Next Buttons
    document.getElementById('prev-item-btn')?.addEventListener('click', () => {
      if (this.currentIndex > 0) {
        this.currentIndex--;
        this.resetStates();
        this.render();
        this.setupEvents();
      }
    });

    document.getElementById('next-item-btn')?.addEventListener('click', () => {
      if (this.currentIndex < this.items.length - 1) {
        this.currentIndex++;
        this.resetStates();
        this.render();
        this.setupEvents();
      }
    });

    // Toggle sub-modes
    this.container.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.container.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.mode = btn.dataset.mode;
        
        this.resetStates();
        this.render();
        this.setupEvents();
      });
    });

    // Handwriting Controls
    if (this.mode === 'handwriting') {
      document.getElementById('canvas-clear')?.addEventListener('click', () => this.clearCanvas());

      const ghostToggle = document.getElementById('ghost-toggle');
      ghostToggle?.addEventListener('click', () => {
        this.showGhost = !this.showGhost;
        ghostToggle.classList.toggle('active', this.showGhost);
        const ghost = this.container.querySelector('.canvas-ghost-word, .canvas-ghost-page');
        if (ghost) ghost.style.display = this.showGhost ? 'block' : 'none';
      });

      const eraserToggle = document.getElementById('eraser-toggle');
      eraserToggle?.addEventListener('click', () => {
        this.eraserMode = !this.eraserMode;
        eraserToggle.classList.toggle('active', this.eraserMode);
      });

      // Toggle whole-page writing mode
      document.getElementById('pagewrite-toggle')?.addEventListener('click', () => {
        this.writeWholePage = !this.writeWholePage;
        this.resetStates();
        this.render();
        this.setupEvents();
      });

      document.getElementById('check-writing-btn')?.addEventListener('click', () => {
        this.writingChecked = true;
        const ans = document.getElementById('writing-answer-box');
        if (ans) ans.style.display = 'block';
      });

      const tokens = this._currentWordTokens();
      document.getElementById('word-prev-btn')?.addEventListener('click', () => {
        if (this.currentLineWordIdx > 0) {
          this.currentLineWordIdx--;
          this.syncWordTrace(tokens);
        }
      });
      document.getElementById('word-next-btn')?.addEventListener('click', () => {
        if (this.currentLineWordIdx < tokens.length - 1) {
          this.currentLineWordIdx++;
          this.syncWordTrace(tokens);
        }
      });
    }

    // Blanks Controls
    if (this.mode === 'blanks') {
      const inputs = this.container.querySelectorAll('.blank-input-field');
      
      inputs.forEach(input => {
        input.addEventListener('input', (e) => {
          const idx = e.target.dataset.idx;
          this.blankAnswers[idx] = e.target.value;
        });
      });

      document.getElementById('verify-blanks-btn')?.addEventListener('click', () => {
        this.blankVerified = true;
        this.render();
        this.setupEvents();
      });

      document.getElementById('retry-blanks-btn')?.addEventListener('click', () => {
        this.resetStates();
        this.render();
        this.setupEvents();
      });
    }
  }
}
