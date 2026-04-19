// Thin HTTP client to the local server on :3600.
// Agent 05 — Frontend Engineer.
//
// Usage:
//   node src/cli.js index  <origin> <k> [--rate 5] [--concurrency 5] [--max-queue 500] [--max-pages 1000]
//   node src/cli.js search <query>      [--sort relevance|depth|frequency] [--limit 50] [--format json|triples]
//   node src/cli.js status

import http from 'node:http';
import { CONFIG } from './config.js';

const HOST = 'localhost';
const PORT = CONFIG.PORT;

// ---------- ANSI colors ------------------------------------------------------

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const CY   = c('36');
const MG   = c('35');
const YE   = c('33');
const GR   = c('32');
const RD   = c('31');
const DIM  = c('2');
const B    = c('1');

const STATE_COLORS = {
  OK:            GR,
  THROTTLED:     YE,
  BACK_PRESSURE: RD,
};

// ---------- http helpers -----------------------------------------------------

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST,
      port: PORT,
      method,
      path: pathname,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
      timeout: 15_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureServerReachable() {
  try {
    await request('GET', '/status');
  } catch (e) {
    console.error(RD(`Server not running on :${PORT} — start with \`node src/server.js\``));
    process.exit(1);
  }
}

// ---------- argv parser ------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------- subcommands ------------------------------------------------------

async function cmdIndex(args) {
  const { flags, positional } = parseFlags(args);
  const [origin, kRaw] = positional;
  if (!origin || kRaw === undefined) {
    console.error(`Usage: node src/cli.js index <origin> <k> [--rate N] [--concurrency N] [--max-queue N] [--max-pages N]`);
    process.exit(2);
  }
  const k = Number(kRaw);
  if (!Number.isInteger(k) || k < 0) {
    console.error(RD('k must be a non-negative integer'));
    process.exit(2);
  }
  const opts = {};
  if (flags.rate)         opts.rateLimit      = Number(flags.rate);
  if (flags.concurrency)  opts.maxConcurrency = Number(flags.concurrency);
  if (flags['max-queue']) opts.maxQueue       = Number(flags['max-queue']);
  if (flags['max-pages']) opts.maxPages       = Number(flags['max-pages']);

  await ensureServerReachable();
  const { status, body } = await request('POST', '/index', { origin, k, opts });
  if (status >= 400) {
    console.error(RD(`HTTP ${status}: ${body?.error ?? JSON.stringify(body)}`));
    process.exit(1);
  }
  console.log(`${B(CY('▶ crawl accepted'))}`);
  console.log(`  crawlerId  ${CY(body.crawlerId)}`);
  console.log(`  origin     ${origin}`);
  console.log(`  k          ${k}`);
  if (body.acceptedAt) console.log(`  acceptedAt ${new Date(body.acceptedAt).toISOString()}`);
  console.log(DIM(`  tail progress: node src/cli.js status`));
}

async function cmdSearch(args) {
  const { flags, positional } = parseFlags(args);
  const query = positional.join(' ').trim();
  if (!query) {
    console.error(`Usage: node src/cli.js search <query> [--sort relevance|depth|frequency] [--limit N] [--format json|triples]`);
    process.exit(2);
  }
  const sort   = flags.sort  ?? 'relevance';
  const limit  = Number(flags.limit ?? 50);
  const format = flags.format ?? 'json';

  await ensureServerReachable();
  const qs = new URLSearchParams({ query, sortBy: sort, limit: String(limit), format });
  const { status, body } = await request('GET', `/search?${qs.toString()}`);
  if (status >= 400) {
    console.error(RD(`HTTP ${status}: ${body?.error ?? JSON.stringify(body)}`));
    process.exit(1);
  }

  if (format === 'triples') {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const { results = [], count = 0 } = body ?? {};
  console.log(`${B(CY('search'))} ${DIM(`[${sort}]`)}  ${B(String(count))} ${DIM('results for')} "${query}"`);
  if (!results.length) { console.log(DIM('  (no matches)')); return; }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const idx = String(i + 1).padStart(2, ' ');
    const score = String(r.score ?? '').padStart(5, ' ');
    const depth = `d=${r.depth}`;
    const freq  = `f=${r.frequency}`;
    console.log(`${DIM(idx + '.')} ${MG(score)}  ${CY(r.relevant_url)}`);
    console.log(`     ${DIM('origin')} ${r.origin_url}  ${DIM(depth)}  ${DIM(freq)}  ${DIM('match=' + r.matched_word)}`);
  }
}

async function cmdStatus() {
  await ensureServerReachable();
  const { status, body } = await request('GET', '/status');
  if (status >= 400) {
    console.error(RD(`HTTP ${status}: ${body?.error ?? JSON.stringify(body)}`));
    process.exit(1);
  }

  const stateColor = STATE_COLORS[body.state] ?? ((s) => s);
  console.log(`${B('■ system')}`);
  console.log(`  state        ${stateColor(B(body.state))}`);
  console.log(`  activeCrawls ${CY(body.activeCrawls ?? 0)}`);
  const t = body.totals ?? {};
  console.log(`  totals       pages=${CY(t.pagesIndexed ?? 0)}  urls=${CY(t.urlsVisited ?? 0)}  words=${CY(t.wordsIndexed ?? 0)}`);

  const crawls = body.crawls ?? [];
  if (!crawls.length) { console.log(DIM('\n  no crawls yet')); return; }

  console.log(`\n${B('■ crawls')}`);
  for (const cr of crawls) {
    const st = cr.status || 'unknown';
    const stColored =
      st === 'running'     ? GR(st) :
      st === 'finished'    ? CY(st) :
      st === 'failed'      ? RD(st) :
      st === 'interrupted' ? YE(st) :
      st;
    console.log(`  ${B(CY(cr.crawlerId))}  ${stColored}`);
    console.log(`    origin ${cr.origin}  ${DIM('k=' + cr.k)}`);
    console.log(`    pages=${cr.pagesCrawled ?? 0}  queue=${cr.queueDepth ?? 0}  rps=${(cr.rateRps ?? 0).toFixed?.(2) ?? cr.rateRps ?? 0}`);
    if (cr.lastUrl) console.log(`    ${DIM('last ' + cr.lastUrl)}`);
  }
}

// ---------- main -------------------------------------------------------------

function printHelp() {
  console.log(`${B('Multi-Agent Crawler — CLI')}`);
  console.log('');
  console.log('  node src/cli.js index  <origin> <k> [--rate 5] [--concurrency 5] [--max-queue 500] [--max-pages 1000]');
  console.log('  node src/cli.js search <query>      [--sort relevance|depth|frequency] [--limit 50] [--format json|triples]');
  console.log('  node src/cli.js status');
}

async function main() {
  const [, , sub, ...rest] = process.argv;
  switch (sub) {
    case 'index':  return cmdIndex(rest);
    case 'search': return cmdSearch(rest);
    case 'status': return cmdStatus();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return;
    default:
      console.error(RD(`unknown subcommand: ${sub}`));
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(RD(`fatal: ${err?.message ?? err}`));
  process.exit(1);
});
