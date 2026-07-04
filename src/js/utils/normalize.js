// Quran Firm Plant - Arabic Text Normalization Utility
// Strips Arabic diacritics (tashkeel) and normalizes letter shapes for search and voice matching.

export function normalizeArabic(text) {
  if (!text) return '';

  // 1. Remove Tashkeel (diacritics: fatha, damma, kasra, sukun, shaddah, tanween, maddah, superscript alef)
  let normalized = text.replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, '');

  // 2. Remove Quran-specific symbols (verse markers, sajda, etc.)
  normalized = normalized.replace(/[\u06D7\u06D8\u06D9\u06DA\u06DB\u06DC]/g, '');

  // 3. Normalize Alefs (أ, إ, آ, ٱ -> ا)
  normalized = normalized.replace(/[أإآٱ]/g, 'ا');

  // 4. Normalize Yeh (ي, ئ -> ى) and Teh Marbuta (ة -> ه)
  normalized = normalized.replace(/[يئ]/g, 'ى');
  normalized = normalized.replace(/ة/g, 'ه');

  // 5. Normalize Waw variants
  normalized = normalized.replace(/ؤ/g, 'و');

  // 6. Remove tatweel (kashida)
  normalized = normalized.replace(/\u0640/g, '');

  // 7. Remove extra whitespaces and trim
  normalized = normalized.trim().replace(/\s+/g, ' ');

  return normalized;
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

// Compute similarity ratio (0 to 1) between two strings
function similarityRatio(a, b) {
  if (!a || !b) return 0;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

// Check if query is a fuzzy substring of the text.
// Windows are built on word boundaries (speech fragments start/end at words),
// which keeps this thousands of times cheaper than per-character sliding.
function fuzzySubstringScore(query, text) {
  if (!query || !text) return 0;

  // Exact substring match
  if (text.includes(query)) return 1.0;

  // If query is longer than text, compare the other way
  if (query.length > text.length) {
    return similarityRatio(query, text);
  }

  const words = text.split(' ');
  const qLen = query.length;
  let bestScore = 0;

  for (let i = 0; i < words.length; i++) {
    let chunk = '';
    for (let j = i; j < words.length; j++) {
      chunk = chunk ? chunk + ' ' + words[j] : words[j];
      if (chunk.length > qLen + 10) break;
      // Only score windows whose length is comparable to the query
      if (chunk.length >= qLen - 10) {
        const score = similarityRatio(query, chunk);
        if (score > bestScore) bestScore = score;
      }
    }
    if (bestScore >= 0.99) break;
  }

  return bestScore;
}

// Find closest matching verse based on transcription
export async function findClosestVerse(transcription, dbInstance, targetSurahNumber = null) {
  const normalizedQuery = normalizeArabic(transcription);
  if (!normalizedQuery || normalizedQuery.length < 2) return [];

  // Make sure DB is initialized
  await dbInstance.initPromise;

  const candidates = [];
  
  // Fetch candidate ayahs from DB
  let searchPool = [];
  if (targetSurahNumber) {
    searchPool = await dbInstance.getSurahText(targetSurahNumber);
  } else {
    // Search all 6236 ayahs — cursor scan is fast in IndexedDB (~30ms)
    searchPool = await new Promise((resolve) => {
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

  if (searchPool.length === 0) {
    console.warn('Search pool is empty — database may not be seeded yet.');
    return [];
  }

  // Two-pass scoring: a cheap screening pass over every ayah, then
  // expensive fuzzy scoring only on the most promising candidates.
  const queryWords = normalizedQuery.split(' ').filter(w => w.length > 1);
  const querySet = new Set(queryWords);

  // --- Pass 1 (cheap, all 6236 ayahs) ---
  const roughCandidates = [];
  searchPool.forEach(ayah => {
    const normalizedText = normalizeArabic(ayah.text);

    // Strategy 1: Exact substring match (highest confidence)
    if (normalizedText.includes(normalizedQuery)) {
      candidates.push({ ayah, score: 1.0 });
      return;
    }

    // Strategy 2: Query contains the full verse text (user said extra words around it)
    if (normalizedQuery.includes(normalizedText)) {
      candidates.push({ ayah, score: 0.95 });
      return;
    }

    // Cheap screen: count exact shared words
    let hits = 0;
    for (const tw of normalizedText.split(' ')) {
      if (querySet.has(tw)) hits++;
    }
    if (hits > 0) {
      roughCandidates.push({ ayah, normalizedText, ratio: hits / Math.max(queryWords.length, 1) });
    }
  });

  // --- Pass 2 (fuzzy, top candidates only) ---
  roughCandidates.sort((a, b) => b.ratio - a.ratio);
  for (const cand of roughCandidates.slice(0, 60)) {
    // Strategy 3: Fuzzy word-window substring match
    // Catches partial speech fragments and minor transcription errors
    const subScore = fuzzySubstringScore(normalizedQuery, cand.normalizedText);
    if (subScore > 0.55) {
      candidates.push({ ayah: cand.ayah, score: subScore });
      continue;
    }

    // Strategy 4: Fuzzy word-overlap ratio (bag-of-words style)
    // Handles cases where speech recognition reorders words or drops particles
    const textWords = cand.normalizedText.split(' ').filter(w => w.length > 1);
    if (queryWords.length > 0 && textWords.length > 0) {
      let matchedWords = 0;
      for (const qw of queryWords) {
        if (textWords.some(tw => similarityRatio(qw, tw) > 0.7)) {
          matchedWords++;
        }
      }
      const wordOverlap = matchedWords / queryWords.length;
      if (wordOverlap > 0.5) {
        candidates.push({ ayah: cand.ayah, score: wordOverlap * 0.85 });
      }
    }
  }

  // Sort by score descending, deduplicate by ayah id
  const seen = new Set();
  const unique = [];
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (!seen.has(c.ayah.id)) {
      seen.add(c.ayah.id);
      unique.push(c);
    }
  }
  
  return unique.slice(0, 8); // Return top 8 matches
}
