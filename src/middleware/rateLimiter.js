import { config } from '../config/index.js';

class SlidingWindowRateLimiter {
  constructor() {
    this.requests = new Map();
  }

  isRateLimited(key, maxRequests, windowMs = 60000) {
    if (config.IS_TEST) return false;

    const now = Date.now();
    const timestamps = this.requests.get(key) || [];

    // Filter out timestamps outside window
    const windowStart = now - windowMs;
    const recent = timestamps.filter(t => t > windowStart);

    if (recent.length >= maxRequests) {
      return true;
    }

    recent.push(now);
    this.requests.set(key, recent);

    // Periodic cleanup of stale keys
    if (this.requests.size > 1000) {
      for (const [k, ts] of this.requests.entries()) {
        const valid = ts.filter(t => t > windowStart);
        if (valid.length === 0) this.requests.delete(k);
        else this.requests.set(k, valid);
      }
    }

    return false;
  }
}

export const rateLimiter = new SlidingWindowRateLimiter();
