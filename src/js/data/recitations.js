// Quran Firm Plant - Recitations: reciters, surah files with word timings, per-ayah files
//
// The Page Map player prefers one MP3 per surah plus quran.com's timings
// (GET /chapter_recitations/{id}/{surah}?segments=true): each ayah's start and
// end in that file and every word's start and end. That gives word follow,
// word steps and exact loops without reloading anything.
//
// When a reciter has no word timings for a surah, or the request or the surah
// file fails, the player falls back to one MP3 per ayah instead.

const API = 'https://api.quran.com/api/v4';

// quran.com's recitations (GET /resources/recitations), with a short name for
// the player and the folder of each one's per-ayah files (SSSAAA.mp3). The
// list itself is fetched at runtime; this table fills in when that fails.
//
// Reciters marked `extra` are not on quran.com: they have no word timings
// (`noTimings`), always play ayah by ayah from their folder, and are kept
// after quran.com's list. Their ids start at 1001 so they never match a
// quran.com recitation id.
const KNOWN_RECITERS = [
  { id: 2, name: 'AbdulBaset AbdulSamad', style: 'Murattal', short: 'Abdul Basit', ayahBase: 'https://verses.quran.com/AbdulBaset/Murattal/mp3/' },
  { id: 1, name: 'AbdulBaset AbdulSamad', style: 'Mujawwad', short: 'Abdul Basit (Mujawwad)', ayahBase: 'https://verses.quran.com/AbdulBaset/Mujawwad/mp3/' },
  { id: 3, name: 'Abdur-Rahman as-Sudais', style: null, short: 'As-Sudais', ayahBase: 'https://verses.quran.com/Sudais/mp3/' },
  { id: 4, name: 'Abu Bakr al-Shatri', style: null, short: 'Ash-Shatri', ayahBase: 'https://verses.quran.com/Shatri/mp3/' },
  { id: 5, name: 'Hani ar-Rifai', style: null, short: 'Ar-Rifai', ayahBase: 'https://verses.quran.com/Rifai/mp3/' },
  { id: 12, name: 'Mahmoud Khalil Al-Husary', style: 'Muallim', short: 'Al-Husary (Muallim)', ayahBase: 'https://mirrors.quranicaudio.com/everyayah/Husary_Muallim_128kbps/' },
  { id: 6, name: 'Mahmoud Khalil Al-Husary', style: null, short: 'Al-Husary', ayahBase: 'https://mirrors.quranicaudio.com/everyayah/Husary_64kbps/' },
  { id: 7, name: 'Mishari Rashid al-Afasy', style: null, short: 'Alafasy', ayahBase: 'https://verses.quran.com/Alafasy/mp3/' },
  { id: 9, name: 'Mohamed Siddiq al-Minshawi', style: 'Murattal', short: 'Al-Minshawi', ayahBase: 'https://verses.quran.com/Minshawi/Murattal/mp3/' },
  { id: 8, name: 'Mohamed Siddiq al-Minshawi', style: 'Mujawwad', short: 'Al-Minshawi (Mujawwad)', ayahBase: 'https://verses.quran.com/Minshawi/Mujawwad/mp3/' },
  { id: 10, name: 'Sa’ud ash-Shuraym', style: null, short: 'Ash-Shuraym', ayahBase: 'https://verses.quran.com/Shuraym/mp3/' },
  { id: 11, name: 'Mohamed al-Tablawi', style: null, short: 'At-Tablawi', ayahBase: 'https://mirrors.quranicaudio.com/everyayah/Mohammad_al_Tablaway_128kbps/' },
  { id: 1001, name: 'Ayman Sowaid', style: null, short: 'Ayman Sowaid', ayahBase: 'https://everyayah.com/data/Ayman_Sowaid_64kbps/', extra: true, noTimings: true },
];

const EXTRA_RECITERS = KNOWN_RECITERS.filter((r) => r.extra);

export const DEFAULT_RECITER = 7; // Mishari Rashid al-Afasy, as before

// How long a failed request stays failed before it is tried again (ms)
const RETRY_AFTER_MS = 60_000;

let reciterList = KNOWN_RECITERS.slice();
let reciterListPromise = null;

const pad3 = (n) => String(n).padStart(3, '0');

