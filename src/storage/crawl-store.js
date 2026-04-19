// Per-crawl JSON lifecycle store.
//
// Each crawl has a file data/crawls/<crawlerId>.data containing its full
// run state (origin, opts, status, stats, frontier, log). Writes are
// atomic (.tmp → rename via writeJsonAtomicSync).

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { writeJsonAtomicSync, readJsonSync } from '../util/fs-atomic.js';

let counter = 0;

function ensureCrawlsDir() {
  fs.mkdirSync(CONFIG.CRAWLS_DIR, { recursive: true });
}

function crawlPath(crawlerId) {
  return path.join(CONFIG.CRAWLS_DIR, `${crawlerId}.data`);
}

/**
 * Create a fresh crawl record on disk.
 * @param {{origin:string,k:number,opts:object}} args
 * @returns {{crawlerId:string, path:string}}
 */
export function createCrawl({ origin, k, opts }) {
  ensureCrawlsDir();
  const crawlerId = `${Date.now()}_${++counter}`;
  const state = {
    crawlerId,
    origin,
    k,
    opts: opts || {},
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    stats: {
      pagesCrawled: 0,
      urlsSeen: 0,
      errors: 0,
      wordsIndexed: 0,
      lastUrl: null,
    },
    frontier: [],
    log: [],
  };
  const p = crawlPath(crawlerId);
  writeJsonAtomicSync(p, state);
  return { crawlerId, path: p };
}

/**
 * Merge `patch` into the stored state and rewrite atomically.
 * Shallow-merge at top level; nested `stats` is merged field-by-field.
 */
export function saveCrawlState(crawlerId, patch) {
  const p = crawlPath(crawlerId);
  const current = readJsonSync(p) || { crawlerId };
  const next = { ...current, ...patch };
  if (patch && patch.stats) {
    next.stats = { ...(current.stats || {}), ...patch.stats };
  }
  writeJsonAtomicSync(p, next);
  return next;
}

export function loadCrawl(crawlerId) {
  return readJsonSync(crawlPath(crawlerId));
}

/** Enumerate all crawl records on disk, newest first. */
export function listCrawls() {
  ensureCrawlsDir();
  let entries;
  try {
    entries = fs.readdirSync(CONFIG.CRAWLS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.data')) continue;
    const crawlerId = name.slice(0, -5);
    const state = readJsonSync(path.join(CONFIG.CRAWLS_DIR, name));
    if (state) out.push(state);
    else out.push({ crawlerId, status: 'unknown' });
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

/**
 * On boot: any crawl still marked `running` must actually have been killed,
 * because nothing is keeping it alive across process restart. Flip those to
 * `interrupted` so they become resumable.
 */
export function markInterruptedAtBoot() {
  const all = listCrawls();
  const touched = [];
  for (const st of all) {
    if (st && st.status === 'running' && st.crawlerId) {
      const next = { ...st, status: 'interrupted', endedAt: st.endedAt || Date.now() };
      writeJsonAtomicSync(crawlPath(st.crawlerId), next);
      touched.push(st.crawlerId);
    }
  }
  return touched;
}
