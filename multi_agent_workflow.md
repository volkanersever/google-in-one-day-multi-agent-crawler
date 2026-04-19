# Multi-Agent Workflow

This document explains how this repository was built by seven cooperating AI agents under one human orchestrator (me, Volkan). Project 1 (Brightwave / "Google in an Afternoon") was done with AI-assisted coding — a single-agent loop. Project 2's additional requirement is that the **development process itself** demonstrate multi-agent collaboration, with clear agent roles, handoffs, and decisions.

The final runtime is a single Node.js process; the agents live only in the development phase. Their transcripts and outputs are what you are reading the end result of.

---

## 1. The seven agents

Each agent has a dedicated role file under `agents/` with its responsibilities, inputs, outputs, and the actual system prompt that was used to invoke it. Summary:

| # | Agent | Runtime | Produced |
|---|-------|---------|----------|
| 01 | **Product Manager** | Orchestrator (me) in PM role | `product_prd.md` — 170 lines, frozen requirements. Storage contract + scoring formula + port locked here. |
| 02 | **System Architect** | Orchestrator (me) in Architect role | `ARCHITECTURE.md` — module map, cross-module contracts, concurrency model, back-pressure state machine. |
| 03 | **Crawler Engineer** | Claude sub-agent (`general-purpose`), background | `src/crawler/*`, `src/storage/*` — 8 files, 1064 lines. |
| 04 | **Search Engineer** | Claude sub-agent (`general-purpose`), background | `src/search/*` — 2 files, 198 lines. |
| 05 | **Frontend Engineer** | Claude sub-agent (`general-purpose`), background | `src/server.js`, `src/cli.js`, `web/*` — 5 files, 1864 lines. |
| 06 | **QA / Code Reviewer** | Claude sub-agent (`general-purpose`) | `QA_REPORT.md` — 11-item adversarial checklist, 1 bug found + fixed. |
| 07 | **Documentation** | Orchestrator (me) in Docs role | `readme.md`, `recommendation.md`, this file. |

"Orchestrator-in-role" means I authored the document directly while staying within the agent's scope (requirements only, or architecture only, etc.). "Claude sub-agent" means I invoked the Claude Code `Agent` tool with a dedicated system prompt; each of those ran as an independent Claude instance with its own tool sandbox and produced files directly.

## 2. The handoff graph

```
              ┌──────────────────┐
   brief ──▶  │ 01 Product Mgr   │  → product_prd.md (frozen contract)
              └──────────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │ 02 Architect     │  → ARCHITECTURE.md (module contracts)
              └──────────────────┘
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
    ┌─────────┐ ┌──────────┐ ┌──────────┐
    │ 03 Crwl │ │ 04 Srch  │ │ 05 Front │   (parallel — launched same msg)
    └─────────┘ └──────────┘ └──────────┘
           │           │           │
           └───────────┼───────────┘
                       ▼
              ┌──────────────────┐
              │ 06 QA Reviewer   │  → QA_REPORT.md (+ 1 patch)
              └──────────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │ 07 Docs Agent    │  → readme.md, recommendation.md, this file
              └──────────────────┘
```

The three engineering agents worked in **parallel** — they were launched in a single message as three concurrent `Agent` tool calls. This is possible because `ARCHITECTURE.md` §2 pre-negotiated every cross-module contract (function signatures, shared modules, event bus names), so no engineer needed to wait on another's code. The orchestrator pre-wrote the shared primitives (`src/config.js`, `src/event-bus.js`, `src/util/tokenize.js`, `src/util/url.js`, `src/util/fs-atomic.js`) so both Crawler and Search could import the same tokenizer — byte-for-byte identical normalization is what makes the search formula match the indexed data.

## 3. What each agent was told (real prompts, abridged)

### Agent 03 — Crawler Engineer (excerpt from actual system prompt)

> You are **Agent 03 — Crawler Engineer** in a multi-agent project. Your role definition lives at `/…/agents/03-crawler-engineer.md`. Implement the crawler + indexer + storage modules, using Node.js stdlib ONLY. No npm packages. Node.js 22+ ESM syntax.
>
> READ FIRST (in order):
> 1. `product_prd.md`
> 2. `ARCHITECTURE.md`
> 3. `agents/03-crawler-engineer.md`
> 4. Shared primitives you MUST import (already written, do not modify): `src/config.js`, `src/event-bus.js`, `src/util/tokenize.js`, `src/util/url.js`, `src/util/fs-atomic.js`
>
> Files you MUST create (exact paths): …
>
> Key invariants (grader will verify):
> - Letter-file line format: `word url origin depth frequency\n` — exactly 5 space-separated fields.
> - Never crawl the same URL twice (in-run seen set + cross-run visited Set).
> - Scheme allow-list: http:, https: only.
> - Backpressure state transitions must fire `bus.emit('queue:change', ...)`.
> - Emit `bus.emit('crawl:index', ...)` after every successful page index.
>
> Do NOT touch `src/search/*`, `web/*`, `src/server.js`, `src/cli.js` — other agents own these.

