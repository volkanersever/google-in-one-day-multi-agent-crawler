// Crawl orchestrator.
//
// startCrawl({origin, k, opts})     → {crawlerId}  (runs async, returns immediately)
// resumeCrawl(crawlerId)            → reloads frontier + re-enters run loop
// getRuntimeStats()                 → snapshot for /status
//
// Run loop invariants:
//   - never fetches the same URL twice (in-run Frontier seen set + cross-run visited store)
//   - only http:/https: (enforced by normalizeUrl)
//   - only text/html (enforced by fetcher)
//   - body cap 2 MB (enforced by fetcher)
//   - back-pressure: OK / THROTTLED / BACK_PRESSURE based on frontier size vs maxQueue
//   - per-host politeness: re-enqueue if last fetch to same host < PER_HOST_MIN_GAP_MS
//   - writes every word to the letter store (one line per (word,url))
//   - persists crawl state every CONFIG.STATE_FLUSH_EVERY_N_PAGES pages
//
// We emit on the shared bus:
//   crawl:start  { crawlerId, origin, k }
//   crawl:fetch  { crawlerId, url, status }
//   crawl:index  { crawlerId, url, wordsAdded }
//   crawl:error  { crawlerId, url, kind, message }
//   crawl:state  { crawlerId, state }
//   crawl:finish { crawlerId, status, stats }
//   queue:change { crawlerId, state, size, maxQueue }

import { setTimeout as sleep } from 'node:timers/promises';
import { CONFIG } from '../config.js';
import { bus } from '../event-bus.js';
import { normalizeUrl, hostOf } from '../util/url.js';
import { appendWord } from '../storage/letter-store.js';
import { hasVisited, markVisited, forgetVisited } from '../storage/visited-store.js';
import {
  createCrawl,
  saveCrawlState,
  loadCrawl,
  listCrawls,
} from '../storage/crawl-store.js';
import { fetchPage } from './fetcher.js';
import { parse } from './parser.js';
import { Frontier } from './frontier.js';
import { TokenBucket } from './rate-limiter.js';

// Active crawls keyed by crawlerId.
const runtime = new Map();

function nowMs() { return Date.now(); }

function computeBackPressureState(size, maxQueue) {
  if (maxQueue <= 0) return 'OK';
  const ratio = size / maxQueue;
  if (ratio >= 1) return 'BACK_PRESSURE';
  if (ratio >= 0.8) return 'THROTTLED';
  return 'OK';
}

function resolveOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return {
    maxConcurrency: Number.isInteger(o.maxConcurrency) && o.maxConcurrency > 0
      ? o.maxConcurrency : CONFIG.DEFAULT_MAX_CONCURRENCY,
    rateLimit: Number.isFinite(o.rateLimit) && o.rateLimit > 0
      ? o.rateLimit : CONFIG.DEFAULT_RATE_RPS,
    maxQueue: Number.isInteger(o.maxQueue) && o.maxQueue > 0
      ? o.maxQueue : CONFIG.DEFAULT_MAX_QUEUE,
    maxPages: Number.isInteger(o.maxPages) && o.maxPages > 0
      ? o.maxPages : CONFIG.DEFAULT_MAX_PAGES,
    userAgent: typeof o.userAgent === 'string' && o.userAgent
      ? o.userAgent : CONFIG.USER_AGENT,
  };
}

function logLine(rt, level, msg) {
  const entry = { ts: nowMs(), level, msg };
  rt.log.push(entry);
  if (rt.log.length > 500) rt.log.splice(0, rt.log.length - 500);
}

function persist(rt, extraPatch = {}) {
  const patch = {
    status: rt.status,
    endedAt: rt.endedAt,
    frontier: rt.frontier.toArray(),
    stats: { ...rt.stats },
    log: rt.log.slice(-200),
    ...extraPatch,
  };
  try {
    saveCrawlState(rt.crawlerId, patch);
  } catch (e) {
    // Swallow — fatal I/O is logged, but we don't want to crash the loop.
    rt.stats.errors += 1;
  }
}

function emitStateIfChanged(rt, newState) {
  if (rt.state === newState) return;
  rt.state = newState;
  bus.emit('crawl:state', { crawlerId: rt.crawlerId, state: newState });
  bus.emit('queue:change', {
    crawlerId: rt.crawlerId,
    state: newState,
    size: rt.frontier.size(),
    maxQueue: rt.opts.maxQueue,
  });
}

