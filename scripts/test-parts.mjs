#!/usr/bin/env node
// Checks the part player's rules (src/js/data/recitations.js) on real data:
// partSpan() (rule 2, the reading that covers a part when the reciter repeats
// words), naturalEnds() (waqf signs and the reciter's stops) and
// adjacentPart() (rule 4, Next and Previous part).
//
//   node scripts/test-parts.mjs
//
// Needs internet: it loads page 77 (V1 layout, with Uthmani text) and An-Nisa's
// word timings for Mishary Alafasy (recitation 7, who goes back and repeats
// words in 4:1, 4:3, 4:5 and 4:75) and Sa'ud ash-Shuraym (recitation 10, who
// never does in An-Nisa) from api.quran.com. Set PARTS_DATA=<folder> to keep
// the responses there and read them from there next time.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseChapter, partSpan, naturalEnds, reciterStops, waqfPositions, hasWaqfSign, adjacentPart, wordOrd,
} from '../src/js/data/recitations.js';

const API = 'https://api.quran.com/api/v4';
const CACHE = process.env.PARTS_DATA || null;

async function getJson(name, url) {
  const file = CACHE ? join(CACHE, `${name}.json`) : null;
  if (file && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const json = await res.json();
  if (file) {
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, JSON.stringify(json));
  }
  return json;
}

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
}

const [page, alafasyFile, shuraymFile] = await Promise.all([
  getJson('page-77-v1', `${API}/verses/by_page/77?mushaf=2&words=true&per_page=50&word_fields=line_v1,text_uthmani&fields=text_uthmani`),
  getJson('timings-7-4', `${API}/chapter_recitations/7/4?segments=true`),
  getJson('timings-10-4', `${API}/chapter_recitations/10/4?segments=true`),
]);
const alafasy = parseChapter(alafasyFile.audio_file);
const shuraym = parseChapter(shuraymFile.audio_file);
assert.ok(alafasy && shuraym, 'word timings parse');

// Page 77's words in reading order, as the Page Map sees them
const seq = page.verses.flatMap((v) => v.words
  .filter((w) => w.char_type_name === 'word')
  .map((w) => ({ key: v.verse_key, pos: w.position, text: w.text_uthmani })));
const verseText = new Map(page.verses.map((v) => [v.verse_key, v.text_uthmani]));
const at = (key, pos) => seq.findIndex((w) => w.key === key && w.pos === pos);
const textsOf = (key) => seq.filter((w) => w.key === key);

const order = (ch, key) => ch.verses.get(key).words.map((w) => w.pos);
const wordAt = (ch, key, pos, nth = 0) => ch.verses.get(key).words.filter((w) => w.pos === pos)[nth];
const abs = (ch, key, w) => ch.verses.get(key).from + w.st;
const absEnd = (ch, key, w) => ch.verses.get(key).from + w.en;
const W = (key, pos) => ({ key, pos });

console.log('Data');
test('Alafasy repeats words in 4:1, 4:3, 4:5 and 4:75; 4:6 in order', () => {
  assert.equal(order(alafasy, '4:1').join(','), '1,2,3,4,5,6,7,8,9,10,11,12,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28');
  assert.equal(order(alafasy, '4:3').join(','), '1,2,3,4,5,6,7,8,9,10,11,12,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28');
  assert.equal(order(alafasy, '4:5').join(','), '1,2,3,4,5,6,7,8,9,10,11,10,11,12,13,14,15,16');
  assert.equal(order(alafasy, '4:75').join(','), '1,2,3,4,5,6,7,8,9,10,11,12,13,14,13,14,15,16,17,18,19,20,21,22,23,22,23,24,25,26,27,28,29,30,31');
  assert.equal(order(alafasy, '4:6').join(','), Array.from({ length: 37 }, (_, i) => i + 1).join(','));
});

console.log('naturalEnds: waqf signs');
test('4:6 has waqf signs after words 13, 19, 23, 28 and 34 (word text)', () => {
  assert.deepEqual(naturalEnds({ texts: textsOf('4:6') }).waqf, [13, 19, 23, 28, 34]);
  assert.equal(hasWaqfSign('أَمْوَٰلَهُمْ ۖ'), true);
  assert.equal(hasWaqfSign('أَمْوَٰلَهُمْ'), false);
});
test('the same from the ayah\'s whole text (the V2 path)', () => {
  assert.deepEqual(waqfPositions(verseText.get('4:6')), [13, 19, 23, 28, 34]);
  assert.deepEqual(naturalEnds({ verseText: verseText.get('4:6') }).waqf, [13, 19, 23, 28, 34]);
});
test('word text and whole text agree on every ayah of page 77', () => {
  for (const key of verseText.keys()) {
    assert.deepEqual(waqfPositions(verseText.get(key)), naturalEnds({ texts: textsOf(key) }).waqf, key);
  }
});
test('signs that are not words (۞, ۩) do not shift positions', () => {
  assert.deepEqual(waqfPositions('۞ وَٱلْمُحْصَنَـٰتُ مِنَ ٱلنِّسَآءِ ۖ كِتَـٰبَ'), [3]);
  assert.deepEqual(waqfPositions('ٱلْأَرْضِ ۩'), []);
});

