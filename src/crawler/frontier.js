// Per-crawl FIFO of pending URLs.
//
// Item shape: { url, origin, depth }.
// Backed by a plain array (shift cost is fine at the scales we target).
// Also keeps an in-run seen set so we never re-enqueue a URL within this run,
// independent of the cross-run visited store.

export class Frontier {
  constructor() {
    this._items = [];
    this._seen = new Set();
  }

  /**
   * Enqueue an item. Returns true if added, false if the URL was already
   * seen in this run.
   */
  enqueue(item) {
    if (!item || typeof item.url !== 'string') return false;
    if (this._seen.has(item.url)) return false;
    this._seen.add(item.url);
    this._items.push({
      url: item.url,
      origin: item.origin,
      depth: Number.isInteger(item.depth) ? item.depth : 0,
    });
    return true;
  }

  /** Remove and return the next item, or null if empty. */
  dequeue() {
    if (this._items.length === 0) return null;
    return this._items.shift();
  }

  size() {
    return this._items.length;
  }

  isEmpty() {
    return this._items.length === 0;
  }

  /** Shallow-copy snapshot for persistence. */
  toArray() {
    return this._items.map((it) => ({ url: it.url, origin: it.origin, depth: it.depth }));
  }

  /** Replace current state with items from `arr` (resuming from disk). */
  loadFromArray(arr) {
    this._items = [];
    this._seen.clear();
    if (!Array.isArray(arr)) return;
    for (const raw of arr) {
      if (!raw || typeof raw.url !== 'string') continue;
      if (this._seen.has(raw.url)) continue;
      this._seen.add(raw.url);
      this._items.push({
        url: raw.url,
        origin: raw.origin,
        depth: Number.isInteger(raw.depth) ? raw.depth : 0,
      });
    }
  }

  /** Tell the frontier that a URL has been seen (to prevent re-enqueue). */
  markSeen(url) {
    if (typeof url === 'string' && url) this._seen.add(url);
  }

  hasSeen(url) {
    return this._seen.has(url);
  }
}
