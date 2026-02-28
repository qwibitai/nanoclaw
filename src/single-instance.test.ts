import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireSingleInstanceLock } from './single-instance.js';

describe('single-instance lock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function tempLockPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-lock-'));
    return path.join(dir, '.nanoclaw.lock');
  }

  it('acquires and releases lock file', () => {
    const lockPath = tempLockPath();
    const lock = acquireSingleInstanceLock(lockPath);

    expect(fs.existsSync(lockPath)).toBe(true);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('throws when another live process owns lock', () => {
    const lockPath = tempLockPath();
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 4242, startedAt: new Date().toISOString() }),
    );

    vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 4242) return true as never;
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    expect(() => acquireSingleInstanceLock(lockPath)).toThrow(
      /already running/,
    );
  });

  it('replaces stale lock file', () => {
    const lockPath = tempLockPath();
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
    );

    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const lock = acquireSingleInstanceLock(lockPath);
    const raw = fs.readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw) as { pid: number };

    expect(data.pid).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
