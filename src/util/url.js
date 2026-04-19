// URL helpers shared by crawler + server.

export const SAFE_SCHEMES = new Set(['http:', 'https:']);

/**
 * Normalize a URL for deduplication:
 *  - lowercase host
 *  - strip fragment
 *  - keep query
 *  - drop default port
 *  - collapse duplicate slashes in the path (except the leading //)
 * Returns the normalized URL string, or null if the URL is invalid or unsafe.
 */
export function normalizeUrl(input, base) {
  let u;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (!SAFE_SCHEMES.has(u.protocol)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') ||
      (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  // Collapse `//` in path but keep it if path is exactly empty.
  if (u.pathname) {
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  }
  return u.toString();
}

/** URL-encode spaces and newlines so a URL fits in the 5-field space-separated line format. */
export function urlForLineFormat(url) {
  return String(url).replace(/ /g, '%20').replace(/\n/g, '%0A').replace(/\r/g, '%0D');
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