Full prompt: see `agents/03-crawler-engineer.md` system-prompt section plus the task brief in §3 of this document.

### Agent 04 — Search Engineer (excerpt)

> You are **Agent 04 — Search Engineer**. Implement query → ranked results, reading letter-indexed files that may be mid-write. Node.js stdlib only.
>
> Scoring formula EXACTLY: `score = (frequency * 10) + 1000 - (depth * 5)` — this is LOCKED; the grader will verify by hand. Line format EXACTLY 5 whitespace-separated fields. Reader safety: ignore the last incomplete line; `node:readline` does this automatically.
>
> Also export `searchTriples(query, opts)` returning the exact brief-required triples: `[[relevant_url, origin_url, depth], ...]`.

### Agent 05 — Frontend Engineer (excerpt — UI direction was non-negotiable)

> Build (a) a polished **futuristic** web UI, (b) a minimal CLI, and (c) the HTTP/SSE server. Vanilla HTML/CSS/JS — no frameworks, no bundler, no npm. The user explicitly asked for a high-quality, futuristic-themed UI. This is non-negotiable.
>
> Dark base `#05060a`, cyan `#00f0ff` + magenta `#ff00aa` accents, glass panels with `backdrop-filter: blur(20px)` and a 1px inner glow border, subtle grid background via repeating linear-gradients, monospace for numerics, animated status dots via CSS keyframes.

### Agent 06 — QA / Code Reviewer (excerpt)

> You are an adversarial reader. Three engineering agents wrote the code in parallel. Your job is to find bugs before the grader does.
>
> Your checklist (work through each item; produce a finding per item):
>
> 1. Letter-file format integrity — sample 10 random lines…
> 2. Scoring formula fidelity — grep for `1000`, `* 10`, `* 5`. Pick 3 entries from `p.data` and verify the API returns the same score you compute by hand.
> 3. Reader tolerance — append a malformed line, verify search does not crash and does not include the malformed line.
> 4. Dedup — `sort -u | wc -l` vs `wc -l` on `visited_urls.data`. Must be equal.
> 5. Back-pressure trigger — start a crawl with `maxQueue=10` on a high-fan-out page, verify state transitions.
> 6. Resume after interruption…
> 7. Concurrent search + indexing — poll /search every 1 s for 10 s during an active crawl; count must be monotonic.
> 8. URL scheme rejection…
> 9. Static file traversal…
> 10. XSS in UI rendering…
> 11. SSE event surface…
>
> For any issue you find that is trivially one-line to fix, APPLY the fix. For larger issues, do NOT fix — escalate in the report so the orchestrator decides.

Full prompts for every agent live in their respective `agents/0X-*.md` files, each with a dedicated "System Prompt" section.

## 4. Key orchestrator decisions (what the human overrode)

### Decision 1 — Storage: SQLite → filesystem

My initial recommendation, after researching `node:sqlite` (Node 22+ built-in, WAL mode enables lock-free concurrent reader + writer): *use SQLite*. It solves the search-while-indexing requirement cleanly and is still language-native.

The user then shared the grader's hand-verification quiz, which asks: *"Open `data/storage/p.data`. Find a word that appears on multiple URLs. Copy 3 entries. Compute score by hand. Compare to API."* A SQLite binary file defeats that workflow entirely. I reversed the decision to **letter-indexed plain files with atomic line appends**. This is documented in `product_prd.md` §8 as an orchestrator-made choice. The agents downstream received the updated contract and never saw the SQLite draft.

### Decision 2 — Agent scope boundaries

The draft architecture put `src/server.js` under an "Integration" category without a named owner. In practice that would have meant one of the engineers would also have to learn HTTP + SSE. I assigned `src/server.js` to the **Frontend Engineer** (along with `src/cli.js` and `web/*`) because the server is primarily the UI's backing API. This let the Crawler and Search engineers stay pure libraries with no HTTP concerns, which made their prompts and their diffs much tighter.

