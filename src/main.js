// Quran Firm Plant - Main Application Controller
// Initializes data layers, triggers DB syncing, and routes Navigation events.

import './style.css';
import { db } from './js/data/db.js';
import { quranLoader } from './js/data/loader.js';
import { audioPlayer } from './js/components/audio-player.js';
import { Navigation } from './js/components/navigation.js';
import { SurahSelector, SURAH_LIST } from './js/components/surah-selector.js';

// Import learning modules
import { PageMapModule } from './js/modules/page-map.js';
import { WritingPracticeModule } from './js/modules/writing-practice.js';
import { VoiceFinderModule } from './js/modules/voice-finder.js';
import { RecitationQuizModule } from './js/modules/quiz.js';
import { MutashabihatModule } from './js/modules/mutashabihat.js';
import { MistakesModule } from './js/modules/mistakes.js';
import { MemorizationModule } from './js/modules/memorization.js';

class AppController {
  constructor() {
    this.activeModuleName = 'page-map';
    this.activeModuleInstance = null;
    
    this.surahSelector = null;
    this.navigation = null;

    // Set by navigateToPageMap() just before routing, so the page-map route
    // handler can jump to a specific page/ayah instead of restoring the last one.
    this.pendingPageMapPage = null;
    this.pendingPageMapVerseKey = null;

    // Cache references to global DOM overlays
    this.loadingOverlay = document.getElementById('db-loading-overlay');
    this.progressBar = document.getElementById('db-progress-bar');
    this.progressText = document.getElementById('db-progress-text');
    this.statusDot = document.querySelector('.status-dot');
    this.statusText = document.querySelector('.status-text');

    this.init();
  }

  async init() {
    console.log('Initializing Quran Firm Plant...');
    
    // 1. Initialize databases and check sync state
    const isSeeded = await quranLoader.checkSeeded();
    
    if (!isSeeded) {
      // Show loading overlay and seed database
      this.loadingOverlay.classList.add('active');
      const seedSuccess = await quranLoader.seedInitialData((p, msg) => {
        this.progressBar.style.width = `${p}%`;
        this.progressText.innerText = `${p}% - ${msg}`;
      });
      
      if (!seedSuccess) {
        this.progressText.innerText = 'Failed to seed database. Refresh to retry.';
        return;
      }
      
      this.loadingOverlay.classList.remove('active');
    } else {
      this.loadingOverlay.classList.remove('active');
    }

    // Update offline status dot in sidebar footer
    const footerStatus = document.querySelector('.status-indicator');
    if (footerStatus) {
      footerStatus.classList.add('online');
      this.statusText.innerText = 'Offline Database Ready';
    }

    // 2. Initialize Shared Components
    this.surahSelector = new SurahSelector('global-selector-container', (selection) => {
      this.handleSelectorChange(selection);
    });

    this.navigation = new Navigation((moduleName) => {
      this.handleRouteSwitch(moduleName);
      // Close sidebar on mobile after selecting a module
      this.closeMobileSidebar();
    });

    // 3. Setup mobile hamburger toggle
    this.setupMobileNav();

    // 4. Load initial default module: Visual Page Map (restores last opened page)
    this.handleRouteSwitch('page-map');
  }

  setupMobileNav() {
    const hamburger = document.getElementById('hamburger-btn');
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');

    if (hamburger && sidebar && backdrop) {
      hamburger.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        backdrop.classList.toggle('active');
      });

