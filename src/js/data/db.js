// Quran Firm Plant - IndexedDB Management
// Handles local caching of page layout JSONs, Quran text, and user learning states.

const DB_NAME = 'quran_firm_plant_db';
const DB_VERSION = 5;

class QuranDB {
  constructor() {
    this.db = null;
    this.initPromise = this.init();
  }

  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = (e) => {
        console.error('Database failed to open:', e);
        reject(e);
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Store visual pages (supports both v1 and v2 layouts using compound id "v1-591" or "v2-591")
        if (db.objectStoreNames.contains('pages')) {
          db.deleteObjectStore('pages');
        }
        db.createObjectStore('pages', { keyPath: 'id' });

        // Store Quran text (verses, translation)
        // Key: surah_ayah string (e.g., "87:1") or global ayah index
        if (!db.objectStoreNames.contains('text')) {
          db.createObjectStore('text', { keyPath: 'id' });
        }

        // Store Mutashabihat pairs
        if (!db.objectStoreNames.contains('mutashabihat')) {
          db.createObjectStore('mutashabihat', { keyPath: 'id', autoIncrement: true });
        }

        // Store User progress (words revealed, scores, drawings)
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'key' });
        }

        // Store per-page word-by-word English translation maps
        // Key: page number, Value: { "surah:ayah:position": "translation text" }
        if (!db.objectStoreNames.contains('word_translations')) {
          db.createObjectStore('word_translations', { keyPath: 'page' });
        }

        // Store per-page tajweed-coloured word markup
        // Key: page number, Value: { "surah:ayah:position": "<tajweed class=...>..." }
        if (!db.objectStoreNames.contains('tajweed')) {
          db.createObjectStore('tajweed', { keyPath: 'page' });
        }
      };
    });
  }

  // --- Page Operations (Visual 15-line layouts) ---
  async getPage(pageNumber, edition = 'v2') {
    await this.initPromise;
    const id = `${edition}-${pageNumber}`;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['pages'], 'readonly');
      const store = transaction.objectStore('pages');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  async savePage(pageData) {
    await this.initPromise;
    // pageData must have: id = "${edition}-${page}"
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['pages'], 'readwrite');
      const store = transaction.objectStore('pages');
      const request = store.put(pageData);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  async hasPage(pageNumber, edition = 'v2') {
    const page = await this.getPage(pageNumber, edition);
    return !!page;
  }

  // --- Quran Text Operations ---
  async getAyah(surah, ayah) {
    await this.initPromise;
    const key = `${surah}:${ayah}`;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['text'], 'readonly');
      const store = transaction.objectStore('text');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  async saveAyah(ayahData) {
    await this.initPromise;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['text'], 'readwrite');
      const store = transaction.objectStore('text');
      const request = store.put(ayahData);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  // Merge new translations into existing ayah records in a single transaction.
  // `updates` is [{ id: "87:1", translation: "..." }, ...].
  async updateAyahTranslations(updates) {
    await this.initPromise;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['text'], 'readwrite');
      const store = transaction.objectStore('text');
      updates.forEach(({ id, translation }) => {
        const req = store.get(id);
        req.onsuccess = () => {
          if (req.result) {
            req.result.translation = translation;
            store.put(req.result);
          }
        };
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = (e) => reject(e);
    });
  }

  async getSurahText(surahNumber) {
    await this.initPromise;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['text'], 'readonly');
      const store = transaction.objectStore('text');
      const ayahs = [];
      
      const request = store.openCursor();
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          if (val.surah === surahNumber) {
            ayahs.push(val);
          }
          cursor.continue();
        } else {
          // Sort by ayah number
          ayahs.sort((a, b) => a.ayah - b.ayah);
          resolve(ayahs);
        }
      };
      request.onerror = () => resolve([]);
    });
  }

  // --- Word-by-Word Translation Operations ---
  async getWordTranslations(pageNumber) {
    await this.initPromise;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['word_translations'], 'readonly');
      const store = transaction.objectStore('word_translations');
      const request = store.get(pageNumber);
      request.onsuccess = () => resolve(request.result ? request.result.map : null);
      request.onerror = () => resolve(null);
    });
  }

  async saveWordTranslations(pageNumber, map) {
    await this.initPromise;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['word_translations'], 'readwrite');
      const store = transaction.objectStore('word_translations');
      const request = store.put({ page: pageNumber, map });
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  // --- Tajweed Markup Operations ---
  async getTajweed(pageNumber) {
    await this.initPromise;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['tajweed'], 'readonly');
      const store = transaction.objectStore('tajweed');
      const request = store.get(pageNumber);
      request.onsuccess = () => resolve(request.result ? request.result.map : null);
      request.onerror = () => resolve(null);
    });
  }

  async saveTajweed(pageNumber, map) {
    await this.initPromise;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['tajweed'], 'readwrite');
      const store = transaction.objectStore('tajweed');
      const request = store.put({ page: pageNumber, map });
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  // --- User Progress / Spaced Repetition State ---
  async getProgress(key) {
    await this.initPromise;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['progress'], 'readonly');
      const store = transaction.objectStore('progress');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => resolve(null);
    });
  }

  // Fetch all progress entries whose key starts with the given prefix
  // (e.g. 'pagemap-marked-' returns the marked-word lists of every page).
  async getProgressByPrefix(prefix) {
    await this.initPromise;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['progress'], 'readonly');
      const store = transaction.objectStore('progress');
      const range = IDBKeyRange.bound(prefix, prefix + '￿');
      const results = [];
      const request = store.openCursor(range);
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          results.push({ key: cursor.value.key, value: cursor.value.value });
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => resolve([]);
    });
  }

  async saveProgress(key, value) {
    await this.initPromise;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['progress'], 'readwrite');
      const store = transaction.objectStore('progress');
      const request = store.put({ key, value });
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  async deleteProgress(key) {
    await this.initPromise;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['progress'], 'readwrite');
      const store = transaction.objectStore('progress');
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  }

  // --- Mutashabihat Operations ---
  async getMutashabihatForSurah(surahNumber) {
    await this.initPromise;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['mutashabihat'], 'readonly');
      const store = transaction.objectStore('mutashabihat');
      const results = [];

      const request = store.openCursor();
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const item = cursor.value;
          // Check if any verse in the group belongs to the surah
          const match = item.verses.some(v => v.surah_number === surahNumber);
          if (match) {
            results.push(item);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => resolve([]);
    });
  }

  async saveMutashabiha(group) {
    await this.initPromise;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['mutashabihat'], 'readwrite');
      const store = transaction.objectStore('mutashabihat');
      const request = store.put(group);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }
  
  async clearAll() {
    await this.initPromise;
    return new Promise((resolve) => {
      const transaction = this.db.transaction(['pages', 'text', 'mutashabihat', 'progress', 'word_translations'], 'readwrite');
      transaction.objectStore('pages').clear();
      transaction.objectStore('text').clear();
      transaction.objectStore('mutashabihat').clear();
      transaction.objectStore('progress').clear();
      transaction.objectStore('word_translations').clear();
      transaction.oncomplete = () => resolve(true);
    });
  }
}

export const db = new QuranDB();
