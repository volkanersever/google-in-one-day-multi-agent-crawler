# Product Requirements Document — Multi-Agent Crawler

> Produced by **Agent 01 — Product Manager**.
> Authored from: Brightwave "Google in an Afternoon" brief, Project 2 multi-agent addendum, and the grader verification quiz.
> Status: **frozen** — downstream agents must not deviate without orchestrator approval.

---

## 1. Purpose

Build a localhost web crawler and search system that:

1. Given an `origin` URL and integer `k`, crawls the web to at most `k` hops without ever visiting the same URL twice, with explicit back-pressure.
2. Given a `query` string, returns a ranked list of `(relevant_url, origin_url, depth)` triples (plus a numeric `score`), using data indexed by the crawler.
3. Supports `search` being called **while** a crawl is still running, returning newly indexed results as they appear.
4. Exposes a simple Web UI and a CLI for both operations and for observing system state.
5. Can resume after interruption (the frontier and visited-URL set survive a process restart).
6. Is built via a **multi-agent AI workflow** (seven cooperating agents; orchestrator decides).

## 2. Non-goals

- Distributed crawling across multiple machines. Scale must be "very large on one box", not horizontally federated.
- JavaScript-rendered pages. HTML-only, no headless browser.
- Fuzzy search, stemming, synonyms. Exact-token match only (matches grader scoring).
- Authentication, user accounts, multi-tenancy.

## 3. Technology constraints

- **Runtime:** Node.js ≥ 22 (uses stdlib only).
- **Allowed modules:** `node:http`, `node:https`, `node:fs`, `node:path`, `node:url`, `node:events`, `node:stream`, `node:readline`, `node:crypto`, `node:os`, `node:worker_threads` (optional), `node:timers/promises`.
- **Disallowed:** npm packages that do the core work (no `cheerio`, `axios`, `express`, `better-sqlite3`, `lunr`, `elasticlunr`). Dev-only tooling is also avoided to keep the surface minimal.
- **Storage:** plain files under `data/` (see §6). No database.
- **Port:** `3600` (grader quiz specifies this).

## 4. Functional requirements

### 4.1 `index(origin, k, opts?)`

- Accepts:
  - `origin`: absolute HTTP or HTTPS URL.
  - `k`: integer ≥ 0 (max depth).
  - `opts` (all optional, with documented defaults):
    - `maxConcurrency` (default 5) — max parallel fetches.
    - `rateLimit` (default 5 rps) — token bucket refill rate.
    - `maxQueue` (default 500) — back-pressure threshold.
    - `maxPages` (default 1000) — hard cap for a single crawl run.
    - `userAgent` (default `"MultiAgentCrawler/1.0"`).
- Returns immediately with `{ crawlerId, acceptedAt }`; the crawl runs asynchronously.
- Crawler invariants:
  - Never fetches a URL more than once per run.
  - Never fetches a URL already in the cross-run `visited_urls.data`.
  - Never enqueues a link whose depth would exceed `k`.
  - Only fetches `http:` / `https:` schemes.
  - Only processes responses with `content-type: text/html…`.
  - Response body cap 2 MB; oversize responses are dropped with an `error` event.
- Back-pressure: when the frontier size ≥ `maxQueue`, the enqueue step sleeps 50 ms and the crawl exposes state `BACK_PRESSURE`; while `maxQueue × 0.8 ≤ size < maxQueue` the state is `THROTTLED`; otherwise `OK`.

### 4.2 `search(query, opts?)`

- Accepts:
  - `query`: non-empty string.
  - `opts.sortBy`: one of `relevance` (default) | `depth` (asc) | `frequency` (desc).
  - `opts.limit`: integer, default 50.
- Returns an array of objects:
  ```
  {
    relevant_url: string,
    origin_url:   string,
    depth:        number,
    frequency:    number,
    score:        number,
    matched_word: string
  }
  ```
  The `(relevant_url, origin_url, depth)` tuple is the contract required by the brief. `score` and the other fields are additive.
- Scoring (**locked**, grader verifies by hand):

  ```
  score = (frequency × 10) + 1000 − (depth × 5)
  ```

  The `+1000` bonus applies on an exact token match (which is the only match type supported). When a query contains multiple tokens and one URL matches more than one, scores are summed.
- Search must work correctly while an indexer is writing to the same letter file. Partial / mid-written lines (not yet flushed, or otherwise malformed — not exactly 5 whitespace-separated fields) must be silently skipped.

### 4.3 HTTP API

The server listens on port **`3600`**.

| Method | Path                                        | Purpose                                                  |
| ------ | ------------------------------------------- | -------------------------------------------------------- |
| `POST` | `/index`                                    | Body: `{origin, k, ...opts}`. Returns `{crawlerId}`.     |
| `GET`  | `/search?query=X&sortBy=relevance&limit=50` | Runs search; returns JSON array (§4.2).                  |
| `GET`  | `/status`                                   | System-wide snapshot (see §4.5).                         |
| `GET`  | `/crawls`                                   | List of past + active crawls.                            |
| `GET`  | `/crawls/:id`                               | One crawl's detail + last 200 log lines.                 |
| `GET`  | `/events`                                   | Server-Sent Events stream of crawl + queue transitions.  |
| `GET`  | `/` and `/web/*`                            | Static assets for the futuristic UI.                     |

`/search` response top-level shape:

```json
{
  "query": "python",
  "sortBy": "relevance",
  "count": 17,
  "results": [ { ... }, { ... } ]
}
```

### 4.4 CLI

```
node src/cli.js index <origin> <k> [--rate 5] [--concurrency 5] [--max-queue 500]
node src/cli.js search <query> [--sort relevance|depth|frequency] [--limit 50]
node src/cli.js status
```