// The reciters to offer, in quran.com's order. Resolves to the built-in list
// when the request fails, so the picker always has something to show.
export function loadReciters() {
  if (!reciterListPromise) {
    reciterListPromise = fetch(`${API}/resources/recitations?language=en`)
      .then((res) => {
        if (!res.ok) throw new Error(`Recitations list: HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        const items = (json.recitations || []).filter((r) => Number.isInteger(r.id)
          && !EXTRA_RECITERS.some((x) => x.id === r.id));
        if (!items.length) return reciterList;
        reciterList = items.map((r) => {
          const known = KNOWN_RECITERS.find((k) => k.id === r.id && !k.extra);
          const name = (r.translated_name?.name || r.reciter_name || known?.name || `Reciter ${r.id}`).replace(/`/g, '’');
          return {
            id: r.id,
            name,
            style: r.style || known?.style || null,
            short: known?.short || name,
            ayahBase: known?.ayahBase || null,
          };
        });
        // Then the built-in reciters quran.com doesn't have
        reciterList.push(...EXTRA_RECITERS);
        return reciterList;
      })
      .catch((e) => {
        console.warn('Could not load the reciter list; using the built-in one.', e);
        reciterListPromise = null; // try again next time
        return reciterList;
      });
  }
  return reciterListPromise;
}

// Synchronous lookup (the built-in table until the fetched list arrives)
export function reciterInfo(id) {
  return reciterList.find((r) => r.id === id) || KNOWN_RECITERS.find((r) => r.id === id) || {
    id, name: `Reciter ${id}`, style: null, short: `Reciter ${id}`, ayahBase: null,
  };
}

export function reciterLabel(r) {
  return r.style ? `${r.name} · ${r.style}` : r.name;
}

// --- Surah files with timings ---

// `${reciterId}:${surah}` -> { promise, value }. value is undefined while
// loading, null when there are no word timings (or the request failed), else
// { audioUrl, verses: Map(verseKey -> { from, to, words: [{ pos, st, en }] }) }.
// Word times are ms from the ayah's start; from / to are ms in the surah file.
const chapters = new Map();

// Reciters known to have no word timings anywhere: never ask quran.com
export function hasNoTimings(reciterId) {
  return !!reciterInfo(reciterId).noTimings;
}

export function peekChapter(reciterId, surah) {
  if (hasNoTimings(reciterId)) return null;
  return chapters.get(`${reciterId}:${surah}`)?.value;
}

export function loadChapter(reciterId, surah) {
  if (hasNoTimings(reciterId)) return Promise.resolve(null);
  const key = `${reciterId}:${surah}`;
  const cached = chapters.get(key);
  if (cached) return cached.promise;

  const entry = { value: undefined, promise: null };
  entry.promise = fetch(`${API}/chapter_recitations/${reciterId}/${surah}?segments=true`)
    .then((res) => {
      if (!res.ok) throw new Error(`Timings for ${key}: HTTP ${res.status}`);
      return res.json();
    })
    .then((json) => {
      entry.value = parseChapter(json?.audio_file);
      return entry.value;
    })
    .catch((e) => {
      console.warn('Word timings unavailable; playing ayah by ayah.', e);
      entry.value = null;
      // Forget the failure after a while so a later play can try again
      setTimeout(() => { if (chapters.get(key) === entry) chapters.delete(key); }, RETRY_AFTER_MS);
      return null;
    });
  chapters.set(key, entry);
  return entry.promise;
}

// No ayah has more words than this (2:282 has 128); a bigger position is junk
const MAX_WORD_POS = 150;

// Turn quran.com's audio_file into per-ayah ranges and word timings. Returns
// null when there's no file or no word timings at all (some reciters only have
// ayah-level timestamps; those play ayah by ayah instead).
//
// An ayah's words are in time order, as heard. A position can come more than
// once: reciters go back and repeat words (Alafasy reads 4:75 as 1…14, 13,
// 14, 15…23, 22, 23, 24…31). Follow uses that order; the word steps go by
// position (see the word steps in ayah-player.js).
export function parseChapter(file) {
  const stamps = Array.isArray(file?.timestamps) ? file.timestamps : [];
  if (!file?.audio_url || !stamps.length) return null;
  if (!stamps.some((t) => Array.isArray(t.segments) && t.segments.length)) return null;

  const verses = new Map();
  for (const t of stamps) {
    const from = Number(t.timestamp_from);
    const to = Number(t.timestamp_to);
    if (!t.verse_key || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const dur = to - from;

    // Segments are [position, startMs, endMs] in the surah file. Some start a
    // little before the ayah does, a word can be split into two segments in a
    // row, a few lack an end, and some are only a time with no position;
    // clamp, merge, fill in and drop those. A word heard wholly outside the
    // ayah's range (2:260's first word ends before the ayah starts) has no
    // time in it: clamped, it would sit on the next word's start where no
    // word step could reach it.
    let words = [];
    for (const seg of t.segments || []) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      const pos = Number(seg[0]);
      const st = Number(seg[1]) - from;
      const en = seg.length > 2 ? Number(seg[2]) - from : NaN;
      if (!Number.isInteger(pos) || pos < 1 || pos > MAX_WORD_POS || !Number.isFinite(st)) continue;
      if (st >= dur || (Number.isFinite(en) && en <= 0)) continue;
      words.push({ pos, st, en: Number.isFinite(en) ? en : NaN });
    }
    words.sort((a, b) => a.st - b.st); // stable: segments that start together keep their order
    words = mergeRepeatedSegments(tidyPositions(mergeRepeatedSegments(words)));
    words.forEach((w, i) => {
      w.st = Math.min(Math.max(0, w.st), dur);
      const next = words[i + 1];
      if (!Number.isFinite(w.en) || w.en <= w.st) w.en = next ? next.st : dur;
      w.en = Math.min(Math.max(w.st, w.en), dur);
    });
    verses.set(t.verse_key, { from, to, words });
  }
  return verses.size ? { audioUrl: file.audio_url, verses } : null;
}