/**
 * Process a single URL end-to-end:
 *  - token-bucket acquire
 *  - per-host politeness gate (re-enqueue if the gate is hot)
 *  - fetch, parse, index, enqueue children, mark visited
 */
async function processOne(rt, item) {
  const { url, origin, depth } = item;

  // Cross-run + in-run dedup (defensive — we also check at enqueue time).
  if (hasVisited(url)) return;

  // Per-host politeness.
  const host = hostOf(url);
  const lastAt = rt.hostGate.get(host) || 0;
  const gap = nowMs() - lastAt;
  if (gap < CONFIG.PER_HOST_MIN_GAP_MS) {
    // Requeue at the back; let the next URL (likely a different host) go first.
    rt.frontier.enqueue({ url, origin, depth });
    // Small nudge so we don't hot-loop on a single-host frontier.
    await sleep(Math.max(10, CONFIG.PER_HOST_MIN_GAP_MS - gap));
    return;
  }

  await rt.rateLimiter.acquire();
  rt.hostGate.set(host, nowMs());
  rt.stats.lastUrl = url;

  let page;
  try {
    page = await fetchPage(url);
    bus.emit('crawl:fetch', { crawlerId: rt.crawlerId, url, status: page.status });
  } catch (err) {
    rt.stats.errors += 1;
    const kind = err && err.kind ? err.kind : 'net';
    logLine(rt, 'warn', `fetch failed ${url}: ${err && err.message}`);
    bus.emit('crawl:error', {
      crawlerId: rt.crawlerId,
      url,
      kind,
      message: err && err.message,
    });
    // Still mark as visited so we don't retry forever within the cross-run set
    // only if this was a hard HTTP/type rejection. For transient network errors
    // we leave it unvisited so a resume may retry — matches PRD error taxonomy.
    if (kind === 'type' || kind === 'size' || kind === 'http') {
      markVisited(url);
    }
    return;
  }

  let parsed;
  try {
    parsed = parse(page.body, page.finalUrl || url);
  } catch (err) {
    rt.stats.errors += 1;
    logLine(rt, 'warn', `parse failed ${url}: ${err && err.message}`);
    bus.emit('crawl:error', {
      crawlerId: rt.crawlerId,
      url,
      kind: 'parse',
      message: err && err.message,
    });
    markVisited(url);
    rt.stats.pagesCrawled += 1;
    return;
  }

  // Index tokens.
  let wordsAdded = 0;
  for (const [word, frequency] of parsed.tokens) {
    try {
      appendWord({ word, url, origin, depth, frequency });
      wordsAdded += 1;
    } catch (err) {
      rt.stats.errors += 1;
      logLine(rt, 'warn', `index write failed for ${word}: ${err && err.message}`);
      bus.emit('crawl:error', {
        crawlerId: rt.crawlerId,
        url,
        kind: 'io',
        message: err && err.message,
      });
    }
  }
  rt.stats.wordsIndexed += wordsAdded;
  rt.stats.pagesCrawled += 1;

  markVisited(url);
  bus.emit('crawl:index', { crawlerId: rt.crawlerId, url, wordsAdded });

  // Enqueue children at depth+1 if still within k hops.
  if (depth < rt.k) {
    for (const childUrl of parsed.links) {
      const norm = normalizeUrl(childUrl, page.finalUrl || url);
      if (!norm) continue;
      if (rt.frontier.hasSeen(norm)) continue;
      if (hasVisited(norm)) continue;
      rt.frontier.enqueue({ url: norm, origin, depth: depth + 1 });
      rt.stats.urlsSeen += 1;
    }
  }

  // Periodic persist.
  if (rt.stats.pagesCrawled % CONFIG.STATE_FLUSH_EVERY_N_PAGES === 0) {
    persist(rt);
  }
}

