import fs from 'fs';
import path from 'path';

import { LOCK_FILE } from './constants.js';

const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface LockInfo {
  pid: number;
  timestamp: number;
}

function getLockPath(): string {
  return path.join(process.cwd(), LOCK_FILE);
}

function isStale(lock: LockInfo): boolean {
  return Date.now() - lock.timestamp > STALE_TIMEOUT_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(): () => void {
  const lockPath = getLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const lockInfo: LockInfo = { pid: process.pid, timestamp: Date.now() };

  try {
    // Atomic creation — fails if file already exists
    fs.writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: 'wx' });
    return () => releaseLock();
  } catch {
    // Lock file exists — check if it's stale or from a dead process
    try {
      const existing: LockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (!isStale(existing) && isProcessAlive(existing.pid)) {
        throw new Error(
          `Operation in progress (pid ${existing.pid}, started ${new Date(existing.timestamp).toISOString()}). If this is stale, delete ${LOCK_FILE}`,
        );
      }
      // Stale or dead process — overwrite
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith('Operation in progress')
      ) {
        throw err;
      }
      // Corrupt or unreadable — overwrite
    }

    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: 'wx' });
    } catch {
      throw new Error(
        'Lock contention: another process acquired the lock. Retry.',
      );
    }
    return () => releaseLock();
  }
}

export function releaseLock(): void {
  const lockPath = getLockPath();
  if (fs.existsSync(lockPath)) {
    try {
      const lock: LockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      // Only release our own lock
      if (lock.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Corrupt or missing — safe to remove
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already gone
      }
    }
  }
}

export function isLocked(): boolean {
  const lockPath = getLockPath();
  if (!fs.existsSync(lockPath)) return false;

  try {
    const lock: LockInfo = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    return !isStale(lock) && isProcessAlive(lock.pid);
  } catch {
    return false;
  }
}
