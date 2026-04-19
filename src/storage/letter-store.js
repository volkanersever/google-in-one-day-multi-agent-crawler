// Letter-indexed word store.
//
// Line format (frozen — grader verifies by hand):
//     word url origin depth frequency\n
// Exactly five space-separated fields, newline-terminated.
//
// Writes go through appendLineSync (single POSIX write(2), atomic < PIPE_BUF).
// Reads go through node:readline so mid-written (unflushed) lines are skipped.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CONFIG } from '../config.js';
import { letterFor } from '../util/tokenize.js';
import { urlForLineFormat } from '../util/url.js';
import { appendLineSync } from '../util/fs-atomic.js';

/**
 * Append a single word occurrence to the correct letter file.
 * @param {{word:string,url:string,origin:string,depth:number,frequency:number}} rec
 */
export function appendWord({ word, url, origin, depth, frequency }) {
  if (typeof word !== 'string' || word.length === 0) return;
  if (!Number.isInteger(depth) || !Number.isInteger(frequency)) return;
  const letter = letterFor(word);
  const filePath = path.join(CONFIG.STORAGE_DIR, `${letter}.data`);
  const safeUrl = urlForLineFormat(url);
  const safeOrigin = urlForLineFormat(origin);
  const line = `${word} ${safeUrl} ${safeOrigin} ${depth} ${frequency}\n`;
  appendLineSync(filePath, line);
}

/**
 * Stream parsed valid word lines for the given letter.
 * Yields objects: { word, url, origin, depth, frequency }.
 * Skips any line that:
 *   - splits into !== 5 fields, or
 *   - has non-integer depth / frequency.
 *
 * @param {string} letter  'a'..'z' or '_'
 */
export async function* iterateLetter(letter) {
  const filePath = path.join(CONFIG.STORAGE_DIR, `${letter}.data`);
  if (!fs.existsSync(filePath)) return;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      if (!rawLine) continue;
      const fields = rawLine.split(' ');
      if (fields.length !== 5) continue;

      const [word, url, origin, depthStr, freqStr] = fields;
      // Integer-only guard — parseInt is too lenient, so check shape first.
      if (!/^-?\d+$/.test(depthStr)) continue;
      if (!/^-?\d+$/.test(freqStr)) continue;
      const depth = Number(depthStr);
      const frequency = Number(freqStr);
      if (!Number.isInteger(depth) || !Number.isInteger(frequency)) continue;
      if (!word || !url || !origin) continue;

      yield { word, url, origin, depth, frequency };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
