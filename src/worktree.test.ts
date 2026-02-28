import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  pruneWorktrees,
  isGitRepo,
} from './worktree.js';

let testRepo: string;

function initTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-wt-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: 'pipe',
  });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Need at least one commit for worktrees to work
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

beforeEach(() => {
  testRepo = initTestRepo();
});

afterEach(() => {
  // Clean up worktrees before removing repo
  try {
    execSync('git worktree prune', { cwd: testRepo, stdio: 'pipe' });
  } catch {}
  fs.rmSync(testRepo, { recursive: true, force: true });
});

describe('createWorktree', () => {
  it('creates a worktree directory', () => {
    const wt = createWorktree(testRepo, 'task-123');
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(wt.branch).toBe('worker/task-123');
    expect(wt.taskId).toBe('task-123');
  });

  it('creates worktree with files from base', () => {
    const wt = createWorktree(testRepo, 'task-456');
    const readme = fs.readFileSync(path.join(wt.path, 'README.md'), 'utf-8');
    expect(readme).toBe('# Test');
  });

  it('sanitizes task IDs with special characters', () => {
    const wt = createWorktree(testRepo, 'task/with spaces!');
    expect(wt.branch).toBe('worker/task-with-spaces-');
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('creates worktree from a specific branch', () => {
    // Create a branch with different content
    execSync('git checkout -b feature-x', { cwd: testRepo, stdio: 'pipe' });
    fs.writeFileSync(path.join(testRepo, 'feature.txt'), 'hello');
    execSync('git add . && git commit -m "feature"', {
      cwd: testRepo,
      stdio: 'pipe',
    });
    execSync('git checkout -', { cwd: testRepo, stdio: 'pipe' });

    const wt = createWorktree(testRepo, 'task-from-branch', 'feature-x');
    expect(fs.existsSync(path.join(wt.path, 'feature.txt'))).toBe(true);
  });

  it('isolates changes between worktrees', () => {
    const wt1 = createWorktree(testRepo, 'task-a');
    const wt2 = createWorktree(testRepo, 'task-b');

    // Write a file in wt1
    fs.writeFileSync(path.join(wt1.path, 'wt1-only.txt'), 'from wt1');

    // Should NOT appear in wt2
    expect(fs.existsSync(path.join(wt2.path, 'wt1-only.txt'))).toBe(false);
  });
});

describe('removeWorktree', () => {
  it('removes an existing worktree', () => {
    const wt = createWorktree(testRepo, 'to-remove');
    expect(fs.existsSync(wt.path)).toBe(true);

    const removed = removeWorktree(testRepo, 'to-remove');
    expect(removed).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it('returns false for non-existent worktree', () => {
    const removed = removeWorktree(testRepo, 'does-not-exist');
    expect(removed).toBe(false);
  });

  it('deletes the worker branch', () => {
    createWorktree(testRepo, 'branch-cleanup');
    removeWorktree(testRepo, 'branch-cleanup');

    const branches = execSync('git branch', {
      cwd: testRepo,
      encoding: 'utf-8',
    });
    expect(branches).not.toContain('worker/branch-cleanup');
  });
});

describe('listWorktrees', () => {
  it('returns empty array when no worktrees', () => {
    expect(listWorktrees(testRepo)).toEqual([]);
  });

  it('lists created worktrees', () => {
    createWorktree(testRepo, 'list-a');
    createWorktree(testRepo, 'list-b');

    const trees = listWorktrees(testRepo);
    expect(trees).toHaveLength(2);

    const ids = trees.map((t) => t.taskId).sort();
    expect(ids).toEqual(['list-a', 'list-b']);
  });

  it('excludes removed worktrees', () => {
    createWorktree(testRepo, 'keep');
    createWorktree(testRepo, 'remove-me');
    removeWorktree(testRepo, 'remove-me');

    const trees = listWorktrees(testRepo);
    expect(trees).toHaveLength(1);
    expect(trees[0].taskId).toBe('keep');
  });
});

describe('pruneWorktrees', () => {
  it('runs without error on clean repo', () => {
    const cleaned = pruneWorktrees(testRepo);
    expect(cleaned).toBe(0);
  });

  it('cleans stale worktree directories', () => {
    createWorktree(testRepo, 'stale-task');

    const wtPath = path.join(testRepo, '.worktrees', 'stale-task');
    // Simulate a stale worktree: nuke the entire checkout and replace
    // with an empty dir (as if disk corruption or manual rm -rf)
    fs.rmSync(wtPath, { recursive: true, force: true });
    fs.mkdirSync(wtPath, { recursive: true });

    const cleaned = pruneWorktrees(testRepo);
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});

describe('isGitRepo', () => {
  it('returns true for a git repo', () => {
    expect(isGitRepo(testRepo)).toBe(true);
  });

  it('returns false for a non-git directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    try {
      expect(isGitRepo(tmpDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns true for a worktree', () => {
    const wt = createWorktree(testRepo, 'check-repo');
    expect(isGitRepo(wt.path)).toBe(true);
  });
});