async function runLoop(rt) {
  rt.status = 'running';
  logLine(rt, 'info', `crawl started origin=${rt.origin} k=${rt.k}`);
  bus.emit('crawl:start', { crawlerId: rt.crawlerId, origin: rt.origin, k: rt.k });

  try {
    while (!rt.stopRequested &&
           !rt.frontier.isEmpty() &&
           rt.stats.pagesCrawled < rt.opts.maxPages) {

      // Back-pressure: evaluate before pulling the next batch.
      const state = computeBackPressureState(rt.frontier.size(), rt.opts.maxQueue);
      emitStateIfChanged(rt, state);

      if (state === 'BACK_PRESSURE') {
        await sleep(50);
        // Fall through and still drain the batch — otherwise queue never shrinks.
      }

      // Pull a batch of up to maxConcurrency items.
      const batch = [];
      const batchSize = Math.min(rt.opts.maxConcurrency, rt.frontier.size());
      for (let i = 0; i < batchSize; i++) {
        const it = rt.frontier.dequeue();
        if (!it) break;
        if (hasVisited(it.url)) continue;
        if (rt.stats.pagesCrawled + batch.length >= rt.opts.maxPages) break;
        batch.push(it);
      }

      if (batch.length === 0) {
        // We may have dequeued only already-visited URLs — continue the loop.
        // If the frontier is empty, the outer while will exit on the next pass.
        if (rt.frontier.isEmpty()) break;
        continue;
      }

      // Process batch in parallel.
      await Promise.all(batch.map((item) => processOne(rt, item).catch((e) => {
        rt.stats.errors += 1;
        logLine(rt, 'error', `unhandled error in processOne: ${e && e.message}`);
      })));
    }

    rt.status = rt.stopRequested ? 'interrupted' : 'finished';
    rt.endedAt = nowMs();
    logLine(rt, 'info', `crawl ${rt.status} pages=${rt.stats.pagesCrawled} errors=${rt.stats.errors}`);
    persist(rt);
    bus.emit('crawl:finish', {
      crawlerId: rt.crawlerId,
      status: rt.status,
      stats: { ...rt.stats },
    });
  } catch (err) {
    rt.status = 'failed';
    rt.endedAt = nowMs();
    logLine(rt, 'error', `crawl failed: ${err && err.message}`);
    persist(rt);
    bus.emit('crawl:error', {
      crawlerId: rt.crawlerId,
      url: rt.stats.lastUrl || rt.origin,
      kind: 'io',
      message: err && err.message,
    });
    bus.emit('crawl:finish', {
      crawlerId: rt.crawlerId,
      status: rt.status,
      stats: { ...rt.stats },
    });
  } finally {
    runtime.delete(rt.crawlerId);
  }
}

function buildRuntime(crawlerId, origin, k, opts, frontierArr = []) {
  const resolved = resolveOpts(opts);
  const frontier = new Frontier();
  frontier.loadFromArray(frontierArr);
  const rt = {
    crawlerId,
    origin,
    k,
    opts: resolved,
    startedAt: nowMs(),
    endedAt: null,
    status: 'running',
    state: 'OK',
    stats: {
      pagesCrawled: 0,
      urlsSeen: 0,
      errors: 0,
      wordsIndexed: 0,
      lastUrl: null,
    },
    frontier,
    hostGate: new Map(),
    rateLimiter: new TokenBucket(resolved.rateLimit),
    log: [],
    stopRequested: false,
  };
  return rt;
}

/**
 * Start a new crawl. Returns immediately; the run loop executes asynchronously.
 * @param {{origin:string,k:number,opts?:object}} args
 * @returns {Promise<{crawlerId:string, acceptedAt:number}>}
 */
export async function startCrawl({ origin, k, opts }) {
  const normalizedOrigin = normalizeUrl(origin);
  if (!normalizedOrigin) {
    throw new Error(`invalid origin URL: ${origin}`);
  }
  if (!Number.isInteger(k) || k < 0) {
    throw new Error(`invalid depth k: ${k}`);
  }

  const resolved = resolveOpts(opts);
  const { crawlerId } = createCrawl({ origin: normalizedOrigin, k, opts: resolved });
  const rt = buildRuntime(crawlerId, normalizedOrigin, k, resolved);
  // User explicitly asked to crawl this origin — re-fetch it even if we
  // already visited it in a prior run. Children still dedup normally.
  forgetVisited(normalizedOrigin);
  rt.frontier.enqueue({ url: normalizedOrigin, origin: normalizedOrigin, depth: 0 });
  rt.stats.urlsSeen = 1;
  runtime.set(crawlerId, rt);

  persist(rt, { origin: normalizedOrigin, k, opts: resolved, startedAt: rt.startedAt });

  // Fire and forget. The caller only needs the id.
  queueMicrotask(() => { runLoop(rt); });

  return { crawlerId, acceptedAt: rt.startedAt };
}

