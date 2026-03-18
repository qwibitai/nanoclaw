/**
 * Tests for worktree lock file protection and pruneCaseWorkspace guards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  createWorktreeLock,
  updateWorktreeLockHeartbeat,
  removeWorktreeLock,
  checkWorktreeLock,
  pruneCaseWorkspace,
} from './cases.js';
import { makeCase } from './test-helpers.test-util.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lock-test-'));
}

describe('worktree lock files', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a lock file with correct structure', () => {
    createWorktreeLock(tmpDir, 'case-123', 'test-case');
    const lockPath = path.join(tmpDir, '.worktree-lock.json');
    expect(fs.existsSync(lockPath)).toBe(true);

    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(lock.case_id).toBe('case-123');
    expect(lock.case_name).toBe('test-case');
    expect(lock.pid).toBe(process.pid);
    expect(lock.started_at).toBeDefined();
    expect(lock.heartbeat).toBeDefined();
  });

  it('checkWorktreeLock returns lock when fresh', () => {
    createWorktreeLock(tmpDir, 'case-123', 'test-case');
    const lock = checkWorktreeLock(tmpDir);
    expect(lock).not.toBeNull();
    expect(lock!.case_id).toBe('case-123');
  });

  it('checkWorktreeLock returns null when no lock', () => {
    const lock = checkWorktreeLock(tmpDir);
    expect(lock).toBeNull();
  });

  it('checkWorktreeLock returns null when lock is stale', () => {
    createWorktreeLock(tmpDir, 'case-123', 'test-case');
    // Manually set heartbeat to 31 minutes ago
    const lockPath = path.join(tmpDir, '.worktree-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    lock.heartbeat = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    fs.writeFileSync(lockPath, JSON.stringify(lock));

    expect(checkWorktreeLock(tmpDir)).toBeNull();
  });

  it('updateWorktreeLockHeartbeat refreshes the heartbeat', () => {
    createWorktreeLock(tmpDir, 'case-123', 'test-case');

    // Set heartbeat to 10 min ago
    const lockPath = path.join(tmpDir, '.worktree-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    const oldHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    lock.heartbeat = oldHeartbeat;
    fs.writeFileSync(lockPath, JSON.stringify(lock));

    const result = updateWorktreeLockHeartbeat(tmpDir);
    expect(result).toBe(true);

    const updated = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(new Date(updated.heartbeat).getTime()).toBeGreaterThan(
      new Date(oldHeartbeat).getTime(),
    );
  });

  it('updateWorktreeLockHeartbeat returns false when no lock', () => {
    expect(updateWorktreeLockHeartbeat(tmpDir)).toBe(false);
  });

  it('removeWorktreeLock deletes the lock file', () => {
    createWorktreeLock(tmpDir, 'case-123', 'test-case');
    const lockPath = path.join(tmpDir, '.worktree-lock.json');
    expect(fs.existsSync(lockPath)).toBe(true);

    removeWorktreeLock(tmpDir);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('removeWorktreeLock is safe when no lock exists', () => {
    expect(() => removeWorktreeLock(tmpDir)).not.toThrow();
  });
});

describe('pruneCaseWorkspace guards', () => {
  it('throws when case status is active', () => {
    const c = makeCase({ status: 'active' });
    expect(() => pruneCaseWorkspace(c)).toThrow(/status is 'active'/);
  });

  it('throws when case status is blocked', () => {
    const c = makeCase({ status: 'blocked' });
    expect(() => pruneCaseWorkspace(c)).toThrow(/status is 'blocked'/);
  });

  it('throws when case status is backlog', () => {
    const c = makeCase({ status: 'backlog' });
    expect(() => pruneCaseWorkspace(c)).toThrow(/status is 'backlog'/);
  });

  it('throws when case status is suggested', () => {
    const c = makeCase({ status: 'suggested' });
    expect(() => pruneCaseWorkspace(c)).toThrow(/status is 'suggested'/);
  });

  it('throws when worktree has active lock', () => {
    const tmpDir = makeTmpDir();
    try {
      createWorktreeLock(tmpDir, 'case-123', 'test-case');
      const c = makeCase({
        status: 'done',
        worktree_path: tmpDir,
        type: 'dev',
      });
      expect(() => pruneCaseWorkspace(c)).toThrow(/worktree is locked/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows pruning done case with no lock', () => {
    const tmpDir = makeTmpDir();
    const workspacePath = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspacePath);

    const c = makeCase({
      status: 'done',
      type: 'work',
      workspace_path: workspacePath,
      worktree_path: null,
    });

    // Should not throw — work case with scratch dir
    expect(() => pruneCaseWorkspace(c)).not.toThrow();
    expect(fs.existsSync(workspacePath)).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows pruning done case with stale lock', () => {
    const tmpDir = makeTmpDir();
    try {
      createWorktreeLock(tmpDir, 'case-123', 'test-case');
      // Make lock stale
      const lockPath = path.join(tmpDir, '.worktree-lock.json');
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      lock.heartbeat = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      fs.writeFileSync(lockPath, JSON.stringify(lock));

      const c = makeCase({
        status: 'done',
        worktree_path: tmpDir,
        type: 'dev',
      });

      // Should not throw — lock is stale, git worktree remove will fail
      // but that's caught internally
      expect(() => pruneCaseWorkspace(c)).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