// One word split into segments in a row becomes one word
function mergeRepeatedSegments(words) {
  const out = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && last.pos === w.pos) {
      if (Number.isFinite(w.en)) last.en = Number.isFinite(last.en) ? Math.max(last.en, w.en) : w.en;
      continue;
    }
    out.push({ ...w });
  }
  return out;
}

// quran.com's aligner sometimes gives a segment the wrong position, often that
// of the same word elsewhere in the ayah: Alafasy's 4:74 reads 9, 10, 2, 11 and
// 4:6 reads 17, 18, 12, 10, 20, with 19 missing. Left alone, follow would
// underline a word lines away and a word step from there would land near it.
//
// Real repeats look different: the reciter goes back and reads on, at least
// to the furthest word read before (4:75: 12, 13, 14, 13, 14, 15). So, taking the words as
// runs of consecutive positions, a run is mislabelled when it
//   - goes back and stops short of the furthest word read so far, or
//   - is a single word that jumps ahead and is followed by an earlier word.
// Mislabelled words take the positions that are missing at that point, in
// order (4:6's 12 and 10 become 19), or, when none is missing, join the word
// before them (4:74's 2 becomes part of 10). Expects the words in time order
// with a word's neighbouring segments merged; changes positions only.
export function tidyPositions(words) {
  if (words.length < 3) return words;
  const runs = [];
  for (const w of words) {
    const run = runs[runs.length - 1];
    if (run && w.pos === run.end + 1) {
      run.words.push(w);
      run.end = w.pos;
    } else {
      runs.push({ start: w.pos, end: w.pos, words: [w], stray: false });
    }
  }
  if (runs.length < 2) return words;

  let furthest = runs[0].end;
  runs.forEach((run, k) => {
    if (k === 0) return;
    const next = runs[k + 1];
    run.stray = run.start <= furthest
      ? run.end < furthest
      : run.words.length === 1 && !!next && next.start < run.start;
    if (!run.stray) furthest = Math.max(furthest, run.end);
  });
  if (!runs.some((r) => r.stray)) return words;

  const kept = new Set();
  runs.forEach((r) => { if (!r.stray) r.words.forEach((w) => kept.add(w.pos)); });
  furthest = -Infinity;
  let before = null; // the last kept word
  for (let k = 0; k < runs.length; k++) {
    const run = runs[k];
    if (!run.stray) {
      furthest = Math.max(furthest, run.end);
      before = run.words[run.words.length - 1];
      continue;
    }
    let e = k;
    while (runs[e + 1]?.stray) e++;
    const nextStart = runs[e + 1] ? runs[e + 1].start : furthest + 1;
    const missing = [];
    for (let p = furthest + 1; p < nextStart; p++) if (!kept.has(p)) missing.push(p);
    runs.slice(k, e + 1).flatMap((r) => r.words).forEach((w, j) => {
      w.pos = missing.length ? missing[Math.min(j, missing.length - 1)] : before.pos;
    });
    k = e;
  }
  return words;
}

// --- Parts of an ayah ---
//
// A part is a stretch of words in one surah, from its first word to its last
// ({ key: '4:6', pos: 14 } each). It may run across lines and ayahs: ayahs
// follow each other in the surah file, so it plays as one window of it.

