import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

interface LockFileData {
  pid: number;
  startedAt: string;
}

export interface InstanceLock {
  release: () => void;
}

const LOCK_FILE = path.join(DATA_DIR, '.nanoclaw.lock');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we don't have permission to signal it.
    return code === 'EPERM';
  }
}

function readLockFile(lockPath: string): LockFileData | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockFileData>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt:
        typeof parsed.startedAt === 'string'
          ? parsed.startedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function writeLockFile(lockPath: string, pid: number): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid, startedAt: new Date().toISOString() }),
    { flag: 'wx' },
  );
}

export function acquireSingleInstanceLock(
  lockPath: string = LOCK_FILE,
): InstanceLock {
  const currentPid = process.pid;

  const acquire = (): void => {
    try {
      writeLockFile(lockPath, currentPid);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw err;
      }
    }

    const existing = readLockFile(lockPath);
    if (
      existing &&
      existing.pid !== currentPid &&
      isProcessAlive(existing.pid)
    ) {
      throw new Error(
        `Another NanoClaw instance is already running (PID ${existing.pid}). ` +
          'Stop the existing service before starting a new one.',
      );
    }

    // Stale lock or malformed lock file: remove and retry once.
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      const unlinkCode = (err as NodeJS.ErrnoException).code;
      if (unlinkCode !== 'ENOENT') {
        throw err;
      }
    }

    writeLockFile(lockPath, currentPid);
  };

  acquire();

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;

      try {
        const existing = readLockFile(lockPath);
        if (existing?.pid === currentPid) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // best-effort cleanup only
      }
    },
  };
}
