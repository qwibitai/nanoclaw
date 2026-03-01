import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Session Pool — RED phase tests
 *
 * These tests are written against the module spec ONLY.
 * The production module (session-pool.ts) does not exist yet.
 * We dynamically import it so vitest can register each test case
 * individually, rather than failing the entire suite at import time.
 */

// Mock child_process before any imports that might use it
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
}));

import { execSync } from 'child_process';
const mockedExecSync = vi.mocked(execSync);

// Expected interface (from spec — NOT production code)
interface PoolEntry {
  containerId: string;
  groupFolder: string;
  lastUsed: number;
}

interface SessionPoolInterface {
  acquire(groupFolder: string): PoolEntry | undefined;
  release(groupFolder: string, containerId: string): void;
  evict(groupFolder: string): void;
  shutdown(): Promise<void>;
  startReaper(): void;
  stopReaper(): void;
  getPoolSize(): number;
}

interface SessionPoolConstructor {
  new (opts?: {
    maxPoolSize?: number;
    idleTimeoutMs?: number;
    reaperIntervalMs?: number;
  }): SessionPoolInterface;
}

async function loadSessionPool(): Promise<SessionPoolConstructor> {
  const mod = await import('./session-pool.js');
  return mod.SessionPool;
}

describe('SessionPool', () => {
  let SessionPool: SessionPoolConstructor;
  let pool: SessionPoolInterface;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    SessionPool = await loadSessionPool();

    pool = new SessionPool({
      maxPoolSize: 3,
      idleTimeoutMs: 10 * 60 * 1000, // 10 minutes
      reaperIntervalMs: 60 * 1000, // 60 seconds
    });
  });

  afterEach(() => {
    pool?.stopReaper();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------
  // 1. "should reuse warm container for same group"
  // SPEC: WHEN a group sends a message and a warm container exists
  //       for that group (keyed by group folder), THEN reuse it.
  // -----------------------------------------------------------
  it('should reuse warm container for same group', () => {
    const groupFolder = 'groups/alpha';
    const containerId = 'container-abc123';

    // Container completes and is returned to the pool
    pool.release(groupFolder, containerId);

    // Acquire should return the warm container for same group
    const entry = pool.acquire(groupFolder);

    expect(entry).toBeDefined();
    expect(entry!.containerId).toBe(containerId);
    expect(entry!.groupFolder).toBe(groupFolder);
  });

  // -----------------------------------------------------------
  // 2. "should spawn new container when pool miss"
  // SPEC: WHEN no warm container exists, THEN acquire returns undefined
  //       (caller spawns a new one).
  // -----------------------------------------------------------
  it('should spawn new container when pool miss', () => {
    const groupFolder = 'groups/beta';

    // No container released for this group — pool miss
    const entry = pool.acquire(groupFolder);

    expect(entry).toBeUndefined();
  });

  // -----------------------------------------------------------
  // 3. "should evict container after idle timeout"
  // SPEC: WHEN a container has been idle for > POOL_IDLE_TIMEOUT
  //       (default 10min), THEN evict it (docker stop + remove).
  // -----------------------------------------------------------
  it('should evict container after idle timeout', () => {
    const groupFolder = 'groups/gamma';
    const containerId = 'container-idle1';

    pool.release(groupFolder, containerId);

    // Start reaper
    pool.startReaper();

    // Advance past idle timeout + one reaper interval to trigger sweep
    vi.advanceTimersByTime(10 * 60 * 1000 + 60 * 1000);

    pool.stopReaper();

    // Container should have been evicted — acquire returns undefined
    const entry = pool.acquire(groupFolder);
    expect(entry).toBeUndefined();

    // docker stop should have been called for the evicted container
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining(containerId),
      expect.anything(),
    );
  });

  // -----------------------------------------------------------
  // 4. "should evict LRU when pool is full"
  // SPEC: WHEN pool size reaches MAX_POOL_SIZE, THEN evict the
  //       least-recently-used container before adding a new one.
  // -----------------------------------------------------------
  it('should evict LRU when pool is full', () => {
    // Fill pool to max (3)
    pool.release('groups/a', 'container-a');
    vi.advanceTimersByTime(100);
    pool.release('groups/b', 'container-b');
    vi.advanceTimersByTime(100);
    pool.release('groups/c', 'container-c');
    vi.advanceTimersByTime(100);

    expect(pool.getPoolSize()).toBe(3);

    // Release a 4th — should evict LRU (container-a, oldest lastUsed)
    pool.release('groups/d', 'container-d');

    expect(pool.getPoolSize()).toBe(3);

    // LRU (groups/a) should be gone
    const evictedEntry = pool.acquire('groups/a');
    expect(evictedEntry).toBeUndefined();

    // New one should be present
    const newEntry = pool.acquire('groups/d');
    expect(newEntry).toBeDefined();
    expect(newEntry!.containerId).toBe('container-d');

    // docker stop should have been called for evicted LRU container
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('container-a'),
      expect.anything(),
    );
  });

  // -----------------------------------------------------------
  // 5. "should remove failed container from pool"
  // SPEC: WHEN a pooled container fails or exits unexpectedly,
  //       THEN remove it from pool. Next request spawns fresh.
  // -----------------------------------------------------------
  it('should remove failed container from pool', () => {
    const groupFolder = 'groups/delta';
    const containerId = 'container-fail1';

    pool.release(groupFolder, containerId);
    expect(pool.getPoolSize()).toBe(1);

    // Container failed — evict it
    pool.evict(groupFolder);

    expect(pool.getPoolSize()).toBe(0);

    // Next acquire returns undefined (pool miss → caller spawns fresh)
    const entry = pool.acquire(groupFolder);
    expect(entry).toBeUndefined();
  });

  // -----------------------------------------------------------
  // 6. "should clean up all containers on shutdown"
  // SPEC: WHEN the application shuts down (SIGTERM/SIGINT),
  //       THEN gracefully stop and remove all pooled containers.
  // -----------------------------------------------------------
  it('should clean up all containers on shutdown', async () => {
    pool.release('groups/x', 'container-x1');
    pool.release('groups/y', 'container-y1');
    pool.release('groups/z', 'container-z1');

    expect(pool.getPoolSize()).toBe(3);

    await pool.shutdown();

    expect(pool.getPoolSize()).toBe(0);

    // docker stop should have been called for every pooled container
    const dockerCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('docker'),
    );
    expect(dockerCalls.length).toBeGreaterThanOrEqual(3);
  });

  // -----------------------------------------------------------
  // 7. "should track lastUsed timestamp on reuse"
  // SPEC: Container entries track lastUsed for LRU eviction.
  //       Acquiring (reusing) updates lastUsed.
  // -----------------------------------------------------------
  it('should track lastUsed timestamp on reuse', () => {
    const groupFolder = 'groups/epsilon';
    const containerId = 'container-ts1';

    pool.release(groupFolder, containerId);

    const initialTime = Date.now();

    // Advance 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);

    // Acquire should update lastUsed
    const entry = pool.acquire(groupFolder);
    expect(entry).toBeDefined();
    expect(entry!.lastUsed).toBeGreaterThan(initialTime);
    expect(entry!.lastUsed).toBe(initialTime + 5 * 60 * 1000);
  });

  // -----------------------------------------------------------
  // 8. "should respect MAX_POOL_SIZE config"
  // SPEC: MAX_POOL_SIZE is configurable (default 3).
  // -----------------------------------------------------------
  it('should respect MAX_POOL_SIZE config', () => {
    const smallPool = new SessionPool({
      maxPoolSize: 2,
      idleTimeoutMs: 10 * 60 * 1000,
    });

    smallPool.release('groups/p', 'container-p');
    smallPool.release('groups/q', 'container-q');

    expect(smallPool.getPoolSize()).toBe(2);

    // Adding a 3rd should evict LRU
    smallPool.release('groups/r', 'container-r');

    expect(smallPool.getPoolSize()).toBe(2);

    // LRU (groups/p) should be evicted
    const evicted = smallPool.acquire('groups/p');
    expect(evicted).toBeUndefined();

    // Newest should be present
    const present = smallPool.acquire('groups/r');
    expect(present).toBeDefined();

    smallPool.stopReaper();
  });

  // -----------------------------------------------------------
  // 9. "should reject pool size < 0 and idle timeout < 60s"
  // SPEC REJECTS: Pool size < 0. Idle timeout < 60s (safety floor).
  // -----------------------------------------------------------
  describe('config validation rejects', () => {
    it('should reject pool size < 0', () => {
      expect(() => {
        new SessionPool({ maxPoolSize: -1 });
      }).toThrow();
    });

    it('should reject negative pool size', () => {
      expect(() => {
        new SessionPool({ maxPoolSize: -5 });
      }).toThrow();
    });

    it('should reject idle timeout < 60s', () => {
      expect(() => {
        new SessionPool({ idleTimeoutMs: 59_999 }); // 59.999s < 60s
      }).toThrow();
    });

    it('should reject idle timeout of 0', () => {
      expect(() => {
        new SessionPool({ idleTimeoutMs: 0 });
      }).toThrow();
    });

    it('should reject negative idle timeout', () => {
      expect(() => {
        new SessionPool({ idleTimeoutMs: -1000 });
      }).toThrow();
    });

    it('should accept idle timeout of exactly 60s (boundary)', () => {
      // 60s is the safety floor — exactly 60s should be accepted
      expect(() => {
        new SessionPool({ idleTimeoutMs: 60_000 });
      }).not.toThrow();
    });
  });

  // -----------------------------------------------------------
  // Reaper runs periodically and evicts expired containers
  // SPEC: WHEN the reaper runs (every 60s), THEN check all pooled
  //       containers for idle timeout and evict expired ones.
  // -----------------------------------------------------------
  it('should run reaper periodically and evict expired containers', () => {
    pool.release('groups/reap1', 'container-r1');
    pool.release('groups/reap2', 'container-r2');

    pool.startReaper();

    // Advance past idle timeout + one reaper cycle
    vi.advanceTimersByTime(10 * 60 * 1000 + 60 * 1000);

    // Both containers should have been reaped
    expect(pool.getPoolSize()).toBe(0);

    expect(pool.acquire('groups/reap1')).toBeUndefined();
    expect(pool.acquire('groups/reap2')).toBeUndefined();

    pool.stopReaper();
  });

  // -----------------------------------------------------------
  // Reaper spares non-expired containers
  // -----------------------------------------------------------
  it('should not evict containers that have not exceeded idle timeout', () => {
    pool.release('groups/fresh', 'container-fresh');

    pool.startReaper();

    // Advance only 5 minutes — well under the 10-minute timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 60 * 1000);

    // Container should still be pooled
    expect(pool.getPoolSize()).toBe(1);

    const entry = pool.acquire('groups/fresh');
    expect(entry).toBeDefined();
    expect(entry!.containerId).toBe('container-fresh');

    pool.stopReaper();
  });

  // -----------------------------------------------------------
  // Containers are keyed by group folder — different group = miss
  // -----------------------------------------------------------
  it('should not return container for a different group', () => {
    pool.release('groups/one', 'container-one');

    const entry = pool.acquire('groups/two');
    expect(entry).toBeUndefined();

    // Original group's container should still be present
    const original = pool.acquire('groups/one');
    expect(original).toBeDefined();
  });

  // -----------------------------------------------------------
  // Scheduled tasks use the pool (same group = same pool entry)
  // SPEC: WHEN a scheduled task needs a container, THEN it uses
  //       the pool too (same group = same pool entry).
  // -----------------------------------------------------------
  it('should allow scheduled tasks to use pool via same group key', () => {
    const groupFolder = 'groups/main';
    const containerId = 'container-sched1';

    // Conversational message returned this container to pool
    pool.release(groupFolder, containerId);

    // Scheduled task for same group acquires from pool
    const entry = pool.acquire(groupFolder);
    expect(entry).toBeDefined();
    expect(entry!.containerId).toBe(containerId);
    expect(entry!.groupFolder).toBe(groupFolder);
  });

  // -----------------------------------------------------------
  // Evict calls docker stop for the container
  // SPEC: evict → docker stop + remove
  // -----------------------------------------------------------
  it('should call docker stop when evicting a container', () => {
    pool.release('groups/stopper', 'container-stop1');

    pool.evict('groups/stopper');

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('container-stop1'),
      expect.anything(),
    );
  });

  // -----------------------------------------------------------
  // Evicting non-existent group is a no-op
  // -----------------------------------------------------------
  it('should handle eviction of non-existent group gracefully', () => {
    expect(() => {
      pool.evict('groups/nonexistent');
    }).not.toThrow();
  });

  // -----------------------------------------------------------
  // Releasing same group with new container replaces old entry
  // -----------------------------------------------------------
  it('should overwrite pool entry when releasing same group with new container', () => {
    pool.release('groups/overwrite', 'container-old');
    pool.release('groups/overwrite', 'container-new');

    const entry = pool.acquire('groups/overwrite');
    expect(entry).toBeDefined();
    expect(entry!.containerId).toBe('container-new');

    // Old container should have been stopped
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('container-old'),
      expect.anything(),
    );
  });

  // -----------------------------------------------------------
  // Pool size tracks correctly through mixed operations
  // -----------------------------------------------------------
  it('should maintain accurate pool size through mixed operations', () => {
    expect(pool.getPoolSize()).toBe(0);

    pool.release('groups/m1', 'c1');
    expect(pool.getPoolSize()).toBe(1);

    pool.release('groups/m2', 'c2');
    expect(pool.getPoolSize()).toBe(2);

    // Acquire removes from pool
    pool.acquire('groups/m1');
    expect(pool.getPoolSize()).toBe(1);

    pool.evict('groups/m2');
    expect(pool.getPoolSize()).toBe(0);
  });
});
