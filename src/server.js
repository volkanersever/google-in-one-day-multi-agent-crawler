// HTTP + SSE server. Stitches crawler, search, and static UI together.
// Agent 05 — Frontend Engineer.
//
// Routes (see product_prd.md §4.3):
//   POST /index                     start a crawl
//   GET  /search?query=...          search indexed content
//   GET  /status                    runtime snapshot
//   GET  /crawls                    list crawls
//   GET  /crawls/:id                one crawl (404 if missing)
//   POST /crawls/:id/resume         resume interrupted crawl
//   GET  /events                    SSE stream of bus events
//   GET  /, /style.css, /app.js     static web UI

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

import { CONFIG } from './config.js';
import { bus } from './event-bus.js';
import { startCrawl, resumeCrawl, getRuntimeStats } from './crawler/crawler.js';
import { listCrawls, loadCrawl, markInterruptedAtBoot } from './storage/crawl-store.js';
import { search, searchTriples } from './search/search.js';
import { loadVisited, flushVisited } from './storage/visited-store.js';

// ---------- helpers ----------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readJsonBody(req, maxBytes = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function validateStartBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const { origin, k } = body;
  if (typeof origin !== 'string' || !/^https?:\/\//i.test(origin)) return 'origin must be http(s) URL';
  const kNum = Number(k);
  if (!Number.isInteger(kNum) || kNum < 0) return 'k must be integer >= 0';
  return null;
}

// ---------- static file serving ---------------------------------------------

const STATIC_MAP = {
  '/':          { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html':{ file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css',  type: 'text/css; charset=utf-8' },
  '/app.js':    { file: 'app.js',     type: 'application/javascript; charset=utf-8' },
};

async function serveStatic(pathname, res) {
  if (pathname.includes('..')) { sendText(res, 400, 'bad path'); return true; }
  const entry = STATIC_MAP[pathname];
  if (!entry) return false;
  const abs = path.join(CONFIG.WEB_DIR, entry.file);
  try {
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'not found');
  }
  return true;
}

// ---------- SSE --------------------------------------------------------------

const BUS_EVENTS = [
  'crawl:start',
  'crawl:fetch',
  'crawl:index',
  'crawl:error',
  'crawl:state',
  'crawl:finish',
  'queue:change',
];

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // nudge the stream so the client flips to OPEN immediately
  res.write(`: connected ${Date.now()}\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  const send = (name) => (payload) => {
    try {
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload ?? {})}\n\n`);
    } catch { /* client gone */ }
  };

  const subs = BUS_EVENTS.map((n) => {
    const fn = send(n);
    bus.on(n, fn);
    return [n, fn];
  });

  const heartbeat = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`); } catch {}
  }, 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    for (const [n, fn] of subs) bus.off(n, fn);
    try { res.end(); } catch {}
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ---------- route handlers ---------------------------------------------------

async function routePostIndex(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const err = validateStartBody(body);
  if (err) { sendJson(res, 400, { error: err }); return; }
  try {
    const { origin, k, opts } = body;
    const result = await startCrawl({ origin, k: Number(k), opts: opts ?? body });
    sendJson(res, 202, result);
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
}

async function routeGetSearch(url, res) {
  const query = (url.searchParams.get('query') ?? '').trim();
  if (!query) { sendJson(res, 400, { error: 'query required' }); return; }
  const sortBy  = url.searchParams.get('sortBy')  || 'relevance';
  const limit   = Number(url.searchParams.get('limit') || 50);
  const format  = url.searchParams.get('format')  || 'json';
  try {
    if (format === 'triples') {
      const triples = await searchTriples(query, { sortBy, limit });
      sendJson(res, 200, triples);
      return;
    }
    const results = await search(query, { sortBy, limit });
    sendJson(res, 200, { query, sortBy, count: results.length, results });
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
}

function routeGetStatus(res) {
  try { sendJson(res, 200, getRuntimeStats()); }
  catch (e) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
}

async function routeGetCrawls(res) {
  try {
    const items = await listCrawls();
    sendJson(res, 200, items);
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
}

async function routeGetCrawl(id, res) {
  try {
    const data = await loadCrawl(id);
    if (!data) { sendJson(res, 404, { error: 'crawl not found' }); return; }
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
}

async function routePostResume(id, res) {
  try {
    await resumeCrawl(id);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
}

// ---------- main request router ---------------------------------------------

async function onRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${CONFIG.PORT}`);
  const { pathname } = url;
  const method = req.method || 'GET';

  // Events (SSE) first — must not buffer
  if (method === 'GET' && pathname === '/events') return handleSse(req, res);

  // API
  if (method === 'POST' && pathname === '/index')   return routePostIndex(req, res);
  if (method === 'GET'  && pathname === '/search')  return routeGetSearch(url, res);
  if (method === 'GET'  && pathname === '/status')  return routeGetStatus(res);
  if (method === 'GET'  && pathname === '/crawls')  return routeGetCrawls(res);

  const crawlMatch = pathname.match(/^\/crawls\/([A-Za-z0-9_\-]+)$/);
  if (method === 'GET' && crawlMatch) return routeGetCrawl(crawlMatch[1], res);

  const resumeMatch = pathname.match(/^\/crawls\/([A-Za-z0-9_\-]+)\/resume$/);
  if (method === 'POST' && resumeMatch) return routePostResume(resumeMatch[1], res);

  // Static
  if (method === 'GET' && await serveStatic(pathname, res)) return;

  sendJson(res, 404, { error: 'not found', path: pathname });
}

// ---------- boot -------------------------------------------------------------

async function boot() {
  // make sure data dirs exist (crawl-store usually does this but be safe)
  await fsp.mkdir(CONFIG.DATA_DIR,    { recursive: true });
  await fsp.mkdir(CONFIG.STORAGE_DIR, { recursive: true });
  await fsp.mkdir(CONFIG.CRAWLS_DIR,  { recursive: true });

  // Load the cross-run visited set, then mark any running crawls as interrupted.
  try { await loadVisited(); }
  catch (e) { console.error('[server] loadVisited failed:', e?.message ?? e); }

  try { await markInterruptedAtBoot(); }
  catch (e) { console.error('[server] markInterruptedAtBoot failed:', e?.message ?? e); }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      console.error('[server] unhandled:', err);
      try { sendJson(res, 500, { error: 'internal' }); } catch {}
    });
  });

  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`Multi-Agent Crawler online on http://localhost:${CONFIG.PORT}`);
  });

  // Graceful shutdown on SIGINT / SIGTERM — flush everything.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} — flushing and shutting down…`);
    try { await flushVisited?.(); } catch {}
    server.close(() => process.exit(0));
    // Fail-safe: don't hang on long-lived SSE clients.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

boot().catch((err) => {
  console.error('[server] boot failed:', err);
  process.exit(1);
});
