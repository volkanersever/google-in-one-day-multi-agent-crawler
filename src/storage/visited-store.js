// Cross-run visited-URL set.
//
// Backed by data/visited_urls.data: one normalized URL per line.
// In-memory: a plain Set for O(1) membership tests.
// On mark, the URL is both added to the Set and appended to disk (atomic line).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CONFIG } from '../config.js';
import { appendLineSync } from '../util/fs-atomic.js';

const visited = new Set();
let loaded = false;

/**
 * Load the visited-URL set from disk into memory.
 * Idempotent: calling twice does not duplicate entries.
 */
export async function loadVisited() {
  visited.clear();
  loaded = true;
  if (!fs.existsSync(CONFIG.VISITED_FILE)) {
    fs.mkdirSync(path.dirname(CONFIG.VISITED_FILE), { recursive: true });
    return;
  }
  const stream = fs.createReadStream(CONFIG.VISITED_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) visited.add(trimmed);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export function hasVisited(url) {
  return visited.has(url);
}

export function markVisited(url) {
  if (!url || visited.has(url)) return;
  visited.add(url);
  appendLineSync(CONFIG.VISITED_FILE, url);
}

/**
 * Remove a URL from the in-memory visited Set so it may be re-fetched.
 * The on-disk log still carries the earlier entry — this only affects
 * the current process's dedup decisions. Typical use: a user launches
 * /index on an origin they have crawled before; the origin should be
 * re-fetched even though it's already in visited_urls.data.
 */
export function forgetVisited(url) {
  if (!url) return false;
  return visited.delete(url);
}

/** Force a disk flush — appendLineSync is already sync, but we fsync for safety. */
export function flushVisited() {
  try {
    if (!fs.existsSync(CONFIG.VISITED_FILE)) return;
    const fd = fs.openSync(CONFIG.VISITED_FILE, 'a');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Best-effort — never throw from flush.
  }
}

export function visitedCount() {
  return visited.size;
}

/** Snapshot of the current in-memory visited set, as an array. */
export function visitedSnapshot() {
  return Array.from(visited);
}

export function isLoaded() {
  return loaded;
}