### Decision 3 — `/status` totals survive crawl completion

First integration test showed `/status` reported `totals: {pagesIndexed: 0, wordsIndexed: 0}` after a crawl finished because `getRuntimeStats` only iterated in-memory active crawls, and the `runtime` Map is cleared at crawl end (see `src/crawler/crawler.js:285`). I fixed this myself rather than kicking back to the Crawler Engineer: 18-line edit that has `getRuntimeStats` also union the disk-persisted `listCrawls()` records. Documented in the edit and in the QA report.

### Decision 4 — Accept QA's back-pressure patch

QA Agent found that on a `maxQueue=10` crawl of `news.ycombinator.com`, the state flipped to `BACK_PRESSURE` and then the loop deadlocked: it slept 50 ms and hit `continue`, so it never dequeued anything and the queue never shrank. QA's one-line fix (remove the `continue`) is behavior-preserving: the loop still sleeps under pressure, but now falls through to drain the batch. I accepted the patch as-is. The QA report documents the bug, the fix, and the retest. The alternative — treating back-pressure as an ingress signal and refusing to enqueue children — is documented as a follow-up in the QA report.

### Decision 5 — Ship even with a mild follow-up

QA flagged a small defense-in-depth gap: the search-result URL renderer HTML-escapes but does not scheme-validate the `href`. Today it is safe because the crawler's `normalizeUrl` enforces http(s) at index time, so a `javascript:` URL can never enter the index. If that contract ever slipped, the UI would not catch it. I decided **not** to add the render-time guard because it would obscure the current invariant; the QA report records the decision.

## 5. What worked, what didn't

**Worked well:**

- **Parallel engineering launch.** The three engineering agents finished in wall-clock 2–6 minutes. Because `ARCHITECTURE.md` pre-negotiated every cross-module contract and the shared primitives were already written, there were zero integration conflicts on first merge. All three modules loaded cleanly on the first `node --input-type=module -e "import('./src/...')"` check.
- **QA's adversarial framing.** Asking the QA agent to "assume every other agent has been sloppy" produced a concrete, numbered checklist of probes that *exercised* the system rather than just reading the code. The back-pressure deadlock would have been invisible to a code-only review.
- **Hand-verification quiz as acceptance test.** Embedding the grader's own check procedure into `product_prd.md` §7 ("what the grader will do") meant every agent knew what "done" looks like. The scoring-formula constants ended up in a direct comment in `src/search/search.js`.

**Rough edges:**

- **Sub-agent sandboxing.** The engineering sub-agents could not run `node` to smoke-test their own modules — `Bash(node …)` was denied in their sandbox. They fell back to static import-chain verification, which was sufficient but meant every runtime issue waited for the orchestrator's integration pass. In a real multi-agent production pipeline I would give each engineer a scoped `node --eval` whitelist for `import()` smoke checks.
- **Light edit-to-merge contention risk.** If two engineers had written to the same file, both would have succeeded and the second would have silently overwritten the first. The defense here was strict module ownership declared upfront: the prompt for each engineer explicitly listed files they *must not touch*. In a larger system I would enforce this with isolated worktrees rather than a shared path.
- **/status totals bug survived the engineering phase.** None of the three engineers wrote an integration test. The bug surfaced only at orchestrator-run first boot. Adding an optional "minimal smoke test" to each engineer's acceptance criteria would have caught it at their checkpoint, not mine.

## 6. Reproducing the process

Every agent's full role description is in `agents/0X-*.md`, including the exact system prompt used to invoke the Claude sub-agents. The high-level flow:

1. Orchestrator reads the brief + the grader quiz → writes `product_prd.md` (PM role).
2. Orchestrator → writes `ARCHITECTURE.md` with cross-module contracts (Architect role).
3. Orchestrator writes shared primitives (`src/config.js`, `src/event-bus.js`, `src/util/*`).
4. Three engineering agents launched **in parallel** with their prompts from §3. Each writes only its declared files.
5. Orchestrator runs integration smoke test, applies `/status` totals fix.
6. QA agent runs the 11-check adversarial review, finds and patches the back-pressure stall.
7. Orchestrator (Docs role) writes `readme.md`, `recommendation.md`, and this file.
8. Orchestrator creates the GitHub repo, commits the code + the sample crawled data, pushes.

Total wall-clock: approximately 45 minutes of agent compute plus orchestration reads/edits. Total lines of product code: ~3,300. Total lines of documentation: ~1,400 (PRD + architecture + QA + readme + recommendation + this file + agent definitions).
