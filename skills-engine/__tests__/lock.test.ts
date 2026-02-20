import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { acquireLock, releaseLock, isLocked } from '../lock.js';
import { LOCK_FILE } from '../constants.js';
import { createTempDir, cleanup } from './test-helpers.js';

describe('lock', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    fs.mkdirSync(path.join(tmpDir, '.nanoclaw'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('acquireLock returns a release function', () => {
    const release = acquireLock();
    expect(typeof release).toBe('function');
    expect(fs.existsSync(path.join(tmpDir, LOCK_FILE))).toBe(true);
    release();
  });

  it('releaseLock removes the lock file', () => {
    acquireLock();
    expect(fs.existsSync(path.join(tmpDir, LOCK_FILE))).toBe(true);
    releaseLock();
    expect(fs.existsSync(path.join(tmpDir, LOCK_FILE))).toBe(false);
  });

  it('acquire after release succeeds', () => {
    const release1 = acquireLock();
    release1();
    const release2 = acquireLock();
    expect(typeof release2).toBe('function');
    release2();
  });

  it('isLocked returns true when locked', () => {
    const release = acquireLock();
    expect(isLocked()).toBe(true);
    release();
  });

  it('isLocked returns false when released', () => {
    const release = acquireLock();
    release();
    expect(isLocked()).toBe(false);
  });

  it('isLocked returns false when no lock exists', () => {
    expect(isLocked()).toBe(false);
  });
});
