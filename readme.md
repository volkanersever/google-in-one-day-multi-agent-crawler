# Google in One Day — Multi-Agent Crawler

A localhost web crawler + search system, built by a collaborating set of AI agents. Node.js stdlib only (no npm packages). Single-machine scale. File-based storage that a grader can hand-inspect.

This is Project 2 of the Brightwave "Google in an Afternoon" exercise. Project 1 implemented the same system with AI-assisted coding; this repo implements it via a **multi-agent AI workflow** — seven agents, each with a distinct role, collaborating under human (orchestrator) direction.

---

## 1. Quick start

Requires Node.js 22 or newer. No `npm install` — there are no dependencies.

```bash
git clone https://github.com/volkanersever/google-in-one-day-multi-agent-crawler
cd google-in-one-day-multi-agent-crawler
node src/server.js
# → Multi-Agent Crawler online on http://localhost:3600
```

Open http://localhost:3600 in a browser. Three views:

- **Command Deck** — launch a crawl, watch live telemetry (queue depth, pages/sec, back-pressure state).
- **Search** — query, sort by relevance / depth / frequency, results re-rank live while indexing runs.
- **Crawls** — full history with expandable per-crawl logs; resume interrupted crawls with one click.

## 2. CLI

The CLI is a thin HTTP client — the server must be running.

```bash
# start a crawl
node src/cli.js index https://en.wikipedia.org/wiki/Web_crawler 1 --rate 3 --max-pages 25

# search
node src/cli.js search "web crawler" --sort relevance --limit 10

# pure (relevant_url, origin_url, depth) triples
node src/cli.js search python --format triples

# system snapshot
node src/cli.js status
```

## 3. HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/index` | Body `{origin, k, opts?}`. Starts a crawl, returns `{crawlerId}` immediately. |
| `GET`  | `/search?query=X&sortBy=relevance&limit=50` | Returns ranked results. `&format=triples` for the pure `[[url, origin, depth], ...]` view. |
| `GET`  | `/status` | Runtime snapshot — back-pressure state, active crawls, totals. |
| `GET`  | `/crawls` | Full list of past + active crawls. |
| `GET`  | `/crawls/:id` | One crawl's full state, including last 200 log lines. |
| `POST` | `/crawls/:id/resume` | Reload the persisted frontier and continue. |
| `GET`  | `/events` | Server-Sent Events stream for live UI updates. |

Example:

```bash
curl -X POST http://localhost:3600/index \
  -H 'Content-Type: application/json' \
  -d '{"origin":"https://en.wikipedia.org/wiki/Search_engine","k":1,"opts":{"maxPages":25,"rateLimit":3}}'

curl 'http://localhost:3600/search?query=search&limit=5'
```

## 4. How it works

### 4.1 Crawl loop

1. `startCrawl({origin, k, opts})` normalizes the origin, creates a crawl record, enqueues `{url: origin, origin, depth: 0}`, and kicks off a background loop.
2. The loop repeatedly:
   - evaluates back-pressure state (`OK` / `THROTTLED` / `BACK_PRESSURE`) from `queue.size / maxQueue`;
   - pulls up to `maxConcurrency` URLs off the frontier;
   - for each URL: token-bucket `acquire()` → per-host politeness gate → `fetchPage` → `parse` → `appendWord` for every token → `markVisited` → enqueue children at `depth + 1` if `depth < k`;
   - every `STATE_FLUSH_EVERY_N_PAGES` persists crawl state to disk atomically.
3. On exit (empty frontier, `maxPages` hit, or `stopCrawl`), the record is marked `finished` and a `crawl:finish` event is emitted.

### 4.2 Back-pressure

- `size / maxQueue < 0.8` → `OK`
- `0.8 ≤ size / maxQueue < 1.0` → `THROTTLED`
- `size / maxQueue ≥ 1.0` → `BACK_PRESSURE` — the loop sleeps 50 ms between iterations to let the frontier drain. (The sleep-only-no-skip behavior was a QA-applied fix; see `QA_REPORT.md` check 5.)

Every state transition emits `bus.emit('queue:change', ...)` which the SSE stream forwards to the UI so the colored state pill and queue-depth bar update live.

### 4.3 Search while indexing

The indexer writes one line per (word, url) via `fs.appendFileSync(path, '<line>\n', {flag:'a'})`. Because each line is well under the POSIX `PIPE_BUF` (4 KB) atomicity limit, no concurrent append can split a line.

The searcher opens the relevant letter file with `node:readline` over a `fs.createReadStream`. `readline` emits only complete lines — partial final bytes are dropped until the next flush. A defense-in-depth guard rejects any line whose field count is not 5 or whose `depth` / `frequency` are not integers.

Every `/search` call opens a fresh stream, so results reflect whatever has been written at call time — no cache, no lock. This is how search sees newly indexed URLs during a live crawl.

