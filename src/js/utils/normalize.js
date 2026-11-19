// Quran Firm Plant - Arabic Text Normalization Utility
// Strips Arabic diacritics (tashkeel) and normalizes letter shapes for search and voice
// matching, and finds the verse a recited or typed phrase comes from.

// --- Normalization ---

// The app's Quran text is in Uthmani script, which spells some words differently from
// plain (imla'i) spelling, the spelling speech recognition and keyboards produce. Each
// rule rewrites one such spelling to the plain one before the marks are stripped, and
// only runs on text that contains its trigger. "Inside a word" lookaheads skip the marks
// that can sit between two letters (tashkeel, Quranic signs, tatweel).
const UTHMANI_TO_PLAIN = [
  // A ى carrying a small alef inside a word is an alef: يَنۡهَىٰكُمُ → ينهاكم, هُدَىٰهُمۡ → هداهم
  ['\u0670', /\u0649\u0670(?=[\u0640\u064B-\u065F\u0670\u06D6-\u06ED]*[\u0621-\u063A\u0641-\u064A\u0671-\u06D3])/g, 'ا'],
  // So is a bare و carrying one: ٱلصَّلَوٰةَ → الصلاة, ٱلۡحَيَوٰةِ → الحياة
  ['\u0670', /\u0648\u0670/g, 'ا'],
  // The vocative يا is joined to its noun: يَٰقَوۡمِ → يا قوم, يَـٰٓأَيُّهَا → يا أيها
  ['\u0670', /(^|\s|\u06DE)\u064A[\u064E\u0640]*\u0670\u0653?(?=[\u0621-\u063A\u0641-\u064A\u0671-\u06D3])/g, '$1يا '],
  // A small high yeh is a written ي: إِبۡرَٰهِـۧمَ → إبراهيم, ٱلنَّبِيِّـۧنَ → النبيين
  ['\u06E7', /\u06E7/g, 'ي'],
  // Inside a word, small waw and yeh are written letters: دَاوُۥدَ → داوود, إِۦلَٰفِهِمۡ → إيلافهم.
  // At the end of one (لَهُۥ, بِهِۦ) plain spelling leaves them out.
  ['\u06E5', /\u06E5(?=[\u0640\u064B-\u065F\u0670\u06D6-\u06ED]*[\u0621-\u063A\u0641-\u064A\u0671-\u06D3])/g, 'و'],
  ['\u06E6', /\u06E6(?=[\u0640\u064B-\u065F\u0670\u06D6-\u06ED]*[\u0621-\u063A\u0641-\u064A\u0671-\u06D3])/g, 'ي'],
  // A hamza on و before a silent alif is a final hamza: أَبۡنَـٰٓؤُاْ → أبناء, نَبَؤُاْ → نبأ
  ['ؤ', /ؤ[\u064C\u064F]?ا\u0652/g, 'ء'],
];

// Letter shapes plain spelling doesn't tell apart, or keyboards differ in: every alef
// form → ا, ي, ئ and the Persian ی → ى, ة → ه, ؤ → و, the Persian ک → ك
const LETTER_SHAPES = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ي': 'ى', 'ئ': 'ى', 'ی': 'ى', 'ة': 'ه', 'ؤ': 'و', 'ک': 'ك' };

