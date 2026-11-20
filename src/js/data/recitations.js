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
];

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
        const items = (json.recitations || []).filter((r) => Number.isInteger(r.id));
        if (!items.length) return reciterList;
        reciterList = items.map((r) => {
          const known = KNOWN_RECITERS.find((k) => k.id === r.id);
          const name = (r.translated_name?.name || r.reciter_name || known?.name || `Reciter ${r.id}`).replace(/`/g, '’');
          return {
            id: r.id,
            name,
            style: r.style || known?.style || null,
            short: known?.short || name,
            ayahBase: known?.ayahBase || null,
          };
        });
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

export function peekChapter(reciterId, surah) {
  return chapters.get(`${reciterId}:${surah}`)?.value;
}

export function loadChapter(reciterId, surah) {
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

// Turn quran.com's audio_file into per-ayah ranges and word timings. Returns
// null when there's no file or no word timings at all (some reciters only have
// ayah-level timestamps; those play ayah by ayah instead).
function parseChapter(file) {
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
    // row, and a few lack an end; clamp, merge and fill those in.
    const words = [];
    for (const seg of t.segments || []) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      const pos = Number(seg[0]);
      const st = Number(seg[1]);
      const en = seg.length > 2 ? Number(seg[2]) : NaN;
      if (!Number.isFinite(pos) || !Number.isFinite(st)) continue;
      const last = words[words.length - 1];
      if (last && last.pos === pos) {
        if (Number.isFinite(en)) last.en = Math.max(last.en, en - from);
        continue;
      }
      words.push({ pos, st: st - from, en: Number.isFinite(en) ? en - from : NaN });
    }
    words.sort((a, b) => a.st - b.st);
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
