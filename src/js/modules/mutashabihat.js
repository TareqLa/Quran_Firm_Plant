// Quran Firm Plant - Mutashabihat (Similar Verses) Module
// Lists similar verses side-by-side with color-coded difference highlights.

import { db } from '../data/db.js';

export class MutashabihatModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);
    this.currentSurah = 87; // Default Al-A'la
    this.groups = [];
    this.currentGroupIdx = 0;
    this.studyMode = 'side-by-side'; // 'side-by-side', 'flashcard'
    this.flashcardRevealed = false;
  }

  async loadSurah(surahNumber) {
    this.currentSurah = surahNumber;
    this.container.innerHTML = `
      <div style="display: flex; justify-content: center; align-items: center; height: 200px;">
        <div class="status-indicator">
          <span class="status-dot animate-pulse" style="background-color: var(--accent-gold);"></span>
          <span>Loading Mutashabihat...</span>
        </div>
      </div>
    `;

    try {
      this.groups = await db.getMutashabihatForSurah(surahNumber);
      this.currentGroupIdx = 0;
      this.flashcardRevealed = false;
      this.render();
      this.setupEvents();
    } catch (e) {
      console.error(e);
      this.container.innerHTML = `<div class="card" style="text-align: center; color: var(--color-error); padding: 40px;">Failed to load Mutashabihat.</div>`;
    }
  }

  render() {
    if (this.groups.length === 0) {
      this.container.innerHTML = `
        <div class="card" style="text-align: center; padding: 48px; border-color: var(--border-color);">
          <h3 style="color: var(--accent-gold); margin-bottom: 8px;">No Mutashabihat Found</h3>
          <p style="color: var(--text-secondary); max-width: 480px; margin: 0 auto; line-height: 1.5;">
            We don't have registered Mutashabihat (similar verses) for Surah ${this.currentSurah} in the current database.
            Select a different Surah (like Al-A'la 87, Al-Waqi'ah 56, or Ash-Shams 9) to review.
          </p>
        </div>
      `;
      return;
    }

    const g = this.groups[this.currentGroupIdx];
    
    this.container.innerHTML = `
      <div class="blank-page-controls" style="margin-bottom: 24px;">
        <div class="toolbar-group">
          <button class="btn-outline mmode-btn ${this.studyMode === 'side-by-side' ? 'active' : ''}" data-mode="side-by-side">Comparison View</button>
          <button class="btn-outline mmode-btn ${this.studyMode === 'flashcard' ? 'active' : ''}" data-mode="flashcard">Flashcards</button>
        </div>
        <div class="toolbar-group" style="margin-left: auto; gap: 8px;">
          <button id="prev-mut-btn" class="btn-outline" ${this.currentGroupIdx === 0 ? 'disabled' : ''}>← Previous</button>
          <span style="font-size: 0.9rem; color: var(--text-secondary); align-self: center;">Set ${this.currentGroupIdx + 1} of ${this.groups.length}</span>
          <button id="next-mut-btn" class="btn-outline" ${this.currentGroupIdx === this.groups.length - 1 ? 'disabled' : ''}>Next →</button>
        </div>
      </div>

      <div id="mutashabihat-body" style="width: 100%;">
        ${this.renderStudyContent(g)}
      </div>
    `;

    this.setupEvents();
  }

  renderStudyContent(g) {
    if (this.studyMode === 'side-by-side') {
      return `
        <div class="mutashabihat-comparison">
          ${g.verses.map((v, idx) => {
            // Apply diff highlighting to the verse
            const highlightedText = this.highlightDifferences(v.text, g.differences, idx);
            return `
              <div class="comparison-card">
                <div class="comparison-header">
                  <span class="comparison-surah">${v.surah_name}</span>
                  <span class="comparison-ayah-num">Ayah ${v.ayah_number}</span>
                </div>
                <div class="diff-text quran-text">
                  ${highlightedText}
                </div>
              </div>
            `;
          }).join('')}
        </div>

        ${g.differences && g.differences.length > 0 ? `
          <div class="note-box card" style="margin-top: 24px;">
            <h4 style="color: var(--accent-gold); margin-bottom: 6px; font-weight: 700;">Key Differences to Remember:</h4>
            <ul style="padding-left: 20px; line-height: 1.6; font-size: 0.95rem; display: flex; flex-direction: column; gap: 4px;">
              ${g.differences.map(d => `<li>${d}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      `;
    }

    if (this.studyMode === 'flashcard') {
      // Show first verse, hide the others
      const firstVerse = g.verses[0];
      const others = g.verses.slice(1);
      
      return `
        <div class="line-connector-card" style="max-width: 600px;">
          <!-- Front of card -->
          <div class="card" style="padding: 40px 32px; text-align: center; min-height: 250px; display: flex; flex-direction: column; justify-content: center; align-items: center; background-image: radial-gradient(circle at center, hsla(43, 80%, 55%, 0.01), transparent);">
            <span class="prompt-label" style="margin-bottom: 16px;">Flashcard Study</span>
            <div class="quran-text" style="font-size: 2.1rem; line-height: 1.8; margin-bottom: 12px;">${firstVerse.text}</div>
            <span class="prompt-label" style="color: var(--accent-gold);">${firstVerse.surah_name} : Ayah ${firstVerse.ayah_number}</span>
          </div>

          <div style="text-align: center; margin: 24px 0;">
            ${!this.flashcardRevealed 
              ? `<button id="reveal-mut-card" class="btn-gold" style="width: 200px; justify-content: center;">Reveal Similar Verses</button>`
              : `
                <div style="text-align: left; display: flex; flex-direction: column; gap: 16px;">
                  <h4 style="text-align: center; color: var(--accent-gold); font-weight: 700; text-transform: uppercase; font-size: 0.8rem; letter-spacing: 1px;">Similar Verse matches:</h4>
                  ${others.map((v, idx) => `
                    <div class="card" style="border-color: rgba(212, 175, 55, 0.25);">
                      <div class="comparison-header" style="margin-bottom: 8px;">
                        <span class="comparison-surah">${v.surah_name}</span>
                        <span class="comparison-ayah-num">Ayah ${v.ayah_number}</span>
                      </div>
                      <div class="quran-text" style="font-size: 1.8rem; text-align: right;">
                        ${this.highlightDifferences(v.text, g.differences, idx + 1)}
                      </div>
                    </div>
                  `).join('')}
                  
                  <button id="hide-mut-card" class="btn-outline" style="width: 150px; align-self: center; justify-content: center; margin-top: 12px;">Hide</button>
                </div>
              `}
          </div>
        </div>
      `;
    }

    return '';
  }

  // Highlights matching parts based on the differences list
  highlightDifferences(text, differences, verseIdx) {
    if (!differences || differences.length === 0) return text;
    
    let highlighted = text;

    differences.forEach(diff => {
      // Splitting a diff format like "سَبِّحِ اسْمَ (Al-A'la) vs فَسَبِّحْ بِاسْمِ (Al-Waqi'ah)"
      const parts = diff.split(/\s+vs\s+/);
      const targetDiffPart = parts[verseIdx];
      
      if (targetDiffPart) {
        // Strip out the surah name marker inside parentheses, e.g. "سَبِّحِ اسْمَ (Al-A'la)" -> "سَبِّحِ اسْمَ"
        const cleanWord = targetDiffPart.replace(/\s*\(.*?\)/g, '').trim();
        
        if (cleanWord && text.includes(cleanWord)) {
          const colorClass = verseIdx === 0 ? 'diff-word-highlight-green' : 'diff-word-highlight-red';
          const replacement = `<span class="${colorClass}">${cleanWord}</span>`;
          
          // Simple replace (only once to avoid multi-matches of common particles)
          highlighted = highlighted.replace(cleanWord, replacement);
        }
      }
    });

    return highlighted;
  }

  setupEvents() {
    // Mode toggle
    this.container.querySelectorAll('.mmode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.container.querySelectorAll('.mmode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.studyMode = btn.dataset.mode;
        this.flashcardRevealed = false;
        this.render();
      });
    });

    // Pagination events
    document.getElementById('prev-mut-btn')?.addEventListener('click', () => {
      if (this.currentGroupIdx > 0) {
        this.currentGroupIdx--;
        this.flashcardRevealed = false;
        this.render();
      }
    });

    document.getElementById('next-mut-btn')?.addEventListener('click', () => {
      if (this.currentGroupIdx < this.groups.length - 1) {
        this.currentGroupIdx++;
        this.flashcardRevealed = false;
        this.render();
      }
    });

    // Flashcard reveal controls
    document.getElementById('reveal-mut-card')?.addEventListener('click', () => {
      this.flashcardRevealed = true;
      this.render();
    });

    document.getElementById('hide-mut-card')?.addEventListener('click', () => {
      this.flashcardRevealed = false;
      this.render();
    });
  }
}
