// Quran Firm Plant - Data Sync & Loader
// Downloads Quran text and page layout mappings from CDNs and seeds IndexedDB.

import { db } from './db.js';

const QURAN_TEXT_URL = 'https://cdn.jsdelivr.net/npm/quran-json@3.1.2/dist/quran.json';
const MUTASHABIHAT_URL = 'https://raw.githubusercontent.com/srmdn/quran-mutashabihat/master/quran-mutashabihat.json'; // fallback if fails

// Returns the raw GitHub URL for a page layout JSON
export function getPageUrl(pageNumber) {
  const paddedPage = String(pageNumber).padStart(3, '0');
  return `https://raw.githubusercontent.com/MohamadHajjRabee/quran-qcf4/main/pages/${paddedPage}.json`;
}

// Fallback Mutashabihat seed data in case the CDN is blocked/down
const FALLBACK_MUTASHABIHAT = [
  {
    "id": 1,
    "verses": [
      {
        "surah_number": 87,
        "surah_name": "الأعلى",
        "ayah_number": 1,
        "text": "سَبِّحِ اسْمَ رَبِّكَ الْأَعْلَى"
      },
      {
        "surah_number": 56,
        "surah_name": "الواقعة",
        "ayah_number": 74,
        "text": "فَسَبِّحْ بِاسْمِ رَبِّكَ الْعَظِيمِ"
      }
    ],
    "differences": [
      "سَبِّحِ اسْمَ (Al-A'la) vs فَسَبِّحْ بِاسْمِ (Al-Waqi'ah)",
      "الْأَعْلَى (Al-A'la) vs الْعَظِيمِ (Al-Waqi'ah)"
    ],
    "tags": ["Juz 30", "Juz 27", "Tasbeeh"]
  },
  {
    "id": 2,
    "verses": [
      {
        "surah_number": 87,
        "surah_name": "الأعلى",
        "ayah_number": 14,
        "text": "قَدْ أَفْلَحَ مَنْ تَزَكَّى"
      },
      {
        "surah_number": 91,
        "surah_name": "الشمس",
        "ayah_number": 9,
        "text": "قَدْ أَفْلَحَ مَنْ زَكَّاهَا"
      },
      {
        "surah_number": 23,
        "surah_name": "المؤمنون",
        "ayah_number": 1,
        "text": "قَدْ أَفْلَحَ الْمُؤْمِنُونَ"
      }
    ],
    "differences": [
      "تَزَكَّى (Al-A'la) vs زَكَّاهَا (Ash-Shams) vs الْمُؤْمِنُونَ (Al-Mu'minun)"
    ],
    "tags": ["Falah", "Juz 30", "Juz 18"]
  }
];

export class QuranLoader {
  constructor() {
    this.isSeeded = false;
  }

  // Check if text database is already seeded
  async checkSeeded() {
    const testAyah = await db.getAyah(1, 1);
    this.isSeeded = !!testAyah;
    return this.isSeeded;
  }

  // Primary seed function for Quran text & Mutashabihat
  async seedInitialData(onProgress) {
    try {
      if (await this.checkSeeded()) {
        if (onProgress) onProgress(100, 'Already initialized');
        return true;
      }

      if (onProgress) onProgress(10, 'Fetching Quran text chapters...');
      const response = await fetch(QURAN_TEXT_URL);
      if (!response.ok) throw new Error('Failed to fetch Quran text JSON');
      const quranData = await response.json();

      if (onProgress) onProgress(40, 'Processing Quran text...');
      // Flatten the structure and insert into DB
      let totalVerses = 0;
      for (const surah of quranData) {
        const surahNum = surah.id;
        const surahName = surah.name;
        const surahNameEn = surah.transliteration;
        const totalAyahs = surah.total_verses;

        for (const verse of surah.verses) {
          const ayahNum = verse.id;
          const ayahText = verse.text;
          const translation = verse.translation || '';
          
          await db.saveAyah({
            id: `${surahNum}:${ayahNum}`,
            surah: surahNum,
            ayah: ayahNum,
            text: ayahText,
            translation: translation,
            surahName: surahName,
            surahNameEn: surahNameEn,
            totalAyahs: totalAyahs,
            globalId: totalVerses + 1
          });
          totalVerses++;
        }
      }

      if (onProgress) onProgress(75, 'Fetching Mutashabihat pairs...');
      try {
        const mutResponse = await fetch(MUTASHABIHAT_URL);
        if (mutResponse.ok) {
          const mutData = await mutResponse.json();
          for (const item of mutData.pairs || mutData) {
            await db.saveMutashabiha(item);
          }
        } else {
          throw new Error('CDN download failed');
        }
      } catch (e) {
        console.warn('Could not load Mutashabihat from CDN, using built-in seed dataset:', e);
        for (const item of FALLBACK_MUTASHABIHAT) {
          await db.saveMutashabiha(item);
        }
      }

      this.isSeeded = true;
      if (onProgress) onProgress(100, `Done! Loaded 114 Surahs and ${totalVerses} Ayahs.`);
      return true;
    } catch (e) {
      console.error('Initialization failed:', e);
      if (onProgress) onProgress(-1, 'Error: ' + e.message);
      return false;
    }
  }

