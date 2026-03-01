/**
 * Session Pool — warm-start container reuse
 *
 * Keeps recently-used containers alive and reuses them for the same group,
 * eliminating cold-start latency for conversational UX.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

const CONTAINER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export interface PoolEntry {
  containerId: string;
  groupFolder: string;
  lastUsed: number;
}

interface SessionPoolOptions {
  maxPoolSize?: number;
  idleTimeoutMs?: number;
  reaperIntervalMs?: number;
}

const DEFAULT_MAX_POOL_SIZE = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_REAPER_INTERVAL_MS = 60 * 1000; // 60 seconds
const MIN_IDLE_TIMEOUT_MS = 60_000; // safety floor

function stopContainer(containerId: string): void {
  // Validate containerId to prevent command injection (P0 fix)
  if (!containerId || containerId.length > 128 || !CONTAINER_ID_PATTERN.test(containerId)) {
    throw new Error(`Invalid container ID: ${containerId}`);
  }
  execSync(`docker stop ${containerId} && docker rm ${containerId}`, {
    timeout: 30_000,
  });
}

export class SessionPool {
  private pool: Map<string, PoolEntry> = new Map();
  private maxPoolSize: number;
  private idleTimeoutMs: number;
  private reaperIntervalMs: number;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: SessionPoolOptions) {
    this.maxPoolSize = opts?.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE;
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.reaperIntervalMs = opts?.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;

    if (this.maxPoolSize < 0) {
      throw new Error(`maxPoolSize must be >= 0, got ${this.maxPoolSize}`);
    }
    if (this.idleTimeoutMs < MIN_IDLE_TIMEOUT_MS) {
      throw new Error(
        `idleTimeoutMs must be >= ${MIN_IDLE_TIMEOUT_MS}ms (safety floor), got ${this.idleTimeoutMs}`,
      );
    }
  }

  /**
   * Acquire a warm container for the given group.
   * Returns the entry and removes it from the pool (checked-out), or undefined on miss.
   */
  acquire(groupFolder: string): PoolEntry | undefined {
    const entry = this.pool.get(groupFolder);
    if (!entry) return undefined;

    this.pool.delete(groupFolder);
    entry.lastUsed = Date.now();
    logger.debug({ groupFolder, containerId: entry.containerId }, 'Session pool hit');
    return entry;
  }

  /**
   * Return a container to the pool after use.
   * If the group already has an entry, stops the old container first.
   * If the pool is full, evicts the LRU entry before adding.
   */
  release(groupFolder: string, containerId: string): void {
    // If same group already pooled, stop the old container
    const existing = this.pool.get(groupFolder);
    if (existing) {
      this.pool.delete(groupFolder);
      try {
        stopContainer(existing.containerId);
      } catch {
        // Best-effort stop
      }
    }

    // If pool is full, evict LRU
    if (this.pool.size >= this.maxPoolSize) {
      this.evictLRU();
    }

    this.pool.set(groupFolder, {
      containerId,
      groupFolder,
      lastUsed: Date.now(),
    });
    logger.debug({ groupFolder, containerId, poolSize: this.pool.size }, 'Session released to pool');
  }

  /**
   * Evict a specific group's container from the pool.
   * No-op if the group is not in the pool.
   */
  evict(groupFolder: string): void {
    const entry = this.pool.get(groupFolder);
    if (!entry) return;

    this.pool.delete(groupFolder);
    logger.debug({ groupFolder, containerId: entry.containerId }, 'Session evicted from pool');
    try {
      stopContainer(entry.containerId);
    } catch {
      // Best-effort stop
    }
  }

  /**
   * Gracefully stop and remove all pooled containers.
   */
  async shutdown(): Promise<void> {
    this.stopReaper();

    for (const [groupFolder, entry] of this.pool) {
      try {
        stopContainer(entry.containerId);
      } catch {
        // Best-effort stop
      }
      this.pool.delete(groupFolder);
    }
  }

  /**
   * Start the periodic reaper that evicts idle containers.
   */
  startReaper(): void {
    if (this.reaperTimer) return;

    this.reaperTimer = setInterval(() => {
      this.reap();
    }, this.reaperIntervalMs);
  }

  /**
   * Stop the periodic reaper.
   */
  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /**
   * Current number of containers in the pool.
   */
  getPoolSize(): number {
    return this.pool.size;
  }

  /**
   * Sweep all pooled containers and evict any that have exceeded the idle timeout.
   */
  private reap(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [groupFolder, entry] of this.pool) {
      if (now - entry.lastUsed > this.idleTimeoutMs) {
        expired.push(groupFolder);
      }
    }

    for (const groupFolder of expired) {
      this.evict(groupFolder);
    }
  }

  /**
   * Evict the least-recently-used container from the pool.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [groupFolder, entry] of this.pool) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = groupFolder;
      }
    }

    if (oldestKey) {
      this.evict(oldestKey);
    }
  }
}
