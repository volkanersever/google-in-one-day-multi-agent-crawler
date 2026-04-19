# Architecture Design — Brightwave Multi-Agent Crawler

> Produced by **Agent 02 — System Architect** from `product_prd.md`.
> This is the single brief all three engineering agents (Crawler, Search, Frontend) read before they build in parallel. Each engineer stays within their module; contracts below are the only cross-module surface.

---

## 1. Module map

```
google-in-one-day-multi-agent-crawler/
├─ src/
│  ├─ server.js                 # HTTP + SSE, boots everything
│  ├─ cli.js                    # thin HTTP client for terminal
│  ├─ config.js                 # constants: PORT=3600, MAX_CONCURRENCY, etc.
│  ├─ event-bus.js              # singleton EventEmitter shared by crawler ↔ server
│  ├─ util/
│  │  ├─ url.js                 # normalize, safe-scheme check, host extract
│  │  ├─ tokenize.js            # THE tokenizer (both crawler + search import it)
│  │  └─ fs-atomic.js           # appendLine, writeJsonAtomic
│  ├─ storage/
│  │  ├─ letter-store.js        # append word-line; iterate letter file
│  │  ├─ visited-store.js       # Set + append-only log
│  │  └─ crawl-store.js         # <crawlerId>.data JSON lifecycle
│  ├─ crawler/
│  │  ├─ fetcher.js             # HTTP(S) GET with timeout + redirect + size cap
│  │  ├─ parser.js              # regex link + visible-text extraction
│  │  ├─ frontier.js            # per-crawl persistent FIFO
│  │  ├─ rate-limiter.js        # token bucket
│  │  └─ crawler.js             # startCrawl, runLoop, back-pressure state
│  └─ search/
│     └─ search.js              # query → ranked results using letter files
├─ web/
│  ├─ index.html
│  ├─ style.css
│  └─ app.js
├─ agents/                      # agent role definitions (already written)
├─ data/
│  ├─ storage/[letter].data
│  ├─ crawls/<id>.data
│  └─ visited_urls.data
├─ product_prd.md
├─ ARCHITECTURE.md
├─ readme.md
├─ recommendation.md
└─ multi_agent_workflow.md
```

## 2. Cross-module contracts

### 2.1 Tokenizer (shared — crawler + search must import the same function)

```js
// src/util/tokenize.js
/**
 * @param {string} text
 * @returns {Map<string, number>}  word → frequency
 */
export function tokenize(text) { … }
```

Normalization: `text.toLowerCase().split(/[^a-z0-9]+/)`, drop empty, drop length < 2, drop stop-words (`STOP_WORDS` set exported from same file).

### 2.2 Event bus (singleton)

```js
// src/event-bus.js
import { EventEmitter } from 'node:events';
export const bus = new EventEmitter();
// events: 'crawl:start', 'crawl:fetch', 'crawl:index', 'crawl:error',
//         'crawl:state', 'crawl:finish', 'queue:change'
```

SSE handler in `server.js` subscribes to `bus` and forwards to clients.

### 2.3 Letter store

```js
// src/storage/letter-store.js
export function appendWord({ word, url, origin, depth, frequency });   // atomic line write
export async function* iterateLetter(letter);                           // yields parsed valid lines
```

The reader is tolerant: fields.length !== 5 → skip; non-integer depth/frequency → skip; line without `\n` yet → treat as EOF and stop (grader + search-while-indexing both depend on this).

### 2.4 Visited store

```js
// src/storage/visited-store.js
export async function loadVisited();                 // populates Set from disk
export function hasVisited(url);                      // O(1) Set lookup
export function markVisited(url);                     // adds to Set, appends to file
export function flushVisited();                       // fsync
```

### 2.5 Crawl store

```js
// src/storage/crawl-store.js
export function createCrawl({origin, k, opts});      // returns {crawlerId, path}
export function saveCrawlState(crawlerId, patch);    // atomic JSON write
export function loadCrawl(crawlerId);                // returns state
export function listCrawls();                        // scan crawls/
```

### 2.6 Crawler

```js
// src/crawler/crawler.js
export function startCrawl({origin, k, opts});       // returns {crawlerId}, runs async
export function resumeCrawl(crawlerId);              // resumes interrupted crawl
export function getRuntimeStats();                   // snapshot for /status
```

### 2.7 Search

```js
// src/search/search.js
/**
 * @param {string} query
 * @param {{ sortBy?: 'relevance'|'depth'|'frequency', limit?: number }} opts
 * @returns {Promise<Array<Result>>}
 */
export async function search(query, opts = {});
```

## 3. Concurrency model

