/**
 * Access tracker for memory retrieval pipeline.
 * Tracks memory access patterns for reinforcement-based time decay.
 *
 * Access data is stored in each entry's metadata JSON (_accessCount,
 * _lastAccessedAt) so it persists across restarts. The in-memory map
 * acts as a write-back cache — callers should periodically flush via
 * the store's update() method (or accept that counts reset on restart
 * if they choose not to flush).
 */

export interface AccessMetadata {
  accessCount: number;
  lastAccessedAt: number;
}

/**
 * Parse access metadata from a memory entry's metadata JSON string.
 */
export function parseAccessMetadata(metadata?: string): AccessMetadata {
  if (!metadata) return { accessCount: 0, lastAccessedAt: 0 };
  try {
    const parsed = JSON.parse(metadata);
    return {
      accessCount: typeof parsed._accessCount === "number" ? parsed._accessCount : 0,
      lastAccessedAt: typeof parsed._lastAccessedAt === "number" ? parsed._lastAccessedAt : 0,
    };
  } catch {
    return { accessCount: 0, lastAccessedAt: 0 };
  }
}

/**
 * Merge updated access metadata back into a metadata JSON string,
 * preserving any existing user-defined fields.
 */
export function mergeAccessMetadata(
  existingMetadata: string | undefined,
  access: AccessMetadata,
): string {
  let parsed: Record<string, unknown> = {};
  if (existingMetadata) {
    try { parsed = JSON.parse(existingMetadata); } catch { /* ignore */ }
  }
  parsed._accessCount = access.accessCount;
  parsed._lastAccessedAt = access.lastAccessedAt;
  return JSON.stringify(parsed);
}

/**
 * Compute effective half-life for time decay, extended by access frequency.
 * More frequently accessed memories decay slower.
 */
export function computeEffectiveHalfLife(
  baseHalfLife: number,
  accessCount: number,
  _lastAccessedAt: number,
  reinforcementFactor: number,
  maxMultiplier: number,
): number {
  if (accessCount <= 0 || reinforcementFactor <= 0) return baseHalfLife;
  const multiplier = Math.min(
    1 + reinforcementFactor * Math.log2(1 + accessCount),
    maxMultiplier,
  );
  return baseHalfLife * multiplier;
}

/**
 * Tracks memory access patterns to reinforce frequently recalled memories.
 * The in-memory map serves as a session cache. For persistence, callers
 * should read _accessCount/_lastAccessedAt from entry metadata on load
 * and write them back via store.update() after recording access.
 */
export class AccessTracker {
  private accessLog = new Map<string, { count: number; lastAt: number }>();

  /**
   * Seed the tracker from persisted metadata (call once per entry on load).
   */
  seedFromMetadata(id: string, metadata?: string): void {
    if (this.accessLog.has(id)) return; // already seeded
    const { accessCount, lastAccessedAt } = parseAccessMetadata(metadata);
    if (accessCount > 0) {
      this.accessLog.set(id, { count: accessCount, lastAt: lastAccessedAt });
    }
  }

  recordAccess(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) {
      const existing = this.accessLog.get(id);
      this.accessLog.set(id, {
        count: (existing?.count ?? 0) + 1,
        lastAt: now,
      });
    }
  }

  getAccessInfo(id: string): { count: number; lastAt: number } | undefined {
    return this.accessLog.get(id);
  }

  /**
   * Return all tracked IDs (for persistence).
   * Caller should write access metadata back to the store for these entries.
   */
  getTrackedIds(): string[] {
    return Array.from(this.accessLog.keys());
  }
}