### 4.4 Resumability

- On server startup, `visited_urls.data` is loaded into an in-memory Set and every crawl with `status=running` is flipped to `interrupted` (the process died; they didn't finish gracefully).
- `POST /crawls/:id/resume` re-reads the persisted `frontier` array and re-enters the run loop. Already-visited URLs short-circuit via the in-memory Set, so a resumed crawl never re-fetches a page it already saw.

## 5. Storage layout

```
data/
├─ storage/
│  ├─ a.data … z.data    # one file per initial letter of the indexed word
│  └─ _.data              # words starting with a digit
├─ crawls/
│  └─ <crawlerId>.data    # JSON: full state, frontier, log tail
└─ visited_urls.data      # one normalized URL per line
```

### 5.1 Word line format

Each line in a letter file is exactly:

```
<word> <url> <origin> <depth> <frequency>\n
```

Five whitespace-separated fields. Example from a real run:

```
page https://en.wikipedia.org/wiki/Web_crawler https://en.wikipedia.org/wiki/Web_crawler 0 35
```

Spaces and newlines in URLs are URL-encoded (`%20`, `%0A`). The reader rejects any line that doesn't split into exactly 5 parts, so a partial mid-write is invisible to search.

### 5.2 Scoring (hand-verifiable)

```
score = (frequency × 10) + 1000 (exact-match bonus) − (depth × 5)
```

The `+1000` bonus applies on every exact token match (the only match type the system supports). Multi-token queries sum the scores.

**Grader-style verification** (mirrors the hand quiz):

```bash
# pick a common word
grep '^page ' data/storage/p.data | head -3
# page https://en.wikipedia.org/wiki/Wikipedia:Community_portal   https://... 1 50
# page https://en.wikipedia.org/wiki/Wikipedia:File_upload_wizard https://... 1 37
# page https://en.wikipedia.org/wiki/Web_crawler                  https://... 0 35

# compute scores by hand
# (50 × 10) + 1000 − (1 × 5)  = 1495
# (37 × 10) + 1000 − (1 × 5)  = 1365
# (35 × 10) + 1000 − (0 × 5)  = 1350

# confirm via the API
curl 'http://localhost:3600/search?query=page&limit=3'
# → #1 score 1495, #2 1365, #3 1350  ✓
```

## 6. File layout

```
google-in-one-day-multi-agent-crawler/
├─ product_prd.md              # locked requirements (PM Agent output)
├─ ARCHITECTURE.md              # module contracts + concurrency model (Architect Agent)
├─ QA_REPORT.md                 # 11-check adversarial review (QA Agent)
├─ multi_agent_workflow.md      # how the 7 agents collaborated
├─ recommendation.md            # production deployment notes
├─ readme.md                    # this file
├─ agents/                      # one markdown file per agent role
│  ├─ 01-product-manager.md
│  ├─ 02-architect.md
│  ├─ 03-crawler-engineer.md
│  ├─ 04-search-engineer.md
│  ├─ 05-frontend-engineer.md
│  ├─ 06-qa-reviewer.md
│  └─ 07-documentation.md
├─ src/
│  ├─ server.js                 # HTTP + SSE server (node:http only)
│  ├─ cli.js                    # terminal client
│  ├─ config.js
│  ├─ event-bus.js
│  ├─ util/ { tokenize, url, fs-atomic }
│  ├─ storage/ { letter-store, visited-store, crawl-store }
│  ├─ crawler/ { crawler, fetcher, parser, frontier, rate-limiter }
│  └─ search/ { search, tokenizer }
├─ web/
│  ├─ index.html                # three hash-routed views
│  ├─ style.css                 # cyan/magenta glassmorphism
│  └─ app.js                    # vanilla JS + EventSource
└─ data/
   ├─ storage/*.data            # hand-inspectable word index
   ├─ crawls/*.data             # per-crawl JSON
   └─ visited_urls.data
```

## 7. Design notes

- **Why files instead of SQLite?** Grader verification is by hand — `grep`, `cat`, arithmetic. A binary SQLite file would defeat that. File storage also costs one less dependency and keeps us honest about "language-native" tooling.
- **Why no HTML parser library?** `<script>` and `<style>` strip + tag strip + link extraction is ~30 lines of regex. Pulling in Cheerio would violate the exercise's "no libraries that do the core work" constraint.
- **Why async/await and not worker_threads?** Single-box scale, I/O-bound workload, predictable back-pressure. Workers would help CPU-bound work, which this isn't.

## 8. Known limitations (deliberate scope cuts)

- No JavaScript rendering (static HTML only).
- No `robots.txt` enforcement (documented in `recommendation.md`; soft per-host rate gate is in place).
- No stemming / fuzzy match — exact token only (grader scoring assumes this).
- No persistent cross-run token store compaction (letter files grow append-only; see `recommendation.md` for tiering plan).
