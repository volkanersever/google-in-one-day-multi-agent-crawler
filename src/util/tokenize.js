// Single source of truth for tokenization.
// Crawler AND search import from here — their outputs MUST match byte-for-byte
// so the scoring formula works against the exact words the crawler indexed.

export const STOP_WORDS = new Set([
  'the','a','an','and','or','but','if','then','else','of','to','in','on','at',
  'by','for','with','from','as','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','shall','should','can',
  'could','may','might','must','not','no','yes','so','than','that','this',
  'these','those','it','its','itself','he','she','they','them','their','we',
  'our','ours','you','your','yours','i','me','my','mine','us','who','whom',
  'what','which','when','where','why','how','about','also','only','just',
  'into','over','under','out','up','down','off','again','further','most',
  'more','less','some','any','all','each','every','other','another','same',
  'own','very','now','here','there','both','few','many','much','such',
]);

/**
 * Tokenize visible text into a frequency map.
 * Normalization:
 *   - lowercase
 *   - split on /[^a-z0-9]+/
 *   - drop empty tokens
 *   - drop tokens of length < 2
 *   - drop stop words
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function tokenize(text) {
  const out = new Map();
  if (!text) return out;
  const parts = String(text).toLowerCase().split(/[^a-z0-9]+/);
  for (const t of parts) {
    if (t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    out.set(t, (out.get(t) || 0) + 1);
  }
  return out;
}

/** Map a word to its letter-file name. Digits → `_.data`. */
export function letterFor(word) {
  const c = word.charCodeAt(0);
  if (c >= 97 && c <= 122) return word[0];
  if (c >= 48 && c <= 57) return '_';
  return '_';
}
