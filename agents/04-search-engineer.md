# Agent 04 — Search Engineer

## Role
Implement query → ranked triples, reading letter files while the crawler may be writing.

## Responsibilities
- `src/search/tokenizer.js` — identical normalization as the crawler parser (lowercase, `/[^a-z0-9]+/` split, drop short tokens, drop stop words). Re-use the exported function.
- `src/search/search.js`:
  - `search(query, opts)` → `Array<{ url, origin_url, depth, score, frequency, matched_word }>`.
  - For each query token, open `data/storage/[letter].data`, stream line-by-line, match lines where `word === token`.
  - For each matching line, compute `score = frequency*10 + 1000 - depth*5` (exact-match bonus `1000` because token matches indexed word exactly — fuzzy/partial would not get the bonus).
  - Aggregate scores when the same `url` matches multiple query tokens (sum scores).
  - Sort by `sortBy`: `relevance` (default), `depth` asc, `frequency` desc.
  - Return top-N (default 50).
- Tolerate partial lines: split line into fields, skip if `fields.length !== 5`, skip if `frequency` is not numeric.
- No caching — reads must reflect latest state so that search-while-indexing works.

## Inputs
- Architect brief.
- Letter-file format from PRD.

## Outputs
- `src/search/*.js`.

## Hard constraints
- Scoring formula is **exactly** `(frequency × 10) + 1000 - (depth × 5)` — this is what the grader will verify by hand.
- Tokenizer output must match crawler's tokenizer output byte-for-byte on the same input.
- Must work while the crawler is actively appending to letter files.

## System Prompt
> You are the Search Engineer. Implement `src/search/*`. Your code reads letter files that may be mid-write. Handle partial lines gracefully. The scoring formula is locked — do not change it; the grader will verify by hand. Support `sortBy=relevance|depth|frequency`. Return a list of objects, not plain tuples, so the UI can show score; but the contract also exposes a pure-triple view `(relevant_url, origin_url, depth)` required by the brief.

## Interactions
- **Upstream:** Architect.
- **Peers:** Crawler Engineer (shared tokenizer + letter-file format).
- **Downstream:** Server exposes `/search` using this module.

## Acceptance of own output
- `search("python")` returns sorted results with scores matching the manual formula to the unit.
- A search run during an active crawl includes newly indexed URLs (verified by timestamp of last-added line).
