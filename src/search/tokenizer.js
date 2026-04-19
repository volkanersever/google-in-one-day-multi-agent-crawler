// Thin public alias for the shared tokenizer so `src/search/*` has its own
// named module on the search surface. The single source of truth for
// normalization lives in `src/util/tokenize.js` — both crawler and search
// MUST import from there so their word outputs match byte-for-byte.
export { tokenize, STOP_WORDS } from '../util/tokenize.js';