console.log('naturalEnds: the reciter\'s stops');
test('Alafasy stops after 4:1:12, 4:3:12, 4:5:11 and 4:75:14 and :23', () => {
  assert.deepEqual(reciterStops(alafasy.verses.get('4:1').words), [12]);
  assert.deepEqual(reciterStops(alafasy.verses.get('4:3').words), [12]);
  assert.deepEqual(reciterStops(alafasy.verses.get('4:5').words), [11]);
  assert.deepEqual(reciterStops(alafasy.verses.get('4:75').words), [14, 23]);
  assert.deepEqual(reciterStops(alafasy.verses.get('4:6').words), []);
});
test('4:6 ends: the waqf signs, no stops', () => {
  assert.deepEqual(naturalEnds({ texts: textsOf('4:6'), words: alafasy.verses.get('4:6').words }).ends, [13, 19, 23, 28, 34]);
});
test('4:1 ends: Alafasy\'s stop and the waqf signs, merged', () => {
  const { waqf, stops, ends } = naturalEnds({ texts: textsOf('4:1'), words: alafasy.verses.get('4:1').words });
  assert.deepEqual(stops, [12]);
  assert.deepEqual(ends, [...new Set([...waqf, 12])].sort((a, b) => a - b));
});
test('Ash-Shuraym never goes back in An-Nisa', () => {
  for (const [key, v] of shuraym.verses) assert.deepEqual(reciterStops(v.words), [], key);
});

