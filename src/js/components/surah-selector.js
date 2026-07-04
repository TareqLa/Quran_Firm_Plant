// Quran Firm Plant - Surah and Page Selector Component
// Renders the searchable selector in the header, letting the user switch Surahs or Pages.

import { getSurahPagesRange } from '../data/loader.js';
import { db } from '../data/db.js';

// Metadata list for all 114 Surahs
export const SURAH_LIST = [
  { id: 1, name: "الفاتحة", nameEn: "Al-Fatihah", pages: [1, 1] },
  { id: 2, name: "البقرة", nameEn: "Al-Baqarah", pages: [2, 49] },
  { id: 3, name: "آل عمران", nameEn: "Ali 'Imran", pages: [50, 76] },
  { id: 4, name: "النساء", nameEn: "An-Nisa", pages: [77, 106] },
  { id: 5, name: "المائدة", nameEn: "Al-Ma'idah", pages: [107, 127] },
  { id: 6, name: "الأنعام", nameEn: "Al-An'am", pages: [128, 150] },
  { id: 7, name: "الأعراف", nameEn: "Al-A'raf", pages: [151, 176] },
  { id: 8, name: "الأنفال", nameEn: "Al-Anfal", pages: [177, 186] },
  { id: 9, name: "التوبة", nameEn: "At-Tawbah", pages: [187, 207] },
  { id: 10, name: "يونس", nameEn: "Yunus", pages: [208, 221] },
  { id: 11, name: "هود", nameEn: "Hud", pages: [221, 235] },
  { id: 12, name: "يوسف", nameEn: "Yusuf", pages: [235, 248] },
  { id: 13, name: "الرعد", nameEn: "Ar-Ra'd", pages: [249, 255] },
  { id: 14, name: "إبراهيم", nameEn: "Ibrahim", pages: [255, 261] },
  { id: 15, name: "الحجر", nameEn: "Al-Hijr", pages: [262, 267] },
  { id: 16, name: "النحل", nameEn: "An-Nahl", pages: [267, 281] },
  { id: 17, name: "الإسراء", nameEn: "Al-Isra", pages: [282, 293] },
  { id: 18, name: "الكهف", nameEn: "Al-Kahf", pages: [293, 304] },
  { id: 19, name: "مريم", nameEn: "Maryam", pages: [305, 312] },
  { id: 20, name: "طه", nameEn: "Taha", pages: [312, 321] },
  { id: 21, name: "الأنبياء", nameEn: "Al-Anbiya", pages: [322, 331] },
  { id: 22, name: "الحج", nameEn: "Al-Hajj", pages: [332, 341] },
  { id: 23, name: "المؤمنون", nameEn: "Al-Mu'minun", pages: [342, 349] },
  { id: 24, name: "النور", nameEn: "An-Nur", pages: [350, 359] },
  { id: 25, name: "الفرقان", nameEn: "Al-Furqan", pages: [359, 366] },
  { id: 26, name: "الشعراء", nameEn: "Ash-Shu'ara", pages: [367, 376] },
  { id: 27, name: "النمل", nameEn: "An-Naml", pages: [377, 385] },
  { id: 28, name: "القصص", nameEn: "Al-Qasas", pages: [385, 396] },
  { id: 29, name: "العنكبوت", nameEn: "Al-'Ankabut", pages: [396, 404] },
  { id: 30, name: "الروم", nameEn: "Ar-Rum", pages: [404, 410] },
  { id: 31, name: "لقمان", nameEn: "Luqman", pages: [411, 414] },
  { id: 32, name: "السجدة", nameEn: "As-Sajdah", pages: [415, 417] },
  { id: 33, name: "الأحزاب", nameEn: "Al-Ahzab", pages: [418, 427] },
  { id: 34, name: "سبأ", nameEn: "Saba", pages: [428, 434] },
  { id: 35, name: "فاطر", nameEn: "Fatir", pages: [434, 440] },
  { id: 36, name: "يس", nameEn: "Yasin", pages: [440, 445] },
  { id: 37, name: "الصافات", nameEn: "As-Saffat", pages: [446, 452] },
  { id: 38, name: "ص", nameEn: "Sad", pages: [453, 458] },
  { id: 39, name: "الزمر", nameEn: "Az-Zumar", pages: [458, 467] },
  { id: 40, name: "غافر", nameEn: "Ghafir", pages: [467, 476] },
  { id: 41, name: "فصلت", nameEn: "Fussilat", pages: [477, 482] },
  { id: 42, name: "الشورى", nameEn: "Ash-Shura", pages: [483, 489] },
  { id: 43, name: "الزخرف", nameEn: "Az-Zukhruf", pages: [489, 495] },
  { id: 44, name: "الدخان", nameEn: "Ad-Dukhan", pages: [496, 498] },
  { id: 45, name: "الجاثية", nameEn: "Al-Jathiyah", pages: [499, 502] },
  { id: 46, name: "الأحقاف", nameEn: "Al-Ahqaf", pages: [502, 506] },
  { id: 47, name: "محمد", nameEn: "Muhammad", pages: [507, 510] },
  { id: 48, name: "الفتح", nameEn: "Al-Fath", pages: [511, 515] },
  { id: 49, name: "الحجرات", nameEn: "Al-Hujurat", pages: [515, 517] },
  { id: 50, name: "ق", nameEn: "Qaf", pages: [518, 520] },
  { id: 51, name: "الذاريات", nameEn: "Adh-Dhariyat", pages: [520, 523] },
  { id: 52, name: "الطور", nameEn: "At-Tur", pages: [523, 525] },
  { id: 53, name: "النجم", nameEn: "An-Najm", pages: [526, 528] },
  { id: 54, name: "القمر", nameEn: "Al-Qamar", pages: [528, 531] },
  { id: 55, name: "الرحمن", nameEn: "Ar-Rahman", pages: [531, 534] },
  { id: 56, name: "الواقعة", nameEn: "Al-Waqi'ah", pages: [534, 537] },
  { id: 57, name: "الحديد", nameEn: "Al-Hadid", pages: [537, 541] },
  { id: 58, name: "المجادلة", nameEn: "Al-Mujadilah", pages: [542, 545] },
  { id: 59, name: "الحشر", nameEn: "Al-Hashr", pages: [545, 548] },
  { id: 60, name: "الممتحنة", nameEn: "Al-Mumtahanah", pages: [549, 551] },
  { id: 61, name: "الصف", nameEn: "As-Saff", pages: [551, 553] },
  { id: 62, name: "الجمعة", nameEn: "Al-Jumu'ah", pages: [553, 554] },
  { id: 63, name: "المنافقون", nameEn: "Al-Munafiqun", pages: [554, 555] },
  { id: 64, name: "التغابن", nameEn: "At-Taghabun", pages: [556, 557] },
  { id: 65, name: "الطلاق", nameEn: "At-Talaq", pages: [558, 559] },
  { id: 66, name: "التحريم", nameEn: "At-Tahrim", pages: [560, 561] },
  { id: 67, name: "الملك", nameEn: "Al-Mulk", pages: [562, 564] },
  { id: 68, name: "القلم", nameEn: "Al-Qalam", pages: [564, 566] },
  { id: 69, name: "الحاقة", nameEn: "Al-Haqqah", pages: [566, 568] },
  { id: 70, name: "المعارج", nameEn: "Al-Ma'arij", pages: [568, 570] },
  { id: 71, name: "نوح", nameEn: "Nuh", pages: [570, 572] },
  { id: 72, name: "الجن", nameEn: "Al-Jinn", pages: [572, 574] },
  { id: 73, name: "المزمل", nameEn: "Al-Muzzammil", pages: [574, 576] },
  { id: 74, name: "المدثر", nameEn: "Al-Muddaththir", pages: [576, 578] },
  { id: 75, name: "القيامة", nameEn: "Al-Qiyamah", pages: [578, 579] },
  { id: 76, name: "الإنسان", nameEn: "Al-Insan", pages: [579, 581] },
  { id: 77, name: "المرسلات", nameEn: "Al-Mursalat", pages: [581, 582] },
  { id: 78, name: "النبأ", nameEn: "An-Naba", pages: [582, 583] },
  { id: 79, name: "النازعات", nameEn: "An-Nazi'at", pages: [583, 585] },
  { id: 80, name: "عبس", nameEn: "'Abasa", pages: [585, 586] },
  { id: 81, name: "التكوير", nameEn: "At-Takwir", pages: [586, 587] },
  { id: 82, name: "الانفطار", nameEn: "Al-Infitar", pages: [587, 588] },
  { id: 83, name: "المطففين", nameEn: "Al-Mutaffifin", pages: [588, 589] },
  { id: 84, name: "الانشقاق", nameEn: "Al-Inshiqaq", pages: [589, 590] },
  { id: 85, name: "البروج", nameEn: "Al-Buruj", pages: [590, 590] },
  { id: 86, name: "الطارق", nameEn: "At-Tariq", pages: [591, 591] },
  { id: 87, name: "الأعلى", nameEn: "Al-A'la", pages: [591, 592] },
  { id: 88, name: "الغاشية", nameEn: "Al-Ghashiyah", pages: [592, 592] },
  { id: 89, name: "الفجر", nameEn: "Al-Fajr", pages: [593, 594] },
  { id: 90, name: "البلد", nameEn: "Al-Balad", pages: [594, 594] },
  { id: 91, name: "الشمس", nameEn: "Ash-Shams", pages: [595, 595] },
  { id: 92, name: "الليل", nameEn: "Al-Layl", pages: [595, 596] },
  { id: 93, name: "الضحى", nameEn: "Ad-Duha", pages: [596, 596] },
  { id: 94, name: "الشرح", nameEn: "Ash-Sharh", pages: [596, 597] },
  { id: 95, name: "التين", nameEn: "At-Tin", pages: [597, 597] },
  { id: 96, name: "العلق", nameEn: "Al-'Alaq", pages: [597, 598] },
  { id: 97, name: "القدر", nameEn: "Al-Qadr", pages: [598, 598] },
  { id: 98, name: "البينة", nameEn: "Al-Bayyinah", pages: [598, 599] },
  { id: 99, name: "الزلزلة", nameEn: "Az-Zalzalah", pages: [599, 599] },
  { id: 100, name: "العاديات", nameEn: "Al-'Adiyat", pages: [599, 600] },
  { id: 101, name: "القارعة", nameEn: "Al-Qari'ah", pages: [600, 600] },
  { id: 102, name: "التكاثر", nameEn: "At-Takathur", pages: [600, 600] },
  { id: 103, name: "العصر", nameEn: "Al-'Asr", pages: [601, 601] },
  { id: 104, name: "الهمزة", nameEn: "Al-Humazah", pages: [601, 601] },
  { id: 105, name: "الفيل", nameEn: "Al-Fil", pages: [601, 601] },
  { id: 106, name: "قريش", nameEn: "Quraysh", pages: [602, 602] },
  { id: 107, name: "الماعون", nameEn: "Al-Ma'un", pages: [602, 602] },
  { id: 108, name: "الكوثر", nameEn: "Al-Kawthar", pages: [602, 602] },
  { id: 109, name: "الكافرون", nameEn: "Al-Kafirun", pages: [603, 603] },
  { id: 110, name: "النصر", nameEn: "An-Nasr", pages: [603, 603] },
  { id: 111, name: "المسد", nameEn: "Al-Masad", pages: [603, 603] },
  { id: 112, name: "الإخلاص", nameEn: "Al-Ikhlas", pages: [604, 604] },
  { id: 113, name: "الفلق", nameEn: "Al-Falaq", pages: [604, 604] },
  { id: 114, name: "الناس", nameEn: "An-Nas", pages: [604, 604] }
];