export function normalizeArabic(text) {
  if (!text) return '';
  let normalized = String(text);

  // Presentation forms some keyboards and recognizers produce (ﷲ, ﻻ, ...) as plain letters
  if (/[\uFB50-\uFDFF\uFE70-\uFEFC]/.test(normalized)) {
    normalized = normalized.replace(/[\uFB50-\uFDFF\uFE70-\uFEFC]/g, c => c.normalize('NFKC'));
  }

  for (const [trigger, pattern, plain] of UTHMANI_TO_PLAIN) {
    if (normalized.includes(trigger)) normalized = normalized.replace(pattern, plain);
  }

  // 1. Remove tashkeel (fatha, damma, kasra, sukun, shaddah, tanween, maddah, small alef),
  //    the Quranic signs (pause marks, end of ayah, rub el hizb, sajdah, the remaining small
  //    letters), tatweel and invisible formatting characters
  normalized = normalized.replace(/[\u0640\u064B-\u065F\u0670\u06D6-\u06ED\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');

  // 2. Normalize letter shapes (see LETTER_SHAPES)
  normalized = normalized.replace(/[أإآٱيئیةؤک]/g, c => LETTER_SHAPES[c]);

  // 3. Uthmani writes آ as a hamza and an alef: ءَامَنُواْ → آمنوا, ٱلۡقُرۡءَانُ → القرآن
  normalized = normalized.replace(/ءا/g, 'ا');

  // 4. Anything else that isn't an Arabic letter (spaces, punctuation, digits, Latin)
  //    separates words
  return normalized.replace(/[^\u0621-\u063A\u0641-\u064A]+/g, ' ').trim();
}

// Computes the Levenshtein distance between two normalized strings
export function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

// --- What was recited ---

// Said around a recitation rather than part of it (none of it occurs in the Quran): the
// isti'adha, basmala or "قال الله تعالى" before it, "صدق الله العظيم" after it
const LEAD_IN = /^(اعوذ بالله (السمىع العلىم )?من الشىطان الرجىم ?)?(بسم الله الرحمن الرحىم ?)?(قال (الله )?تعالى ?)?/;
const SIGN_OFF = / ?صدق الله العظىم$/;

const letterCount = text => text.replace(/[ا ]/g, '').length;

// The recitation itself, normalized: without what was said around it, unless that is all
// there is (a search for the basmala alone still finds 1:1)
export function recitationText(text) {
  const normalized = normalizeArabic(text);
  const trimmed = normalized.replace(LEAD_IN, '').replace(SIGN_OFF, '').trim();
  return letterCount(trimmed) >= 2 ? trimmed : normalized;
}

// --- Verse search ---
//
// Two passes. A fast screen scores every verse by the letter trigrams it shares with the
// query, weighted by how rare each trigram is in the Quran, so a phrase's distinctive
// words count and common ones (الله, لا, من) barely do. The best few dozen to few hundred
// verses are then aligned letter by letter with the query, which tolerates a misheard
// letter, a dropped word and the remaining Uthmani spelling differences.

// Match form: plain spelling without the hamza and with doubled alef/waw/yeh written
// once, so يؤوده/يَـُٔودُهُۥ and رؤوف/رءوف compare equal
function matchForm(normalized) {
  return normalized.replace(/ء/g, '').replace(/([اوى])\1+/g, '$1').replace(/ +/g, ' ').trim();
}

// Letters as small integers ("slots") for the alignment tables
const SLOTS = 44; // space, U+0621..U+064A, anything else
const SPACE = 0;
const slotOf = code => (code === 32 ? SPACE : (code >= 0x0621 && code <= 0x064A ? code - 0x0620 : SLOTS - 1));
const slot = c => slotOf(c.charCodeAt(0));
const ALEF = slot('ا');

function toSlots(text) {
  const slots = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) slots[i] = slotOf(text.charCodeAt(i));
  return slots;
}

// Edit costs, in tenths. Uthmani script leaves out many alefs that plain spelling writes
// (ٱلۡكِتَٰبُ / الكتاب) and joins or splits a few words differently, so alefs and spaces
// are cheap to add or drop; ى and ا swap at word ends; a letter speech recognition often
// mishears for a similar sound is a cheaper substitution.
const INDEL = new Int32Array(SLOTS).fill(10);
INDEL[SPACE] = 3;
INDEL[ALEF] = 3;

const SUB = new Int32Array(SLOTS * SLOTS).fill(10);
for (let a = 0; a < SLOTS; a++) {
  SUB[a * SLOTS + a] = 0;
  // A space never stands for a letter: drop one and add the other
  if (a !== SPACE) SUB[a * SLOTS + SPACE] = SUB[SPACE * SLOTS + a] = INDEL[a] + INDEL[SPACE];
}
const setSub = (a, b, cost) => { SUB[slot(a) * SLOTS + slot(b)] = SUB[slot(b) * SLOTS + slot(a)] = cost; };
for (const group of ['سصث', 'تط', 'دضظ', 'ذزظ', 'هح', 'كق', 'عا', 'غخ']) {
  for (const a of group) for (const b of group) if (a !== b) setSub(a, b, 6);
}
setSub('ا', 'ى', 4);

// Starting or ending the matched stretch of a verse inside a word costs this much
const CUT = 5;
const NEVER = 1 << 29;

function weightOf(slots) {
  let w = 0;
  for (let i = 0; i < slots.length; i++) w += INDEL[slots[i]];
  return w;
}

// Two DP rows, grown as needed and reused, so a search doesn't allocate per verse
let rowA = new Int32Array(1024);
let rowB = new Int32Array(1024);

// Cost of the cheapest alignment of all of `q` with some stretch of `t` (semi-global
// edit distance). The stretch starts before `maxStart` and ends anywhere, at a small cost
// when either end is inside a word.
function alignCost(q, t, maxStart) {
  const m = q.length;
  const n = t.length;
  if (rowA.length <= n) {
    rowA = new Int32Array(n + 1024);
    rowB = new Int32Array(n + 1024);
  }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= n; j++) {
    prev[j] = j >= maxStart ? NEVER : ((j === 0 || t[j - 1] === SPACE) ? 0 : CUT);
  }
  for (let i = 0; i < m; i++) {
    const qi = q[i];
    const skipQ = INDEL[qi];
    const row = qi * SLOTS;
    cur[0] = prev[0] + skipQ;
    for (let j = 1; j <= n; j++) {
      const tj = t[j - 1];
      let v = prev[j - 1] + SUB[row + tj];
      const a = prev[j] + skipQ;
      if (a < v) v = a;
      const b = cur[j - 1] + INDEL[tj];
      if (b < v) v = b;
      cur[j] = v;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return cheapestEnd(prev, t);
}

// The best total in the last row of the alignment table. Kept out of alignCost: a loop
// that runs once per call never gathers the type feedback the optimizer needs, and
// alignCost would be deoptimized at it on every call.
function cheapestEnd(row, t) {
  const n = t.length;
  let best = NEVER;
  for (let j = 0; j <= n; j++) {
    const v = row[j] + ((j === n || t[j] === SPACE) ? 0 : CUT);
    if (v < best) best = v;
  }
  return best;
}

// The verse followed by as many of the next ones as a recitation of `weight` starting
// in it could reach
function readingFrom(entry, weight) {
  if (!entry.next) return entry.slots;
  const parts = [entry.slots];
  let length = entry.slots.length;
  let room = entry.weight;
  for (let next = entry.next; next && room < entry.weight + weight; next = next.next) {
    parts.push(next.slots);
    length += 1 + next.slots.length;
    room += next.weight;
  }
  const joined = new Uint8Array(length);
  let at = 0;
  parts.forEach((part, i) => {
    if (i > 0) joined[at++] = SPACE;
    joined.set(part, at);
    at += part.length;
  });
  return joined;
}

// How well a verse matches the query, 0..1 (1: the query appears in it exactly). The
// recitation may go on into the next verse(s): it is aligned with this verse and the ones
// after it, starting in this one, so the verse it started in is the match.
function scoreVerse(q, entry) {
  let score = 1 - alignCost(q.slots, readingFrom(entry, q.weight), entry.slots.length) / q.weight;
  // The recitation started before this verse and covers all of it: look for the verse
  // inside the recitation, discounted by how little of the recitation it covers, so a
  // short verse that merely appears in it doesn't rank as a match
  const coverage = 0.5 + 0.5 * entry.weight / q.weight;
  if (entry.weight < q.weight && score < coverage) {
    const inside = 1 - alignCost(entry.slots, q.slots, q.slots.length) / entry.weight;
    score = Math.max(score, inside * coverage);
  }
  return Math.max(0, score);
}

// Trigram codes of the letters other than alef (the letter Uthmani and plain spelling
// differ in most), each once; spaces are skipped so word splits don't matter
const GRAMS = SLOTS * SLOTS * SLOTS;

function forEachTrigram(slots, visit) {
  let a = -1;
  let b = -1;
  for (let i = 0; i < slots.length; i++) {
    const c = slots[i];
    if (c === SPACE || c === ALEF) continue;
    if (a >= 0) visit((a * SLOTS + b) * SLOTS + c);
    a = b;
    b = c;
  }
}

// Everything the search needs about each verse, built once (the text never changes):
// verses in mushaf order linked to the next one in their surah, and for every trigram
// the verses containing it. A generator, so the app can build it in slices (it pauses
// after every `slice` verses) without freezing the page.
function* indexBuilder(ayahs, slice = 400) {
  const ordered = [...ayahs].sort((a, b) => (a.surah - b.surah) || (a.ayah - b.ayah));
  const entries = [];
  const gramsOf = [];
  const count = new Int32Array(GRAMS);
  const seenIn = new Int32Array(GRAMS).fill(-1);
  for (let k = 0; k < ordered.length; k++) {
    if (k > 0 && k % slice === 0) yield;
    const ayah = ordered[k];
    const form = matchForm(normalizeArabic(ayah.text));
    if (!form) continue;
    const slots = toSlots(form);
    const index = entries.length;
    const entry = { ayah, surah: ayah.surah, slots, weight: weightOf(slots), next: null };
    const previous = entries[index - 1];
    if (previous && previous.surah === ayah.surah && previous.ayah.ayah === ayah.ayah - 1) previous.next = entry;
    entries.push(entry);
    const grams = [];
    forEachTrigram(slots, code => {
      if (seenIn[code] === index) return;
      seenIn[code] = index;
      grams.push(code);
      count[code]++;
    });
    gramsOf.push(grams);
  }
  // Verses per trigram, packed: verses with trigram g are at verses[start[g]..start[g + 1])
  const start = new Int32Array(GRAMS + 1);
  for (let g = 0; g < GRAMS; g++) start[g + 1] = start[g] + count[g];
  const verses = new Int32Array(start[GRAMS]);
  const fill = start.slice(0, GRAMS);
  gramsOf.forEach((grams, index) => {
    for (const code of grams) verses[fill[code]++] = index;
  });
  return { entries, start, verses };
}

export function buildSearchIndex(ayahs) {
  const steps = indexBuilder(ayahs);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

async function buildSearchIndexInSlices(ayahs) {
  const steps = indexBuilder(ayahs);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

const MAX_RESULTS = 8;
const MIN_SCORE = 0.55;
// Where a long recitation starts (its first ~30 words) is enough to place it; aligning
// all of it would be slow
const MAX_QUERY = 160;

// Verses matching `transcription`, best first: [{ ayah, score, fit }]
export function searchVerses(transcription, index, { surah = null, limit = MAX_RESULTS } = {}) {
  let form = matchForm(recitationText(transcription));
  if (form.length > MAX_QUERY) {
    const cut = form.lastIndexOf(' ', MAX_QUERY);
    form = form.slice(0, cut > 0 ? cut : MAX_QUERY);
  }
  if (letterCount(form) < 2) return [];
  const slots = toSlots(form);
  const q = { slots, weight: weightOf(slots) };
  const { entries, start, verses } = index;
  const all = entries.length;
  const inScope = surah ? (i => entries[i].surah === surah) : () => true;

  // --- Pass 1: screen every verse by the trigrams it shares with the query ---
  const grams = new Set();
  forEachTrigram(slots, code => grams.add(code));
  let candidates = [];
  if (grams.size < 2) {
    // Too short to screen (e.g. "الم"): align it with every verse, which is cheap here
    for (let i = 0; i < all; i++) if (inScope(i)) candidates.push(i);
  } else {
    const shared = new Float64Array(all);
    for (const code of grams) {
      const from = start[code];
      const to = start[code + 1];
      if (from === to) continue;
      const weight = Math.log(1 + all / (to - from));
      for (let k = from; k < to; k++) shared[verses[k]] += weight;
    }
    for (let i = 0; i < all; i++) if (shared[i] > 0 && inScope(i)) candidates.push(i);
    // Ties (e.g. a phrase found whole in many verses) go to verses of about its length
    const fit = i => Math.min(entries[i].weight, q.weight) / Math.max(entries[i].weight, q.weight);
    candidates.sort((a, b) => (shared[b] - shared[a]) || (fit(b) - fit(a)));
    // Aligning costs query length × verse length, so long recitations check fewer verses
    // (their trigrams already single out the verse)
    candidates = candidates.slice(0, Math.max(40, Math.min(300, Math.round(6000 / grams.size))));
  }

  // --- Pass 2: align the query with each candidate ---
  const scored = [];
  for (const i of candidates) {
    const entry = entries[i];
    const score = scoreVerse(q, entry);
    if (score < MIN_SCORE) continue;
    const fit = Math.min(entry.weight, q.weight) / Math.max(entry.weight, q.weight);
    scored.push({ ayah: entry.ayah, score, fit });
  }

  // Scores within ~2 points count as a tie, broken by length fit (e.g. 1:2 itself over
  // the longer verses ending in "الحمد لله رب العالمين"), then mushaf order
  scored.sort((a, b) =>
    (Math.round(b.score * 50) - Math.round(a.score * 50))
    || (b.fit - a.fit)
    || (b.score - a.score)
    || ((a.ayah.globalId ?? 0) - (b.ayah.globalId ?? 0)));
  return scored.slice(0, limit);
}

// The index is built from the database on the first search and kept for the session
let indexCache = null; // { db, promise }

function readAllAyahs(dbInstance) {
  return new Promise((resolve) => {
    const transaction = dbInstance.db.transaction(['text'], 'readonly');
    const store = transaction.objectStore('text');
    const list = [];
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        list.push(cursor.value);
        cursor.continue();
      } else {
        resolve(list);
      }
    };
    req.onerror = () => resolve([]);
  });
}

// Builds the search index ahead of the first search (e.g. when the Voice Finder opens)
export function prepareVerseSearch(dbInstance) {
  if (indexCache?.db === dbInstance) return indexCache.promise;
  const promise = (async () => {
    await dbInstance.initPromise;
    const ayahs = await readAllAyahs(dbInstance);
    // A database that isn't fully seeded yet is read again next time
    if (ayahs.length < 6236 && indexCache?.promise === promise) indexCache = null;
    return buildSearchIndexInSlices(ayahs);
  })();
  indexCache = { db: dbInstance, promise };
  promise.catch(() => {
    if (indexCache?.promise === promise) indexCache = null;
  });
  return promise;
}

// Find closest matching verses based on transcription
export async function findClosestVerse(transcription, dbInstance, targetSurahNumber = null) {
  const index = await prepareVerseSearch(dbInstance);
  if (index.entries.length === 0) {
    console.warn('Search pool is empty — database may not be seeded yet.');
    return [];
  }
  const matches = searchVerses(transcription, index, { surah: targetSurahNumber });
  // The index keeps the records it was built from; return them as stored now (a
  // translation may have been filled in since)
  if (typeof dbInstance.getAyah !== 'function') return matches;
  const fresh = await Promise.all(matches.map(m => dbInstance.getAyah(m.ayah.surah, m.ayah.ayah).catch(() => null)));
  return matches.map((m, i) => (fresh[i] ? { ...m, ayah: fresh[i] } : m));
}