  // Load a single page's layout data (on-demand) and cache it
  async loadPage(pageNumber, edition = 'v2') {
    if (pageNumber < 1 || pageNumber > 604) return null;
    
    // Check cache
    const cached = await db.getPage(pageNumber, edition);
    if (cached) return cached;

    // Fetch layout
    try {
      let pageData;
      if (edition === 'v1') {
        pageData = await this.fetchV1Page(pageNumber);
      } else {
        const url = getPageUrl(pageNumber);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch layout for page ${pageNumber}`);
        pageData = await res.json();
        pageData.id = `v2-${pageNumber}`;
        pageData.edition = 'v2';
      }

      if (!pageData) throw new Error(`Empty page layout returned for page ${pageNumber}`);
      
      // Save to cache
      await db.savePage(pageData);
      return pageData;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // Load (and cache) the word-by-word English translation map for a page.
  // Keyed by "surah:ayah:position" so it can be matched against either mushaf
  // edition's word layout, since both share the same standard page->verse split.
  async loadWordTranslations(pageNumber) {
    if (pageNumber < 1 || pageNumber > 604) return {};

    const cached = await db.getWordTranslations(pageNumber);
    if (cached) return cached;

    try {
      const map = await this.fetchWordTranslations(pageNumber);
      await db.saveWordTranslations(pageNumber, map);
      return map;
    } catch (e) {
      console.error(e);
      return {};
    }
  }

  async fetchWordTranslations(pageNumber) {
    const url = `https://api.quran.com/api/v4/verses/by_page/${pageNumber}?words=true&word_translation_language=en&fields=text_uthmani`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch word translations for page ${pageNumber}`);
    const data = await res.json();

    const map = {};
    (data.verses || []).forEach(verse => {
      (verse.words || []).forEach(word => {
        if (word.char_type_name !== 'word' || !word.translation?.text) return;
        map[`${verse.verse_key}:${word.position}`] = word.translation.text;
      });
    });
    return map;
  }

  // Fetch V1 page layouts from Quran.com v4 API (using mushaf=2) and normalize
  async fetchV1Page(pageNumber) {
    const url = `https://api.quran.com/api/v4/verses/by_page/${pageNumber}?mushaf=2&words=true&word_fields=line_v1,code_v1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch V1 page ${pageNumber} from Quran.com API`);
    const data = await res.json();
    
    const pageData = {
      id: `v1-${pageNumber}`,
      page: pageNumber,
      edition: 'v1',
      font: `p${pageNumber}`,
      surahs: [],
      lines: []
    };

    // Initialize 15 lines
    for (let i = 1; i <= 15; i++) {
      pageData.lines.push({
        line: i,
        words: []
      });
    }

    const surahMap = new Map();

    // Group words into lines
    data.verses.forEach(verse => {
      const [surahNum] = verse.verse_key.split(':').map(Number);
      if (!surahMap.has(surahNum)) {
        surahMap.set(surahNum, true);
        pageData.surahs.push({
          id: surahNum,
          name: '',
          name_arabic: ''
        });
      }

      verse.words.forEach(word => {
        const lineIndex = word.line_v1 - 1;
        if (lineIndex < 0 || lineIndex >= 15) return;

        const isEnd = word.char_type_name === 'end';
        
        pageData.lines[lineIndex].words.push({
          code: word.id,
          char: word.code_v1,
          font: isEnd ? 'QCF_BSML' : `p${pageNumber}`,
          text: word.text || '',
          type: isEnd ? 'end' : 'word',
          verse_key: verse.verse_key,
          position: word.position
        });
      });
    });

    // Programmatically reconstruct Surah Headers and Bismillahs
    const surahStarts = [];
    pageData.lines.forEach((lineObj, lineIdx) => {
      lineObj.words.forEach(word => {
        if (word.type === 'word' && word.verse_key && word.position === 1) {
          const [sura, ayah] = word.verse_key.split(':').map(Number);
          if (ayah === 1 && !surahStarts.some(s => s.surahNum === sura)) {
            surahStarts.push({ surahNum: sura, lineIndex: lineIdx });
          }
        }
      });
    });

    surahStarts.forEach(start => {
      const { surahNum, lineIndex } = start;
      const headerLineIdx = lineIndex - 2;
      
      // Inject Surah Header (line - 2)
      if (headerLineIdx >= 0) {
        pageData.lines[headerLineIdx].words.push({
          code: `header-${surahNum}`,
          char: '',
          font: 'QCF_BSML',
          text: `سورة ${surahNum}`,
          type: 'surah_header',
          sura: surahNum
        });
      }

      // Inject Bismillah (line - 1)
      const bismillahLineIdx = lineIndex - 1;
      if (bismillahLineIdx >= 0 && surahNum !== 9 && surahNum !== 1) {
        pageData.lines[bismillahLineIdx].words.push({
          code: `bismillah-${surahNum}`,
          char: '﷽',
          font: 'QCF_BSML',
          text: 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ',
          type: 'bismillah',
          sura: surahNum
        });
      }
    });

    // Fetch Surah Arabic/English names from local IndexedDB text metadata
    for (const surahObj of pageData.surahs) {
      const sampleAyah = await db.getAyah(surahObj.id, 1);
      if (sampleAyah) {
        surahObj.name = sampleAyah.surahNameEn;
        surahObj.name_arabic = sampleAyah.surahName;
      }
    }

    return pageData;
  }

  // Pre-load layout pages for a specific Surah
  async loadPagesForSurah(surahNumber, edition = 'v2') {
    const ayahs = await db.getSurahText(surahNumber);
    if (ayahs.length === 0) return [];

    const pages = getSurahPagesRange(surahNumber);
    const loadedPages = [];
    for (const page of pages) {
      const pageData = await this.loadPage(page, edition);
      if (pageData) loadedPages.push(pageData);
    }
    return loadedPages;
  }

  // Download all 604 pages sequentially (for full offline caching)
  async downloadAllPages(onProgress, edition = 'v2') {
    let successCount = 0;
    for (let page = 1; page <= 604; page++) {
      const pageData = await this.loadPage(page, edition);
      if (pageData) successCount++;
      if (onProgress) {
        const percent = Math.round((page / 604) * 100);
        onProgress(percent, page, successCount);
      }
    }
    return successCount;
  }
}

// Maps Surah number (1-114) to its exact starting and ending pages in Medina Mushaf (15-line)
export function getSurahPagesRange(surah) {
  // Hardcoded standard Madinah Mushaf page ranges
  const ranges = {
    1: [1, 1],
    2: [2, 49],
    3: [50, 76],
    4: [77, 106],
    5: [107, 127],
    6: [128, 150],
    7: [151, 176],
    8: [177, 186],
    9: [187, 207],
    10: [208, 221],
    11: [221, 235],
    12: [235, 248],
    13: [249, 255],
    14: [255, 261],
    15: [262, 267],
    16: [267, 281],
    17: [282, 293],
    18: [293, 304],
    19: [305, 312],
    20: [312, 321],
    21: [322, 331],
    22: [332, 341],
    23: [342, 349],
    24: [350, 359],
    25: [359, 366],
    26: [367, 376],
    27: [377, 385],
    28: [385, 396],
    29: [396, 404],
    30: [404, 410],
    31: [411, 414],
    32: [415, 417],
    33: [418, 427],
    34: [428, 434],
    35: [434, 440],
    36: [440, 445],
    37: [446, 452],
    38: [453, 458],
    39: [458, 467],
    40: [467, 476],
    41: [477, 482],
    42: [483, 489],
    43: [489, 495],
    44: [496, 498],
    45: [499, 502],
    46: [502, 506],
    47: [507, 510],
    48: [511, 515],
    49: [515, 517],
    50: [518, 520],
    51: [520, 523],
    52: [523, 525],
    53: [526, 528],
    54: [528, 531],
    55: [531, 534],
    56: [534, 537],
    57: [537, 541],
    58: [542, 545],
    59: [545, 548],
    60: [549, 551],
    61: [551, 553],
    62: [553, 554],
    63: [554, 555],
    64: [556, 557],
    65: [558, 559],
    66: [560, 561],
    67: [562, 564],
    68: [564, 566],
    69: [566, 568],
    70: [568, 570],
    71: [570, 572],
    72: [572, 574],
    73: [574, 576],
    74: [576, 578],
    75: [578, 579],
    76: [579, 581],
    77: [581, 582],
    78: [582, 583],
    79: [583, 585],
    80: [585, 586],
    81: [586, 587],
    82: [587, 588],
    83: [588, 589],
    84: [589, 590],
    85: [590, 590],
    86: [591, 591],
    87: [591, 592],  // Surat Al-A'la starts on page 591, ends on 592
    88: [592, 592],
    89: [593, 594],
    90: [594, 594],
    91: [595, 595],
    92: [595, 596],
    93: [596, 596],
    94: [596, 597],
    95: [597, 597],
    96: [597, 598],
    97: [598, 598],
    98: [598, 599],
    99: [599, 599],
    100: [599, 600],
    101: [600, 600],
    102: [600, 600],
    103: [601, 601],
    104: [601, 601],
    105: [601, 601],
    106: [602, 602],
    107: [602, 602],
    108: [602, 602],
    109: [603, 603],
    110: [603, 603],
    111: [603, 603],
    112: [604, 604],
    113: [604, 604],
    114: [604, 604]
  };

  const range = ranges[surah];
  if (!range) return [];
  
  const pages = [];
  for (let p = range[0]; p <= range[1]; p++) {
    pages.push(p);
  }
  return pages;
}

export const quranLoader = new QuranLoader();