      backdrop.addEventListener('click', () => {
        this.closeMobileSidebar();
      });
    }
  }

  closeMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  }

  // Handles dropdown selections in the header (Surah switch or Page switch)
  handleSelectorChange({ surah, page, mode }) {
    console.log(`Selector changed to: Surah ${surah}, Page ${page} (Mode: ${mode})`);
    
    // Stop any playing audio
    audioPlayer.stop();

    if (this.activeModuleName === 'page-map') {
      // The Page Map module needs to load page layout data
      this.activeModuleInstance.loadPage(page);
    } else if (this.activeModuleName === 'writing') {
      if (mode === 'page') {
        this.activeModuleInstance.loadPage(page);
      } else {
        this.activeModuleInstance.loadSurah(surah);
      }
    } else {
      // Other modules load surah text
      this.activeModuleInstance.loadSurah(surah);
    }
  }

  // Handles routing/tab switching from the sidebar
  handleRouteSwitch(moduleName) {
    console.log(`Routing to module: ${moduleName}`);
    
    // Close any leftover context menus from other modules
    document.getElementById('mushaf-context-menu')?.remove();
    
    this.activeModuleName = moduleName;
    audioPlayer.stop();

    // Clear main content container
    const contentAreaId = 'app-content';
    
    // Toggle selector highlights depending on active module
    if (moduleName === 'page-map') {
      this.surahSelector.setMode('page');
      // Highlight the page selector button
      document.getElementById('page-trigger-btn').style.borderColor = 'var(--accent-gold)';
      document.getElementById('surah-trigger-btn').style.borderColor = '';
    } else if (moduleName === 'writing') {
      const currentMode = this.surahSelector.isPageMode ? 'page' : 'surah';
      if (currentMode === 'page') {
        document.getElementById('page-trigger-btn').style.borderColor = 'var(--accent-gold)';
        document.getElementById('surah-trigger-btn').style.borderColor = '';
      } else {
        document.getElementById('surah-trigger-btn').style.borderColor = 'var(--accent-gold)';
        document.getElementById('page-trigger-btn').style.borderColor = '';
      }
    } else {
      this.surahSelector.setMode('surah');
      // Highlight the Surah selector button
      document.getElementById('surah-trigger-btn').style.borderColor = 'var(--accent-gold)';
      document.getElementById('page-trigger-btn').style.borderColor = '';
    }

    // Instantiate and launch the chosen module
    switch (moduleName) {
      case 'page-map': {
        this.activeModuleInstance = new PageMapModule(contentAreaId);

        // If navigateToPageMap() requested a specific page/ayah (e.g. from Voice
        // Finder), use that instead of the last-opened page the constructor restored.
        const targetPage = this.pendingPageMapPage != null ? this.pendingPageMapPage : this.activeModuleInstance.currentPage;
        const targetVerseKey = this.pendingPageMapVerseKey;
        this.pendingPageMapPage = null;
        this.pendingPageMapVerseKey = null;

        this.surahSelector.setCurrentPage(targetPage);
        this.activeModuleInstance.loadPage(targetPage).then(() => {
          if (targetVerseKey) {
            this.activeModuleInstance.highlightVerse(targetVerseKey);
          }
        });
        break;
      }
        
      case 'writing':
        this.activeModuleInstance = new WritingPracticeModule(contentAreaId);
        if (this.surahSelector.isPageMode) {
          this.activeModuleInstance.loadPage(this.surahSelector.getCurrentPage());
        } else {
          this.activeModuleInstance.loadSurah(this.surahSelector.getCurrentSurah());
        }
        break;
        
      case 'voice-finder':
        this.activeModuleInstance = new VoiceFinderModule(contentAreaId);
        this.activeModuleInstance.render();
        break;
        
      case 'quiz':
        this.activeModuleInstance = new RecitationQuizModule(contentAreaId);
        this.activeModuleInstance.loadSurah(this.surahSelector.getCurrentSurah());
        break;
        
      case 'mutashabihat':
        this.activeModuleInstance = new MutashabihatModule(contentAreaId);
        this.activeModuleInstance.loadSurah(this.surahSelector.getCurrentSurah());
        break;

      case 'mistakes':
        this.activeModuleInstance = new MistakesModule(contentAreaId);
        this.activeModuleInstance.render();
        break;

      case 'memorization':
        this.activeModuleInstance = new MemorizationModule(contentAreaId);
        this.activeModuleInstance.render();
        break;

      default:
        console.error(`Unknown module: ${moduleName}`);
    }
  }

  // Public API: navigate to Visual Page Map at the exact page containing a specific ayah.
  // Called from other modules (e.g., Voice Finder) via window.app.navigateToPageMap(surah, ayah).
  async navigateToPageMap(surahNum, ayahNum) {
    const verseKey = `${surahNum}:${ayahNum}`;

    // Get the page range for this surah
    const surah = SURAH_LIST.find(s => s.id === surahNum);
    if (!surah) return;

    const [startPage, endPage] = surah.pages;
    let targetPage = startPage; // fallback to first page

    // Scan each page in the surah's range to find which one contains this verse
    for (let p = startPage; p <= endPage; p++) {
      const pageData = await quranLoader.loadPage(p, localStorage.getItem('mushaf-edition') || 'v2');
      if (!pageData) continue;

      const found = pageData.lines.some(line =>
        line.words.some(w => w.verse_key === verseKey)
      );

      if (found) {
        targetPage = p;
        break;
      }
    }

    // Stash the target so handleRouteSwitch('page-map') picks it up instead of
    // restoring whatever page was last opened.
    this.pendingPageMapPage = targetPage;
    this.pendingPageMapVerseKey = verseKey;
    this.surahSelector.setCurrentPage(targetPage);
    this.navigation.navigateTo('page-map');
  }

  // Public API: navigate to Writing Practice for a specific page
  navigateToWritingPage(pageNumber) {
    this.surahSelector.setMode('page');
    this.surahSelector.setCurrentPage(pageNumber);
    
    // Update header highlighting
    document.getElementById('page-trigger-btn').style.borderColor = 'var(--accent-gold)';
    document.getElementById('surah-trigger-btn').style.borderColor = '';

    // Switch to writing module
    this.navigation.navigateTo('writing');
  }
}

// Start the controller on load
window.addEventListener('DOMContentLoaded', () => {
  window.app = new AppController();
});