console.log('partSpan: rule 2');
test('4:1 words 14–19 play from the second reading (10…28)', () => {
  const span = partSpan(alafasy, W('4:1', 14), W('4:1', 19));
  assert.equal(span.clean, true);
  assert.equal(span.from, abs(alafasy, '4:1', wordAt(alafasy, '4:1', 14)));
  assert.equal(span.to, absEnd(alafasy, '4:1', wordAt(alafasy, '4:1', 19)));
  assert.deepEqual(span.words.map((w) => w.pos), [14, 15, 16, 17, 18, 19]);
});
test('4:1 words 10–12 play the first reading only', () => {
  const span = partSpan(alafasy, W('4:1', 10), W('4:1', 12));
  assert.equal(span.clean, true);
  assert.equal(span.from, abs(alafasy, '4:1', wordAt(alafasy, '4:1', 10, 0)));
  assert.equal(span.to, absEnd(alafasy, '4:1', wordAt(alafasy, '4:1', 12, 0)));
  assert.deepEqual(span.words.map((w) => w.pos), [10, 11, 12]);
});
test('4:1 words 11–13 play from the reading that reaches 13', () => {
  const span = partSpan(alafasy, W('4:1', 11), W('4:1', 13));
  assert.equal(span.clean, true);
  assert.equal(span.from, abs(alafasy, '4:1', wordAt(alafasy, '4:1', 11, 1)));
  assert.deepEqual(span.words.map((w) => w.pos), [11, 12, 13]);
});
test('4:1 words 5–15: no single reading, so all of it as recited', () => {
  const span = partSpan(alafasy, W('4:1', 5), W('4:1', 15));
  assert.equal(span.clean, false);
  assert.equal(span.from, abs(alafasy, '4:1', wordAt(alafasy, '4:1', 5)));
  assert.equal(span.to, absEnd(alafasy, '4:1', wordAt(alafasy, '4:1', 15)));
  assert.deepEqual(span.words.map((w) => w.pos), [5, 6, 7, 8, 9, 10, 11, 12, 10, 11, 12, 13, 14, 15]);
});
test('4:3 words 7–12 play the first reading; 10–14 the second', () => {
  const a = partSpan(alafasy, W('4:3', 7), W('4:3', 12));
  assert.equal(a.clean, true);
  assert.equal(a.from, abs(alafasy, '4:3', wordAt(alafasy, '4:3', 7, 0)));
  assert.equal(a.to, absEnd(alafasy, '4:3', wordAt(alafasy, '4:3', 12, 0)));
  const b = partSpan(alafasy, W('4:3', 10), W('4:3', 14));
  assert.equal(b.clean, true);
  assert.equal(b.from, abs(alafasy, '4:3', wordAt(alafasy, '4:3', 10, 1)));
  assert.deepEqual(b.words.map((w) => w.pos), [10, 11, 12, 13, 14]);
});
test('4:5 word 11 alone: its first reading', () => {
  const span = partSpan(alafasy, W('4:5', 11), W('4:5', 11));
  assert.equal(span.clean, true);
  assert.equal(span.from, abs(alafasy, '4:5', wordAt(alafasy, '4:5', 11, 0)));
  assert.equal(span.to, absEnd(alafasy, '4:5', wordAt(alafasy, '4:5', 11, 0)));
  assert.equal(span.words.length, 1);
});
test('4:75 words 14–15 play from the repeat (13, 14, 15…)', () => {
  const span = partSpan(alafasy, W('4:75', 14), W('4:75', 15));
  assert.equal(span.clean, true);
  assert.equal(span.from, abs(alafasy, '4:75', wordAt(alafasy, '4:75', 14, 1)));
  assert.deepEqual(span.words.map((w) => w.pos), [14, 15]);
});
test('4:75 words 14–24 cross both go-backs; word 13 is heard but not listed', () => {
  const span = partSpan(alafasy, W('4:75', 14), W('4:75', 24));
  assert.equal(span.clean, false);
  assert.equal(span.from, abs(alafasy, '4:75', wordAt(alafasy, '4:75', 14, 0)));
  assert.equal(span.to, absEnd(alafasy, '4:75', wordAt(alafasy, '4:75', 24)));
  assert.deepEqual(span.words.map((w) => w.pos), [14, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 22, 23, 24]);
});
test('a part across ayahs (4:5:12 to 4:6:3) runs on in the same file', () => {
  const span = partSpan(alafasy, W('4:5', 12), W('4:6', 3));
  assert.equal(span.clean, true);
  assert.equal(span.from, abs(alafasy, '4:5', wordAt(alafasy, '4:5', 12)));
  assert.equal(span.to, absEnd(alafasy, '4:6', wordAt(alafasy, '4:6', 3)));
  assert.deepEqual(span.words.map((w) => `${w.key}:${w.pos}`), ['4:5:12', '4:5:13', '4:5:14', '4:5:15', '4:5:16', '4:6:1', '4:6:2', '4:6:3']);
  assert.deepEqual(span.words.map((w) => w.ord), span.words.map((w) => wordOrd(w.key, w.pos)));
});
test('the ends may come in either order', () => {
  assert.deepEqual(partSpan(alafasy, W('4:6', 19), W('4:6', 14)), partSpan(alafasy, W('4:6', 14), W('4:6', 19)));
});
test('word times are inside the window, from its start, in time order', () => {
  for (const [a, b] of [[W('4:1', 5), W('4:1', 15)], [W('4:75', 14), W('4:75', 24)], [W('4:5', 12), W('4:6', 3)]]) {
    const span = partSpan(alafasy, a, b);
    const dur = span.to - span.from;
    span.words.forEach((w, i) => {
      assert.ok(w.st >= 0 && w.en <= dur && w.st <= w.en, `${w.key}:${w.pos} inside`);
      if (i) assert.ok(w.st >= span.words[i - 1].st, 'time order');
    });
    assert.equal(span.words[0].st, 0);
  }
});
test('a part that leaves the surah has no span', () => {
  assert.equal(partSpan(alafasy, W('4:176', 1), W('5:1', 3)), null);
});
test('Ash-Shuraym: every part is one clean reading, words in order', () => {
  for (const [a, b] of [[W('4:1', 5), W('4:1', 15)], [W('4:6', 14), W('4:6', 19)], [W('4:75', 14), W('4:75', 24)], [W('4:5', 12), W('4:6', 3)]]) {
    const span = partSpan(shuraym, a, b);
    assert.equal(span.clean, true, `${a.key}:${a.pos}`);
    assert.equal(span.from, abs(shuraym, a.key, wordAt(shuraym, a.key, a.pos)));
    assert.equal(span.to, absEnd(shuraym, b.key, wordAt(shuraym, b.key, b.pos)));
    const ords = span.words.map((w) => w.ord);
    assert.deepEqual(ords, [...ords].sort((x, y) => x - y));
    assert.equal(new Set(ords).size, ords.length);
  }
});
test('the whole of 4:6 as a part is the ayah\'s words', () => {
  const span = partSpan(shuraym, W('4:6', 1), W('4:6', 37));
  const v = shuraym.verses.get('4:6');
  assert.equal(span.from, v.from + v.words[0].st);
  assert.equal(span.words.length, 37);
});

