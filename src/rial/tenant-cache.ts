/**
 * Bounded TTL cache for wa_phone → tenant_id resolution.
 *
 * In-memory only — the integration runs as a single nanoclaw process per
 * VM, and the rial-platform `/v1/wa-links/resolve` endpoint is cheap
 * enough that a 5-minute TTL with 256 entries is plenty for V1.
 *
 * Eviction: TTL on read + LRU on insert when at capacity.
 */

export interface TenantCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** For tests: inject a clock. */
  now?: () => number;
}

interface Entry {
  tenantId: string;
  expiresAt: number;
}

export class TenantCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  // Map preserves insertion order — used to find the LRU victim cheaply.
  private readonly entries = new Map<string, Entry>();

  constructor(opts: TenantCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 256;
    this.now = opts.now ?? Date.now;
  }

  get(waPhone: string): string | null {
    const entry = this.entries.get(waPhone);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(waPhone);
      return null;
    }
    // Refresh recency: re-insert at the tail so LRU eviction picks the
    // genuinely-oldest entry instead of the most recently hit one.
    this.entries.delete(waPhone);
    this.entries.set(waPhone, entry);
    return entry.tenantId;
  }

  set(waPhone: string, tenantId: string): void {
    if (this.entries.has(waPhone)) {
      this.entries.delete(waPhone);
    } else if (this.entries.size >= this.maxEntries) {
      // Evict the oldest (first inserted / least recently used).
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(waPhone, {
      tenantId,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  delete(waPhone: string): void {
    this.entries.delete(waPhone);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
