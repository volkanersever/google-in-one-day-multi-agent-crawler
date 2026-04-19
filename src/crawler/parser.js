// Regex-based HTML parser.
//
// Produces:
//   - links  : absolute, normalized, safe-scheme URLs extracted from <a href="…">
//   - tokens : Map<word, frequency>  (via shared tokenize())
//
// We deliberately do NOT import a DOM library — stdlib only. The approach:
//   1. Drop <script>…</script> and <style>…</style> blocks.
//   2. Extract <a href="…"> hrefs BEFORE stripping tags.
//   3. Strip remaining tags and decode a small set of named/numeric entities.
//   4. Tokenize the cleaned visible text.

import { tokenize } from '../util/tokenize.js';
import { normalizeUrl } from '../util/url.js';

const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const TAG_RE = /<[^>]+>/g;

// Matches href="…", href='…', or href=bare (until whitespace or >). Case-insensitive.
const HREF_RE = /<a\s[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

const ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text) {
  if (!text) return '';
  let out = text;
  // Named entities we care about.
  out = out.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi, (m) => ENTITY_MAP[m.toLowerCase()] || m);
  // Numeric decimal entities: &#1234;
  out = out.replace(/&#(\d+);/g, (_m, code) => {
    const n = Number(code);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return _m;
    try { return String.fromCodePoint(n); } catch { return _m; }
  });
  // Numeric hex entities: &#xABCD;
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
    const n = parseInt(hex, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return _m;
    try { return String.fromCodePoint(n); } catch { return _m; }
  });
  return out;
}

/**
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{ links: string[], tokens: Map<string, number> }}
 */
export function parse(html, baseUrl) {
  const source = typeof html === 'string' ? html : '';

  // 1. Extract links from the RAW html (before we mutate it).
  const links = [];
  const seenInPage = new Set();
  HREF_RE.lastIndex = 0;
  let m;
  while ((m = HREF_RE.exec(source)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    const cleaned = decodeEntities(raw).trim();
    if (!cleaned) continue;
    if (cleaned.startsWith('#')) continue; // pure fragment
    if (/^javascript:/i.test(cleaned)) continue;
    if (/^mailto:/i.test(cleaned)) continue;
    if (/^tel:/i.test(cleaned)) continue;
    if (/^data:/i.test(cleaned)) continue;
    const normalized = normalizeUrl(cleaned, baseUrl);
    if (!normalized) continue;
    if (seenInPage.has(normalized)) continue;
    seenInPage.add(normalized);
    links.push(normalized);
  }

  // 2. Strip <script> and <style> blocks, then all tags.
  let text = source.replace(SCRIPT_RE, ' ').replace(STYLE_RE, ' ');
  text = text.replace(TAG_RE, ' ');

  // 3. Decode entities in the visible text.
  text = decodeEntities(text);

  // 4. Tokenize.
  const tokens = tokenize(text);

  return { links, tokens };
}
