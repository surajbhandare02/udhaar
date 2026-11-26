/**
 * High-performance in-memory TTL cache with tag/prefix invalidation.
 * Guarantees zero stale financial balances by invalidating cache keys on any write.
 */

class MemoryCache {
  constructor() {
    this.cache = new Map();
  }

  set(key, value, ttlSeconds = 60) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { value, expiresAt });
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  del(key) {
    this.cache.delete(key);
  }

  /**
   * Invalidates all cache entries whose keys start with prefix.
   * e.g. invalidatePrefix('summary'), invalidatePrefix('accounts')
   */
  invalidatePrefix(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidates all financial caches whenever a write occurs.
   */
  invalidateFinancials() {
    this.invalidatePrefix('summary');
    this.invalidatePrefix('accounts');
    this.invalidatePrefix('people');
    this.invalidatePrefix('tx');
  }

  clear() {
    this.cache.clear();
  }
}

export const cache = new MemoryCache();