// Reading order across ayahs: 4:6 word 14 is 6014
const ORD_STEP = 1000;
export const wordOrd = (key, pos) => Number(String(key).split(':')[1]) * ORD_STEP + pos;

// Waqf signs, U+06D6–U+06DC (ۖ ۗ ۘ ۙ ۚ ۛ ۜ). In quran.com's text_uthmani a
// word carries its sign after a space ("أَمْوَٰلَهُمْ ۖ"); in an ayah's whole
// text it is a token of its own, as are ۞ and ۩, which are not words.
const WAQF_AFTER_WORD = /\s[\u06D6-\u06DC]/u;
const WAQF_TOKEN = /^[\u06D6-\u06DC]+$/u;
const SIGN_TOKEN = /^[\u06D6-\u06ED]+$/u;

export function hasWaqfSign(text) {
  return WAQF_AFTER_WORD.test(text || '');
}

// The positions a waqf sign follows, from an ayah's whole Uthmani text (the
// V2 layout's own word text carries no signs)
export function waqfPositions(verseText) {
  const out = [];
  let pos = 0;
  for (const tok of String(verseText || '').split(/\s+/)) {
    if (!tok) continue;
    if (!SIGN_TOKEN.test(tok)) pos++;
    else if (WAQF_TOKEN.test(tok) && pos > 0 && out[out.length - 1] !== pos) out.push(pos);
  }
  return out;
}

// Where the reciter stops and goes back: the word read just before he starts
// again further back (Alafasy reads 4:1 as 1…12, 10…: he stops after 12).
// words: an ayah's timed words in time order (parseChapter).
export function reciterStops(words) {
  const out = new Set();
  for (let i = 1; i < (words || []).length; i++) {
    if (words[i].pos <= words[i - 1].pos) out.add(words[i - 1].pos);
  }
  return [...out].sort((a, b) => a - b);
}

// Where a part can end naturally inside an ayah (rule 4): after a word with a
// waqf sign, and where the reciter stops. The waqf signs come from the words'
// Uthmani text ([{ pos, text }]) or else the ayah's whole text; the stops from
// its timed words. Positions, ascending: { waqf, stops, ends } (ends = both).
export function naturalEnds({ texts = null, verseText = '', words = [] } = {}) {
  const waqf = texts
    ? [...new Set(texts.filter((w) => hasWaqfSign(w.text)).map((w) => w.pos))].sort((a, b) => a - b)
    : waqfPositions(verseText);
  const stops = reciterStops(words);
  const ends = [...new Set([...waqf, ...stops])].sort((a, b) => a - b);
  return { waqf, stops, ends };
}

// Rule 2: the window of the surah file that plays a part. A reciter sometimes
// stops and starts again a few words back. The part plays the first reading
// that runs through all its words without going back; if no single reading
// covers it, everything from its first word to its last, as he recited it.
//
// chapter: parseChapter's result. Returns null when the part leaves the surah
// or has no timed words, else { from, to, clean, words }: from / to in ms in
// the surah file, clean = one reading covers it, and words [{ key, pos, ord,
// st, en }] in time order (ms from `from`; only the part's own words) for
// follow and word steps.
export function partSpan(chapter, first, last) {
  if (!chapter?.verses || !first?.key || !last?.key) return null;
  const [s0, a0] = String(first.key).split(':').map(Number);
  const [s1, a1] = String(last.key).split(':').map(Number);
  if (s0 !== s1) return null;
  let o0 = wordOrd(first.key, first.pos);
  let o1 = wordOrd(last.key, last.pos);
  if (o1 < o0) [o0, o1] = [o1, o0];
  const lo = Math.min(a0, a1);
  const hi = Math.max(a0, a1);

  // Every word as recited, in time order, in surah-file ms
  const segs = [];
  for (let a = lo; a <= hi; a++) {
    const key = `${s0}:${a}`;
    const v = chapter.verses.get(key);
    if (!v) return null;
    v.words.forEach((w) => segs.push({ key, pos: w.pos, ord: wordOrd(key, w.pos), st: v.from + w.st, en: v.from + w.en }));
  }

  // Readings: runs that go forward word by word (a word without timings may
  // be skipped). Going back, or jumping over a timed word, starts a new run.
  const timed = [...new Set(segs.map((x) => x.ord))].sort((a, b) => a - b);
  const rank = new Map(timed.map((o, i) => [o, i]));
  const runs = [];
  let run = null;
  for (const x of segs) {
    if (run && x.ord > run.last && rank.get(x.ord) === rank.get(run.last) + 1) {
      run.segs.push(x);
      run.last = x.ord;
    } else {
      run = { first: x.ord, last: x.ord, segs: [x] };
      runs.push(run);
    }
  }

  const inPart = (x) => x.ord >= o0 && x.ord <= o1;
  let from;
  let to;
  let clean = false;
  const cover = runs.find((r) => r.first <= o0 && r.last >= o1);
  if (cover) {
    const own = cover.segs.filter(inPart);
    if (own.length) {
      from = own[0].st;
      to = own[own.length - 1].en;
      clean = true;
    }
  }
  if (!clean) {
    const own = segs.filter(inPart);
    if (!own.length) return null;
    from = Math.min(...own.map((x) => x.st));
    to = Math.max(...own.map((x) => x.en));
  }
  if (!(to > from)) return null;

  const dur = to - from;
  const words = segs
    .filter((x) => inPart(x) && x.st >= from - 5 && x.st < to - 5)
    .map((x) => ({
      key: x.key,
      pos: x.pos,
      ord: x.ord,
      st: Math.min(Math.max(0, x.st - from), dur),
      en: Math.min(Math.max(0, x.en - from), dur),
    }));
  return { from, to, clean, words };
}