/**
 * Resume an interrupted crawl from its persisted JSON.
 * @param {string} crawlerId
 */
export async function resumeCrawl(crawlerId) {
  const saved = loadCrawl(crawlerId);
  if (!saved) throw new Error(`unknown crawlerId: ${crawlerId}`);
  if (runtime.has(crawlerId)) return { crawlerId, acceptedAt: nowMs() };

  const rt = buildRuntime(
    crawlerId,
    saved.origin,
    Number.isInteger(saved.k) ? saved.k : 0,
    saved.opts,
    Array.isArray(saved.frontier) ? saved.frontier : [],
  );
  if (saved.stats && typeof saved.stats === 'object') {
    rt.stats = { ...rt.stats, ...saved.stats };
  }
  rt.startedAt = saved.startedAt || rt.startedAt;
  runtime.set(crawlerId, rt);
  persist(rt, { status: 'running' });
  queueMicrotask(() => { runLoop(rt); });

  return { crawlerId, acceptedAt: nowMs() };
}

/**
 * Ask an active crawl to stop at the next batch boundary.
 */
export function stopCrawl(crawlerId) {
  const rt = runtime.get(crawlerId);
  if (!rt) return false;
  rt.stopRequested = true;
  return true;
}

/**
 * Snapshot of runtime state across all active crawls, matching PRD §4.5.
 */
export function getRuntimeStats() {
  const activeIds = new Set();
  const crawls = [];
  let worstState = 'OK';
  const totals = { pagesIndexed: 0, urlsVisited: 0, wordsIndexed: 0 };

  // Active crawls first (authoritative — in-memory state is fresher than disk).
  for (const rt of runtime.values()) {
    activeIds.add(rt.crawlerId);
    totals.pagesIndexed += rt.stats.pagesCrawled || 0;
    totals.urlsVisited += rt.stats.pagesCrawled || 0;
    totals.wordsIndexed += rt.stats.wordsIndexed || 0;
    if (rt.state === 'BACK_PRESSURE') worstState = 'BACK_PRESSURE';
    else if (rt.state === 'THROTTLED' && worstState !== 'BACK_PRESSURE') worstState = 'THROTTLED';

    crawls.push({
      crawlerId: rt.crawlerId,
      origin: rt.origin,
      k: rt.k,
      status: rt.status,
      pagesCrawled: rt.stats.pagesCrawled,
      queueDepth: rt.frontier.size(),
      rateRps: rt.opts.rateLimit,
      lastUrl: rt.stats.lastUrl,
      startedAt: rt.startedAt,
      endedAt: rt.endedAt,
    });
  }

  // Historical crawls from disk — totals must survive crawl completion.
  try {
    for (const c of listCrawls()) {
      if (activeIds.has(c.crawlerId)) continue;   // already covered above
      totals.pagesIndexed += c.stats?.pagesCrawled || 0;
      totals.urlsVisited += c.stats?.pagesCrawled || 0;
      totals.wordsIndexed += c.stats?.wordsIndexed || 0;
      crawls.push({
        crawlerId: c.crawlerId,
        origin: c.origin,
        k: c.k,
        status: c.status,
        pagesCrawled: c.stats?.pagesCrawled || 0,
        queueDepth: Array.isArray(c.frontier) ? c.frontier.length : 0,
        rateRps: c.opts?.rateLimit || 0,
        lastUrl: c.stats?.lastUrl || null,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
      });
    }
  } catch { /* best-effort; disk read failure should not break /status */ }

  // Newest first.
  crawls.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  return {
    state: worstState,
    activeCrawls: activeIds.size,
    totals,
    crawls,
  };
}

/**
 * Testing / introspection — expose internal runtime map (read-only consumers).
 * Not part of the architecture contract; kept non-enumerable-ish via naming.
 */
export function _getActive(crawlerId) {
  return runtime.get(crawlerId) || null;
}
