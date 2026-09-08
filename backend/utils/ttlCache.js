// A tiny in-memory TTL cache. Not a queue or a job system — just a Map with
// expiry, for data that's expensive to fetch (a slow SAP call) and safe to
// serve slightly stale for a few minutes.
//
// Single-process only: this app runs without clustering (see server.js), so
// there's one cache per Node process and nothing to keep in sync across
// instances. If that changes, this needs to become a shared store (Redis)
// instead of growing its own invalidation protocol.

class TtlCache {
  constructor({ defaultTtlMs = 5 * 60 * 1000, sweepIntervalMs = 60 * 1000 } = {}) {
    this.defaultTtlMs = defaultTtlMs;
    this.store = new Map();

    // Lazy expiry on get() is enough for correctness; this sweep just stops
    // entries nobody re-requests from sitting in memory forever.
    const timer = setInterval(() => this.sweep(), sweepIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key) {
    this.store.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }
}

module.exports = { TtlCache };
