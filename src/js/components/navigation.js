// Quran Firm Plant - Sidebar Navigation Router
// Switches between different learning modules.

export class Navigation {
  constructor(onRouteCallback) {
    this.onRoute = onRouteCallback;
    this.navButtons = document.querySelectorAll('.nav-btn');
    this.setupEvents();
  }

  setupEvents() {
    this.navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const moduleName = btn.dataset.module;
        this.navigateTo(moduleName);
      });
    });
  }

  navigateTo(moduleName) {
    // Update active nav button
    this.navButtons.forEach(b => {
      if (b.dataset.module === moduleName) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });

    // Update Header title
    const titleMap = {
      'page-map': 'Visual Mushaf Page Map',
      'writing': 'Writing & Typing Practice',
      'voice-finder': 'Voice Recitation Finder',
      'quiz': 'Recitation Quiz',
      'mutashabihat': 'Mutashabihat (Similar Verses)',
      'mistakes': 'Mistake Dashboard & Drill',
      'memorization': 'Memorization Tracker'
    };
    
    const headerTitle = document.getElementById('module-title');
    if (headerTitle) {
      headerTitle.innerText = titleMap[moduleName] || 'Quran Memorization';
    }

    // Trigger routing callback
    if (this.onRoute) {
      this.onRoute(moduleName);
    }
  }
}
