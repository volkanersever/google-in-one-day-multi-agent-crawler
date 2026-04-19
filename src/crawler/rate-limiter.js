// Token-bucket rate limiter.
//
// capacity = rps, refill = 1 token per (1000 / rps) ms.
// acquire() returns a Promise that resolves when a token is available.
//
// The bucket refills lazily (on each acquire call) rather than with a timer,
// so we never leak handles and need no explicit stop().

export class TokenBucket {
  /**
   * @param {number} rps  Refill rate in tokens/second. Must be > 0.
   */
  constructor(rps) {
    const rate = Number(rps);
    this.rps = rate > 0 ? rate : 1;
    this.capacity = Math.max(1, Math.floor(this.rps));
    this.tokens = this.capacity;
    this.refillIntervalMs = 1000 / this.rps;
    this.last = Date.now();
    this._waiters = [];
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed <= 0) return;
    const add = elapsed / this.refillIntervalMs;
    if (add > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + add);
      this.last = now;
    }
  }

  /**
   * Wait for a single token. Resolves when one is granted.
   */
  acquire() {
    return new Promise((resolve) => {
      const attempt = () => {
        this._refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          resolve();
          return;
        }
        // Schedule a retry at the moment the next token will arrive.
        const tokensNeeded = 1 - this.tokens;
        const waitMs = Math.max(1, Math.ceil(tokensNeeded * this.refillIntervalMs));
        const t = setTimeout(attempt, waitMs);
        if (typeof t.unref === 'function') t.unref();
      };
      attempt();
    });
  }
}
