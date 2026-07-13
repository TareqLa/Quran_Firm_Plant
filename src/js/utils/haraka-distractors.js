// Quran Firm Plant - Haraka Distractor Generator
// Produces plausible wrong vocalizations of a word for the mistakes drill:
// same letters, mutated diacritics. Comparison must always be raw string
// equality — normalizeArabic strips exactly what these options differ by.

const FATHA = 'َ', DAMMA = 'ُ', KASRA = 'ِ';
const SHORT_VOWELS = [FATHA, DAMMA, KASRA];
const TANWEEN = ['ً', 'ٌ', 'ٍ']; // fathatan, dammatan, kasratan
const SUKUN = 'ْ';
const SHADDA = 'ّ';
const ALL_MARKS = new Set([...SHORT_VOWELS, ...TANWEEN, SUKUN, SHADDA]);

const ARABIC_LETTER = /[ء-يٱ-ۓ]/;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Apply one random single-mark mutation; returns a new string or null.
function mutateOnce(chars) {
  const markIdxs = [];
  const letterIdxs = [];
  chars.forEach((c, i) => {
    if (ALL_MARKS.has(c)) markIdxs.push(i);
    else if (ARABIC_LETTER.test(c)) letterIdxs.push(i);
  });

  const mutated = [...chars];

  if (markIdxs.length === 0) {
    // Bare word: add a random short vowel after a random letter.
    if (letterIdxs.length === 0) return null;
    mutated.splice(pick(letterIdxs) + 1, 0, pick(SHORT_VOWELS));
    return mutated.join('');
  }

  const i = pick(markIdxs);
  const c = mutated[i];
  const op = Math.floor(Math.random() * 3);

  if (op === 0) {
    // Swap within the mark's own class (fatha<->kasra<->damma, tanween forms),
    // sukun -> vowel, shadda -> deleted.
    if (SHORT_VOWELS.includes(c)) mutated[i] = pick(SHORT_VOWELS.filter(v => v !== c));
    else if (TANWEEN.includes(c)) mutated[i] = pick(TANWEEN.filter(v => v !== c));
    else if (c === SUKUN) mutated[i] = pick(SHORT_VOWELS);
    else mutated.splice(i, 1); // shadda deletion
  } else if (op === 1) {
    // Cross-class swap: vowel <-> sukun, shadda -> vowel.
    if (SHORT_VOWELS.includes(c)) mutated[i] = SUKUN;
    else mutated[i] = pick(SHORT_VOWELS);
  } else {
    // Drop the mark entirely, or (for longer words) insert a shadda after a
    // consonant that has none.
    if (Math.random() < 0.5 && letterIdxs.length > 1) {
      const li = pick(letterIdxs);
      if (chars[li + 1] !== SHADDA) {
        mutated.splice(li + 1, 0, SHADDA);
        return mutated.join('');
      }
    }
    mutated.splice(i, 1);
  }

  return mutated.join('');
}

export function generateHarakaDistractors(word, count = 3) {
  if (!word) return [];
  const chars = [...word];
  const results = new Set();
  let attempts = 0;
  while (results.size < count && attempts < 40) {
    attempts++;
    const candidate = mutateOnce(chars);
    if (candidate && candidate !== word) results.add(candidate);
  }
  return [...results];
}