- Process-wide single Node event loop. No worker threads.
- Per-crawl orchestrator:
  1. Pop `MAX_CONCURRENCY` URLs off frontier, `Promise.all(fetch-parse-index)` each.
  2. After batch, flush crawl state to disk (atomic JSON rename).
  3. Emit `bus` events.
  4. Sleep until rate-limiter tokens allow next batch.
- Back-pressure: before enqueue, if `frontier.size >= maxQueue`, set state `BACK_PRESSURE` and `await setTimeout(50)` in a loop; if `size >= 0.8 * maxQueue`, set state `THROTTLED`.
- Semaphore for max concurrent fetches uses an explicit token counter with a `Promise` queue.

## 4. Search during indexing — how we avoid locks

- Writer (`letter-store.appendWord`) calls `fs.appendFileSync(letterPath, line, {flag:'a'})` — a single POSIX `write(2)` of `<PIPE_BUF` (4 KB) is atomic. Our lines cap at ~800 bytes.
- Reader (`letter-store.iterateLetter`) uses `node:readline` over a `fs.createReadStream(letterPath)`. When readline hits the end of what was on disk at stream-open time, it stops. New lines written after open are simply not seen by *that* stream — but the NEXT `/search` call opens a fresh stream and sees them. Contrast: no partial reads because `readline` buffers to `\n` and emits line events only on complete lines.
- Safety net: even if a partial line is somehow seen, the 5-field guard drops it.

## 5. Back-pressure state machine

```
frontier.size / maxQueue:
    < 0.8    → state = OK
    0.8–1.0  → state = THROTTLED         (continue but rate-limiter halved)
    ≥ 1.0    → state = BACK_PRESSURE     (enqueue loop sleeps; new links buffered into overflow file)
```

`queue:change` event fires on every transition; server pushes to SSE.

## 6. Resume after interruption

At boot:

1. `loadVisited()` populates in-memory Set from `visited_urls.data`.
2. `listCrawls()` scans `data/crawls/*.data`.
3. For any with `status === "running"`, we set `status = "interrupted"` and save.
4. Operator calls `POST /crawls/:id/resume` or UI button → `resumeCrawl(id)` re-reads the persisted `frontier` and re-enters the run loop. Already-visited URLs short-circuit via the Set.

## 7. Security & politeness

- Reject URLs whose scheme is not `http:` or `https:`.
- Normalize URL: lowercase host, no fragment, strip default ports, preserve query.
- Per-host soft politeness: `Map<host, lastFetchAt>`; if < 500 ms since last fetch, defer to later in batch. Keeps us from hammering one host on a high-fan-out page.
- User-Agent is set. `robots.txt` is out of scope (noted in recommendation).
- Static file serving in `server.js` resolves under `web/` root and rejects `..` traversal.

## 8. Error taxonomy

| Category       | Event                     | Effect on crawl                    |
| -------------- | ------------------------- | ---------------------------------- |
| Network        | `crawl:error` (kind=net)  | URL skipped, counted in stats      |
| Non-HTML       | `crawl:error` (kind=type) | URL skipped                        |
| Oversize       | `crawl:error` (kind=size) | URL skipped                        |
| Parse          | `crawl:error` (kind=parse)| URL skipped, page counted as seen  |
| Fatal (I/O)    | `crawl:error` (kind=io)   | Crawl status → `failed`, persist   |

## 9. Test plan (smoke)

- Crawl `https://example.com` with `k=1`: expect ≥ 1 page indexed, ≥ some tokens in `a.data` / `e.data`, non-zero lines.
- Search for a known word from `example.com`'s text (e.g. "domain"): expect ≥ 1 result.
- Crawl a larger test target with `maxQueue=10`: observe state transitions `OK → THROTTLED → BACK_PRESSURE → THROTTLED → OK`.
- Kill the process after ~20 pages; restart; `POST /crawls/:id/resume`; observe no duplicate lines in letter files (since visited Set carries over).

## 10. Engineering agent handoff

Each engineer receives this document + a single-paragraph focused brief. Agents work in parallel and do not depend on each other's code during their build — only on the contracts in §2.

- **Crawler Engineer** owns `src/crawler/*`, `src/storage/*`, `src/util/*`, `src/config.js`, `src/event-bus.js`, the indexing side of `src/indexer/indexer.js`.
- **Search Engineer** owns `src/search/*`, collaborates on `src/util/tokenize.js` (single source of truth — Crawler Engineer writes it first so search can import it).
- **Frontend Engineer** owns `web/*`, `src/cli.js`, and `src/server.js` (HTTP + SSE wiring — because the server is primarily the UI's backing API; this keeps crawler and search pure libraries).