// Rule 4: the part after (dir 1) or before (dir -1) a part. seq: the words in
// reading order ([{ key, pos }]); part: { i0, i1 }, indexes into seq;
// endsAfter(i): a natural end follows seq[i]. Next starts at the word after
// the part and runs to the next natural end or the ayah's last word in seq; if
// that is more than twice as long as the part, it takes as many words as the
// part has. Previous does the same backwards. Returns { i0, i1 } or null.
export function adjacentPart(seq, part, dir, endsAfter = () => false) {
  if (!seq?.length || !part) return null;
  const n = part.i1 - part.i0 + 1;
  const max = n * 2;
  const ayahBounds = (i) => {
    let a = i;
    let b = i;
    while (a > 0 && seq[a - 1].key === seq[i].key) a--;
    while (b < seq.length - 1 && seq[b + 1].key === seq[i].key) b++;
    return [a, b];
  };
  const isEnd = (i, last) => i === last || !!endsAfter(i);
  if (dir > 0) {
    const s = part.i1 + 1;
    if (s >= seq.length) return null;
    const [, last] = ayahBounds(s);
    let e = s;
    while (e < last && !isEnd(e, last) && e - s + 1 < max) e++;
    if (!isEnd(e, last)) e = Math.min(last, s + n - 1);
    return { i0: s, i1: e };
  }
  const e = part.i0 - 1;
  if (e < 0) return null;
  const [first, last] = ayahBounds(e);
  // A part starts at the ayah's first word or just after a natural end
  const startsAt = (i) => i === first || isEnd(i - 1, last);
  let s = e;
  while (s > first && !startsAt(s) && e - s + 1 < max) s--;
  if (!startsAt(s)) s = Math.max(first, e - n + 1);
  return { i0: s, i1: e };
}

// --- Per-ayah files ---

// `${reciterId}:${surah}` -> Map(verseKey -> url), for reciters without a
// known folder (looked up through quran.com)
const ayahLists = new Map();

function absoluteAudioUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:/i.test(url)) return url;
  return `https://verses.quran.com/${url.replace(/^\//, '')}`;
}

// The per-ayah file, when it can be named without a request
export function ayahUrlSync(reciterId, verseKey) {
  const [s, a] = verseKey.split(':').map(Number);
  const base = reciterInfo(reciterId).ayahBase;
  if (base) return `${base}${pad3(s)}${pad3(a)}.mp3`;
  return ayahLists.get(`${reciterId}:${s}`)?.value?.get(verseKey) || null;
}

export async function ayahUrl(reciterId, verseKey) {
  const known = ayahUrlSync(reciterId, verseKey);
  if (known) return known;
  const [s] = verseKey.split(':').map(Number);
  const key = `${reciterId}:${s}`;
  let entry = ayahLists.get(key);
  if (!entry) {
    entry = { value: undefined, promise: null };
    entry.promise = fetch(`${API}/recitations/${reciterId}/by_chapter/${s}?per_page=300`)
      .then((res) => {
        if (!res.ok) throw new Error(`Ayah files for ${key}: HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        entry.value = new Map((json.audio_files || []).map((f) => [f.verse_key, absoluteAudioUrl(f.url)]));
        return entry.value;
      })
      .catch((e) => {
        ayahLists.delete(key);
        throw e;
      });
    ayahLists.set(key, entry);
  }
  const list = await entry.promise;
  return list.get(verseKey) || null;
}
