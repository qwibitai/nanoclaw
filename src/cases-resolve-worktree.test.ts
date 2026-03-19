import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { resolveExistingWorktree } from './cases.js';

// INVARIANT: resolveExistingWorktree returns workspace info for valid existing worktrees,
//   and returns null for non-existent or invalid paths. It never creates files or directories.
// SUT: resolveExistingWorktree
// VERIFICATION: Create a temp directory to simulate an existing worktree, verify it returns
//   correct info. Verify it returns null for non-existent or empty paths.

describe('resolveExistingWorktree', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-worktree-test-'));
  });

  it('returns workspace info for an existing directory', () => {
    const result = resolveExistingWorktree(tmpDir, 'case/my-branch');
    expect(result).not.toBeNull();
    expect(result!.worktreePath).toBe(tmpDir);
    expect(result!.workspacePath).toBe(tmpDir);
    expect(result!.branchName).toBe('case/my-branch');
  });

  it('returns null when worktreePath does not exist', () => {
    const result = resolveExistingWorktree(
      '/nonexistent/path/xyz',
      'case/branch',
    );
    expect(result).toBeNull();
  });

  it('returns null when worktreePath is empty string', () => {
    const result = resolveExistingWorktree('', 'case/branch');
    expect(result).toBeNull();
  });

  it('returns null when branchName is empty string', () => {
    const result = resolveExistingWorktree(tmpDir, '');
    expect(result).toBeNull();
  });

  it('does not create any files or directories', () => {
    const nonExistent = path.join(tmpDir, 'should-not-be-created');
    resolveExistingWorktree(nonExistent, 'case/branch');
    expect(fs.existsSync(nonExistent)).toBe(false);
  });
});