export class SurahSelector {
  constructor(containerId, onSelectCallback) {
    this.container = document.getElementById(containerId);
    this.onSelect = onSelectCallback;
    
    // Default starting Surah: Al-A'la (87)
    this.currentSurah = 87;
    this.currentPage = 591;
    this.isPageMode = false;
    
    this.render();
    this.setupEvents();
  }

  getCurrentSurah() {
    return this.currentSurah;
  }

  getCurrentPage() {
    return this.currentPage;
  }

  setCurrentSurah(id) {
    this.currentSurah = parseInt(id);
    const surah = SURAH_LIST.find(s => s.id === this.currentSurah);
    if (surah) {
      this.currentPage = surah.pages[0];
      this.updateDisplay();
    }
  }

  setCurrentPage(pageNumber) {
    this.currentPage = parseInt(pageNumber);
    // Find which Surah covers this page
    const surah = SURAH_LIST.find(s => pageNumber >= s.pages[0] && pageNumber <= s.pages[s.pages.length - 1]);
    if (surah) {
      this.currentSurah = surah.id;
    }
    this.updateDisplay();
  }

  render() {
    this.container.innerHTML = `
      <div class="quran-selector">
        <button id="header-prev-btn" class="selector-btn" title="Previous">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <button id="surah-trigger-btn" class="selector-input">
          <span id="selected-surah-label">Surah Al-A'la (87)</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
        <button id="page-trigger-btn" class="selector-input">
          <span id="selected-page-label">Page 591</span>
        </button>
        <button id="header-next-btn" class="selector-btn" title="Next">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>

      <!-- Surah Selection Modal -->
      <div id="surah-modal" class="modal">
        <div class="modal-header">
          <h3 class="modal-title">Select Surah</h3>
          <button id="surah-modal-close" class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <input type="text" id="surah-search" class="search-input" placeholder="Search Surah (English or Arabic)...">
          <div id="surah-list-container" class="surah-grid"></div>
        </div>
      </div>

      <!-- Page Selection Modal -->
      <div id="page-modal" class="modal">
        <div class="modal-header">
          <h3 class="modal-title">Go to Page</h3>
          <button id="page-modal-close" class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <input type="number" id="page-search" class="search-input" min="1" max="604" placeholder="Enter page number (1-604)...">
          <button id="page-search-go" class="btn-gold" style="width: 100%; justify-content: center;">Go</button>
        </div>
      </div>
    `;

    this.renderSurahList();
  }

