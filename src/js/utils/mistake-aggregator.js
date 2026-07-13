// Quran Firm Plant - Mistake Aggregator
// Collects every marked mistake word across the whole mushaf from both mark
// stores (Page Map marks in IndexedDB, Writing Practice marks in localStorage)
// and resolves each raw word key to actual Arabic text + surah:ayah location.

import { db } from '../data/db.js';
import { quranLoader } from '../data/loader.js';

// Diacritic removal only — unlike normalizeArabic this keeps letter shapes
// intact, so the result is a faithful "unvocalized" prompt for haraka drills.
export function stripTashkeel(text) {
  if (!text) return '';
  // Same tashkeel range as normalizeArabic step 1 (normalize.js):
  // ً-ٟ ٰ ۖ-ۜ ۟-ۤ ۧ ۨ ۪-ۭ
  return text.replace(/[ً-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]/g, '');
}

// Parse both mark stores into raw (unresolved) entries.
async function readRawMarks() {
  const raw = [];

  // Page Map marks: IndexedDB 'pagemap-marked-{page}' -> [wordKey, type][]
  // (legacy saves were plain wordKey strings meaning 'forgotten').
  const rows = await db.getProgressByPrefix('pagemap-marked-');
  for (const row of rows) {
    const page = parseInt(row.key.slice('pagemap-marked-'.length));
    if (!page) continue;
    for (const entry of row.value || []) {
      const [wordKey, type] = typeof entry === 'string' ? [entry, 'forgotten'] : entry;
      const m = /^silhouette-(\d+)-(\d+)-(\d+)$/.exec(wordKey);
      if (!m) continue;
      raw.push({
        source: 'pagemap', rawKey: wordKey, type,
        page, line: parseInt(m[2]), wordIdx: parseInt(m[3]),
      });
    }
  }

  // Writing Practice marks: localStorage 'writing-marks' -> [key, type][]
  // key = "{context}|{lineId}|{wordIdx}", context = "page-591" | "surah-87"
  // (legacy saves were plain keys meaning 'word').
  let writingEntries = [];
  try { writingEntries = JSON.parse(localStorage.getItem('writing-marks') || '[]'); }
  catch { writingEntries = []; }
  for (const entry of writingEntries) {
    const [key, type] = Array.isArray(entry) ? entry : [entry, 'word'];
    const m = /^(page|surah)-(\d+)\|(L|I)(\d+)\|(\d+)$/.exec(key);
    if (!m) continue;
    raw.push({
      source: 'writing', rawKey: key, type,
      context: m[1], contextNum: parseInt(m[2]),
      lineKind: m[3], lineNum: parseInt(m[4]), wordIdx: parseInt(m[5]),
      page: m[1] === 'page' ? parseInt(m[2]) : null,
    });
  }

  return raw;
}

// Resolve raw entries against page layouts / surah text into MistakeRecords:
// { id, source, rawKey, type, page, line, wordIdx, surah, ayah, verseKey,
//   position, text, glyph: {char, font}|null }
// Entries whose word can no longer be found (edition change, stale key) are
// kept with text=null and unresolved=true so the dashboard can still list them.
export async function collectAllMistakes() {
  const raw = await readRawMarks();
  const edition = localStorage.getItem('mushaf-edition') || 'v2';

  // One layout load per page, one text load per surah (both cache-first).
  const pageCache = new Map();
  const surahCache = new Map();
  const getPage = async (p) => {
    if (!pageCache.has(p)) pageCache.set(p, await quranLoader.loadPage(p, edition));
    return pageCache.get(p);
  };
  const getSurah = async (s) => {
    if (!surahCache.has(s)) surahCache.set(s, await db.getSurahText(s));
    return surahCache.get(s);
  };

  const records = [];
  for (const r of raw) {
    const rec = {
      id: `${r.source}:${r.rawKey}`,
      source: r.source, rawKey: r.rawKey, type: r.type,
      page: r.page, line: null, wordIdx: r.wordIdx,
      surah: null, ayah: null, verseKey: null, position: null,
      text: null, glyph: null, unresolved: false, edition,
    };

    let word = null;
    if (r.source === 'pagemap') {
      rec.line = r.line;
      const pageData = await getPage(r.page);
      const lineObj = pageData?.lines?.find(l => l.line === r.line);
      const w = lineObj?.words?.[r.wordIdx];
      if (w && w.type === 'word') word = w;
    } else if (r.context === 'page' && r.lineKind === 'L') {
      rec.line = r.lineNum;
      const pageData = await getPage(r.page);
      const lineObj = pageData?.lines?.find(l => l.line === r.lineNum);
      // Writing keys index only the real words of the line
      const w = lineObj?.words?.filter(x => x.type === 'word')[r.wordIdx];
      if (w) word = w;
    } else if (r.context === 'surah') {
      // Surah-mode writing marks: resolve from plain Uthmani text; no page/glyph.
      const ayahs = await getSurah(r.contextNum);
      const ayahObj = ayahs?.[r.lineNum];
      const text = ayahObj?.text?.split(/\s+/)[r.wordIdx];
      if (text) {
        rec.surah = r.contextNum;
        rec.ayah = ayahObj.ayah;
        rec.verseKey = `${rec.surah}:${rec.ayah}`;
        rec.text = text;
      } else {
        rec.unresolved = true;
      }
      records.push(rec);
      continue;
    }

    if (word) {
      rec.text = word.text || null;
      rec.glyph = word.char ? { char: word.char, font: word.font } : null;
      rec.verseKey = word.verse_key || null;
      rec.position = word.position || null;
      if (rec.verseKey) {
        const [s, a] = rec.verseKey.split(':').map(Number);
        rec.surah = s;
        rec.ayah = a;
      }
    } else {
      rec.unresolved = true;
    }
    records.push(rec);
  }

  // The same word can be marked in both modules; keep the pagemap record
  // (it carries the glyph and exact layout location).
  const seen = new Map();
  const deduped = [];
  for (const rec of records) {
    const dedupKey = rec.verseKey && rec.position ? `${rec.verseKey}:${rec.position}` : rec.id;
    const existing = seen.get(dedupKey);
    if (!existing) {
      seen.set(dedupKey, rec);
      deduped.push(rec);
    } else if (existing.source === 'writing' && rec.source === 'pagemap') {
      deduped[deduped.indexOf(existing)] = rec;
      seen.set(dedupKey, rec);
    }
  }
  return deduped;
}

// Aggregate counts for the dashboard.
export function summarize(records) {
  const byType = {};
  const pageMap = new Map();
  for (const rec of records) {
    byType[rec.type] = (byType[rec.type] || 0) + 1;
    const pageKey = rec.page != null ? rec.page : 'surah';
    if (!pageMap.has(pageKey)) pageMap.set(pageKey, { page: pageKey, count: 0, byType: {} });
    const p = pageMap.get(pageKey);
    p.count++;
    p.byType[rec.type] = (p.byType[rec.type] || 0) + 1;
  }
  const byPage = [...pageMap.values()].sort((a, b) => b.count - a.count);
  return { byType, byPage, total: records.length };
}