The CLI talks to the HTTP server; it does not directly touch storage. This lets `search` from the CLI see live crawl state.

### 4.5 `/status` payload

```json
{
  "state": "OK | THROTTLED | BACK_PRESSURE",
  "activeCrawls": 1,
  "totals": { "pagesIndexed": 1234, "urlsVisited": 1234, "wordsIndexed": 98765 },
  "crawls": [
    {
      "crawlerId": "1713540000123_42",
      "origin": "https://example.com",
      "k": 2,
      "status": "running | finished | failed | interrupted",
      "pagesCrawled": 42,
      "queueDepth": 117,
      "rateRps": 4.8,
      "lastUrl": "https://example.com/foo",
      "startedAt": 1713540000123,
      "endedAt": null
    }
  ]
}
```

### 4.6 UI

Three views in a single-page app, hash-routed:

1. **Command Deck** — crawl launcher + live telemetry (queue depth bar, rate gauge, back-pressure state, pages/sec, last URL indexed).
2. **Search** — query box + sort selector; results re-query on new SSE `indexed` events.
3. **Crawls** — history table; clickable rows show per-crawl log.

Visual theme: dark (`#05060a`), cyan/magenta neon, glassmorphism, subtle grid, monospace for numbers. No framework.

### 4.7 Resumability

- On server start, `visited_urls.data` is loaded into an in-memory `Set<string>`.
- On server start, each `data/crawls/[crawlerId].data` with `status=running` is marked `interrupted`.
- An interrupted crawl can be resumed via `POST /crawls/:id/resume`, which reloads its persisted frontier and continues.

## 5. Non-functional requirements

- `/status` responds in ≤ 50 ms even during a 5-rps crawl.
- `/search` for a single common token on a 10 k-URL index responds in ≤ 300 ms.
- Memory: visited-URL set + one crawl's frontier must fit in ≤ 256 MB for 1 M URLs (URLs average ~80 bytes).
- Graceful shutdown on `SIGINT`: flush frontier and `visited_urls.data`, mark active crawls `interrupted`.

## 6. Storage contract (**frozen — grader inspects by hand**)

### 6.1 Layout

```
data/
├─ storage/
│  ├─ a.data
│  ├─ b.data
│  ├─ …
│  └─ z.data          # one file per initial letter, plus `_.data` for tokens starting with a digit
├─ crawls/
│  └─ <crawlerId>.data  # JSON: { crawlerId, origin, k, status, frontier:[…], stats:{…}, log:[…] }
└─ visited_urls.data   # one URL per line
```

### 6.2 Word line format

```
<word> <url> <origin> <depth> <frequency>\n
```

- Exactly **5 fields**, **single space** separator, terminated by `\n`.
- `word`: lowercase alphanumeric, length ≥ 2 (matches tokenizer).
- `url`, `origin`: the URL and the crawl origin; spaces and newlines URL-encoded (`%20`, `%0A`) if present.
- `depth`: integer, hops from `origin`.
- `frequency`: integer, occurrences of `word` on `url`.

Readers must silently skip any line that:

- has `fields.length !== 5`;
- has non-integer `depth` or `frequency`;
- is missing the trailing `\n` (treated as incomplete, pending next flush).

### 6.3 `visited_urls.data`

One fully-qualified URL per line. Normalized: lowercase host, no fragment, query string preserved. Reader loads into a `Set` at startup.

### 6.4 `<crawlerId>.data`

Canonical JSON, pretty-printed (2-space indent), rewritten atomically (write to `.tmp` then `rename`).

```json
{
  "crawlerId": "1713540000123_42",
  "origin": "https://example.com",
  "k": 2,
  "opts": { "maxConcurrency": 5, "rateLimit": 5, "maxQueue": 500 },
  "status": "running",
  "startedAt": 1713540000123,
  "endedAt": null,
  "stats": { "pagesCrawled": 42, "urlsSeen": 301, "errors": 1, "lastUrl": "…" },
  "frontier": [ { "url": "…", "origin": "…", "depth": 1 }, … ],
  "log": [ { "ts": 1713540000200, "level": "info", "msg": "fetched https://…" }, … ]
}
```

`crawlerId` format: `<epochMs>_<threadCounter>`, matching Project 1.

## 7. Acceptance tests (what the grader will do)

1. Start the server; open `http://localhost:3600`.
2. From Command Deck, submit `origin=<small public site>, k=2`. Watch telemetry populate.
3. From Search, query `python`. Observe sorted results. Refresh while still indexing; new URLs appear.
4. From terminal:
   ```
   cat data/storage/p.data | grep '^python '
   ```
   Note three lines. Compute each's score by hand using `(frequency × 10) + 1000 − (depth × 5)`. Confirm the API-returned #1 result has the matching (highest) manual score.
5. Kill the process mid-crawl; restart; verify the resumed crawl does not re-fetch already-visited URLs.

## 8. Open product decisions (orchestrator-made)

| Decision                              | Chosen                                     | Rationale                                                                 |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Storage tech                          | Plain files (letter-indexed)               | Grader needs to hand-inspect; matches Project 1; avoids experimental SQLite. |
| Scoring formula                       | `(freq × 10) + 1000 − (depth × 5)`         | Grader quiz specifies verbatim.                                           |
| URL dedup key                         | lowercased host + path + query, drop frag  | Matches typical crawler practice; query strings often produce distinct pages. |
| Search-during-indexing mechanism      | Append-only writer + tolerant reader       | Simpler than locks; partial-line guard is the only invariant.             |
| Concurrency                           | `async/await` semaphore                    | No worker-thread complexity for this scale.                               |
| Port                                  | 3600                                       | Grader quiz specifies.                                                    |