  updateDisplay() {
    const surah = SURAH_LIST.find(s => s.id === this.currentSurah);
    if (surah) {
      document.getElementById('selected-surah-label').innerText = `${surah.nameEn} (${surah.id})`;
    }
    document.getElementById('selected-page-label').innerText = `Page ${this.currentPage}`;
  }

  renderSurahList(filterText = '') {
    const container = document.getElementById('surah-list-container');
    const filtered = SURAH_LIST.filter(s => 
      s.nameEn.toLowerCase().includes(filterText.toLowerCase()) || 
      s.name.includes(filterText) ||
      String(s.id).includes(filterText)
    );

    container.innerHTML = filtered.map(s => `
      <div class="surah-grid-item" data-id="${s.id}">
        <div class="surah-item-left">
          <span class="surah-item-num">${s.id}</span>
          <span class="surah-item-name-en">${s.nameEn}</span>
        </div>
        <span class="surah-item-name-ar">${s.name}</span>
      </div>
    `).join('');
  }

  setupEvents() {
    const surahBtn = document.getElementById('surah-trigger-btn');
    const pageBtn = document.getElementById('page-trigger-btn');
    const prevBtn = document.getElementById('header-prev-btn');
    const nextBtn = document.getElementById('header-next-btn');

    const surahModal = document.getElementById('surah-modal');
    const surahClose = document.getElementById('surah-modal-close');
    const surahSearch = document.getElementById('surah-search');

    const pageModal = document.getElementById('page-modal');
    const pageClose = document.getElementById('page-modal-close');
    const pageSearch = document.getElementById('page-search');
    const pageGo = document.getElementById('page-search-go');

    // Toggle modals
    surahBtn.addEventListener('click', () => {
      surahModal.classList.add('active');
      surahSearch.value = '';
      this.renderSurahList();
      surahSearch.focus();
    });

    surahClose.addEventListener('click', () => surahModal.classList.remove('active'));

    pageBtn.addEventListener('click', () => {
      pageModal.classList.add('active');
      pageSearch.value = this.currentPage;
      pageSearch.focus();
    });

    pageClose.addEventListener('click', () => pageModal.classList.remove('active'));

    // Search events
    surahSearch.addEventListener('input', (e) => {
      this.renderSurahList(e.target.value);
    });

    // Select surah item
    document.getElementById('surah-list-container').addEventListener('click', (e) => {
      const item = e.target.closest('.surah-grid-item');
      if (item) {
        const id = parseInt(item.dataset.id);
        this.setCurrentSurah(id);
        surahModal.classList.remove('active');
        if (this.onSelect) this.onSelect({ surah: this.currentSurah, page: this.currentPage, mode: 'surah' });
      }
    });

    // Go to page
    const handlePageSubmit = () => {
      const pageVal = parseInt(pageSearch.value);
      if (pageVal >= 1 && pageVal <= 604) {
        this.setCurrentPage(pageVal);
        pageModal.classList.remove('active');
        if (this.onSelect) this.onSelect({ surah: this.currentSurah, page: this.currentPage, mode: 'page' });
      }
    };

    pageGo.addEventListener('click', handlePageSubmit);
    pageSearch.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handlePageSubmit();
    });

    // Prev / Next actions
    prevBtn.addEventListener('click', () => {
      if (this.isPageMode) {
        if (this.currentPage > 1) {
          this.setCurrentPage(this.currentPage - 1);
          if (this.onSelect) this.onSelect({ surah: this.currentSurah, page: this.currentPage, mode: 'page' });
        }
      } else {
        if (this.currentSurah > 1) {
          this.setCurrentSurah(this.currentSurah - 1);
          if (this.onSelect) this.onSelect({ surah: this.currentSurah, page: this.currentPage, mode: 'surah' });
        }
      }
    });

    nextBtn.addEventListener('click', () => {
      if (this.isPageMode) {
        if (this.currentPage < 604) {
          this.setCurrentPage(this.currentPage + 1);
          if (this.onSelect) this.onSelect({ surah: this.currentSurah, page: this.currentPage, mode: 'page' });
        }
      } else {
        if (this.currentSurah < 114) {
          this.setCurrentSurah(this.currentSurah + 1);
          if (this.onSelect) this.onSelect({ surah: this.currentSurah, page: this.currentPage, mode: 'surah' });
        }
      }
    });
  }

  setMode(mode) {
    this.isPageMode = (mode === 'page');
  }
}
