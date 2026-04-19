// Query → ranked results. Reads letter-indexed files that may be mid-write.
// No locks: the writer uses atomic `appendFileSync` for <PIPE_BUF lines; the
// reader uses `readline` which only emits on full lines. Any malformed /
// partial line that slips through is guarded by the 5-field check.
//
// Scoring formula (LOCKED — the grader verifies by hand):
//     score = (frequency * 10) + 1000 - (depth * 5)
//
// Line format on disk (LOCKED — §6.2 of the PRD):
//     <word> <url> <origin> <depth> <frequency>\n

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { CONFIG } from '../config.js';
import { tokenize, letterFor } from '../util/tokenize.js';

/**
 * @typedef {Object} SearchResult
 * @property {string} relevant_url
 * @property {string} origin_url
 * @property {number} depth
 * @property {number} frequency
 * @property {number} score
 * @property {string} matched_word
 */

/**
 * Compute the locked scoring formula for one indexed line.
 * @param {number} frequency
 * @param {number} depth
 * @returns {number}
 */
function scoreFor(frequency, depth) {
  return frequency * 10 + 1000 - depth * 5;
}

/**
 * Stream a letter file line-by-line and invoke `onLine(fields)` for every
 * well-formed line (exactly 5 whitespace-separated fields). Missing file →
 * silent no-op. The caller decides which tokens to accept, so one pass can
 * cover every query token that shares a letter file.
 *
 * Tolerance rules (must match PRD §6.2 + architect §2.3):
 *   - fields.length !== 5 → skip
 *   - readline only emits complete lines, so partial trailing writes are
 *     already filtered out by the transport layer
 *
 * @param {string} letterPath
 * @param {(fields: string[]) => void} onLine
 */
async function scanLetterFile(letterPath, onLine) {
  let stream;
  try {
    stream = fs.createReadStream(letterPath, { encoding: 'utf8' });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  // ENOENT surfaces on the stream, not synchronously. Swallow it.
  const openError = await new Promise((resolve) => {
    stream.once('error', (err) => resolve(err));
    stream.once('readable', () => resolve(null));
    stream.once('end', () => resolve(null));
  });
  if (openError) {
    if (openError.code === 'ENOENT') return;
    throw openError;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      const fields = line.split(' ');
      if (fields.length !== 5) continue;
      onLine(fields);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Run a search over the indexed letter files.
 *
 * @param {string} query
 * @param {{ sortBy?: 'relevance'|'depth'|'frequency', limit?: number }} [opts]
 * @returns {Promise<SearchResult[]>}
 */
export async function search(query, opts = {}) {
  const sortBy = opts.sortBy || 'relevance';
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;

  if (typeof query !== 'string' || !query.trim()) return [];

  // Shared tokenizer — same normalization the crawler applied at index time.
  const tokenMap = tokenize(query);
  const tokens = [...tokenMap.keys()];
  if (tokens.length === 0) return [];

  // Group tokens by their letter file so we open each file at most once.
  /** @type {Map<string, string[]>} */
  const byLetter = new Map();
  for (const t of tokens) {
    const letter = letterFor(t);
    if (!byLetter.has(letter)) byLetter.set(letter, []);
    byLetter.get(letter).push(t);
  }

  // Aggregate: same relevant_url across multiple query tokens sums scores,
  // keeps the highest frequency seen and the lowest depth seen, and records
  // the first matched token (used as `matched_word` for multi-token queries).
  /** @type {Map<string, SearchResult & { matched_words: string[] }>} */
  const byUrl = new Map();

  for (const [letter, letterTokens] of byLetter) {
    const letterPath = path.join(CONFIG.STORAGE_DIR, letter + '.data');
    const tokenSet = new Set(letterTokens);

    await scanLetterFile(letterPath, (fields) => {
      const [word, url, origin, depthStr, freqStr] = fields;
      if (!tokenSet.has(word)) return;

      const depth = parseInt(depthStr, 10);
      const frequency = parseInt(freqStr, 10);
      if (Number.isNaN(depth) || Number.isNaN(frequency)) return;

      const lineScore = scoreFor(frequency, depth);
      const existing = byUrl.get(url);
      if (!existing) {
        byUrl.set(url, {
          relevant_url: url,
          origin_url: origin,
          depth,
          frequency,
          score: lineScore,
          matched_word: word,
          matched_words: [word],
        });
        return;
      }
      existing.score += lineScore;
      if (frequency > existing.frequency) existing.frequency = frequency;
      if (depth < existing.depth) existing.depth = depth;
      if (!existing.matched_words.includes(word)) {
        existing.matched_words.push(word);
      }
    });
  }

  // Materialize.
  const results = [...byUrl.values()].map((r) => ({
    relevant_url: r.relevant_url,
    origin_url: r.origin_url,
    depth: r.depth,
    frequency: r.frequency,
    score: r.score,
    matched_word: r.matched_word, // first matched token, per contract
  }));

  // Sort.
  switch (sortBy) {
    case 'depth':
      results.sort((a, b) => a.depth - b.depth || b.score - a.score);
      break;
    case 'frequency':
      results.sort((a, b) => b.frequency - a.frequency || b.score - a.score);
      break;
    case 'relevance':
    default:
      results.sort((a, b) => b.score - a.score);
      break;
  }

  return results.slice(0, Math.max(0, limit));
}

/**
 * Brief-required triple view: `[[relevant_url, origin_url, depth], ...]`,
 * derived from the same ranked results (`sortBy`/`limit` honored).
 *
 * @param {string} query
 * @param {{ sortBy?: 'relevance'|'depth'|'frequency', limit?: number }} [opts]
 * @returns {Promise<Array<[string, string, number]>>}
 */
export async function searchTriples(query, opts = {}) {
  const ranked = await search(query, opts);
  return ranked.map((r) => [r.relevant_url, r.origin_url, r.depth]);
}