console.log('adjacentPart: rule 4 (page 77, Alafasy)');
const endsFor = (ch) => {
  const cache = new Map();
  return (i) => {
    const w = seq[i];
    if (!cache.has(w.key)) cache.set(w.key, new Set(naturalEnds({ texts: textsOf(w.key), words: ch.verses.get(w.key)?.words }).ends));
    return cache.get(w.key).has(w.pos);
  };
};
const ends = endsFor(alafasy);
const range = (r) => (r ? `${seq[r.i0].key}:${seq[r.i0].pos}-${seq[r.i1].key}:${seq[r.i1].pos}` : null);
const part = (a, b) => ({ i0: at(...a), i1: at(...b) });
test('Next from 4:6 words 14–19 runs to the next waqf sign: 20–23', () => {
  assert.equal(range(adjacentPart(seq, part(['4:6', 14], ['4:6', 19]), 1, ends)), '4:6:20-4:6:23');
});
test('Next through 4:6: 1–13, 14–19, 20–23, 24–28, 29–34, 35–37', () => {
  let p = part(['4:6', 1], ['4:6', 13]);
  const got = [range(p)];
  for (let k = 0; k < 5; k++) {
    p = adjacentPart(seq, p, 1, ends);
    got.push(range(p));
  }
  assert.deepEqual(got, ['4:6:1-4:6:13', '4:6:14-4:6:19', '4:6:20-4:6:23', '4:6:24-4:6:28', '4:6:29-4:6:34', '4:6:35-4:6:37']);
});
test('Next stops at the reciter\'s stop: 4:1 words 1–5, then 6–12', () => {
  assert.equal(range(adjacentPart(seq, part(['4:1', 1], ['4:1', 5]), 1, ends)), '4:1:6-4:1:12');
});
test('more than twice as long: as many words as the part (one word → one word)', () => {
  assert.equal(range(adjacentPart(seq, part(['4:6', 14], ['4:6', 14]), 1, ends)), '4:6:15-4:6:15');
  // 14–15 (two words): the sign after 19 is 4 words on, so 16–19
  assert.equal(range(adjacentPart(seq, part(['4:6', 14], ['4:6', 15]), 1, ends)), '4:6:16-4:6:19');
});
test('Next after an ayah\'s last word starts the next ayah', () => {
  const last = seq.filter((w) => w.key === '4:5').length;
  const n = adjacentPart(seq, part(['4:5', last - 2], ['4:5', last]), 1, ends);
  assert.equal(`${seq[n.i0].key}:${seq[n.i0].pos}`, '4:6:1');
});
test('Previous from 4:6 words 14–19: 13 words back to the start is too long, so 8–13', () => {
  assert.equal(range(adjacentPart(seq, part(['4:6', 14], ['4:6', 19]), -1, ends)), '4:6:8-4:6:13');
});
test('Previous from 4:6 words 24–28: back to the sign after 19, 20–23', () => {
  assert.equal(range(adjacentPart(seq, part(['4:6', 24], ['4:6', 28]), -1, ends)), '4:6:20-4:6:23');
});
test('Previous from an ayah\'s first word ends at the ayah before', () => {
  const p = adjacentPart(seq, part(['4:6', 1], ['4:6', 13]), -1, ends);
  assert.equal(seq[p.i1].key, '4:5');
  assert.equal(seq[p.i1].pos, seq.filter((w) => w.key === '4:5').length);
});
test('no Next after the page\'s last word, no Previous before its first', () => {
  assert.equal(adjacentPart(seq, { i0: seq.length - 1, i1: seq.length - 1 }, 1, ends), null);
  assert.equal(adjacentPart(seq, { i0: 0, i1: 0 }, -1, ends), null);
});
test('a reciter who never stops: 4:1 words 1–5, Next runs to the waqf sign or the cap', () => {
  const r = adjacentPart(seq, part(['4:1', 1], ['4:1', 5]), 1, endsFor(shuraym));
  const waqf = naturalEnds({ texts: textsOf('4:1') }).waqf.filter((p) => p > 5);
  const expectEnd = waqf.length && waqf[0] - 5 <= 10 ? waqf[0] : 10;
  assert.equal(range(r), `4:1:6-4:1:${expectEnd}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
