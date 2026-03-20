import { describe, it, expect } from 'vitest';

import { detectCurrentWorktree } from './cases.js';
import type { ExecSyncFn } from './cases.js';

// INVARIANT: detectCurrentWorktree detects if process.cwd() is a git worktree
//   (not the main checkout) and returns {worktreePath, branchName} or null.
// SUT: detectCurrentWorktree with injected execSync
// VERIFICATION: Test all paths — worktree, main checkout, git failure, detached HEAD.

function makeExec(responses: Record<string, string>): ExecSyncFn {
  return ((cmd: string) => {
    for (const [key, val] of Object.entries(responses)) {
      if (cmd.includes(key)) return val;
    }
    throw new Error(`unexpected command: ${cmd}`);
  }) as ExecSyncFn;
}

describe('detectCurrentWorktree', () => {
  it('returns worktree info when cwd is inside a worktree', () => {
    const exec = makeExec({
      '--git-common-dir': '/home/user/projects/nanoclaw/.git\n',
      '--show-toplevel': '/home/user/projects/nanoclaw/.claude/worktrees/456\n',
      '--abbrev-ref': 'case/260320-1430-fix-auth\n',
    });

    const result = detectCurrentWorktree(exec);
    expect(result).toEqual({
      worktreePath: '/home/user/projects/nanoclaw/.claude/worktrees/456',
      branchName: 'case/260320-1430-fix-auth',
    });
  });

  it('returns null when cwd is the main checkout', () => {
    const exec = makeExec({
      '--git-common-dir': '/home/user/projects/nanoclaw/.git\n',
      '--show-toplevel': '/home/user/projects/nanoclaw\n',
      '--abbrev-ref': 'main\n',
    });

    const result = detectCurrentWorktree(exec);
    expect(result).toBeNull();
  });

  it('returns null when git commands fail (not a git repo)', () => {
    const exec = (() => {
      throw new Error('not a git repository');
    }) as unknown as ExecSyncFn;

    const result = detectCurrentWorktree(exec);
    expect(result).toBeNull();
  });

  it('returns null on detached HEAD', () => {
    const exec = makeExec({
      '--git-common-dir': '/home/user/projects/nanoclaw/.git\n',
      '--show-toplevel': '/home/user/projects/nanoclaw/.claude/worktrees/456\n',
      '--abbrev-ref': 'HEAD\n',
    });

    const result = detectCurrentWorktree(exec);
    expect(result).toBeNull();
  });

  it('handles various worktree paths correctly', () => {
    const exec = makeExec({
      '--git-common-dir': '/home/user/projects/nanoclaw/.git\n',
      '--show-toplevel':
        '/home/user/projects/nanoclaw/.claude/worktrees/my-wt\n',
      '--abbrev-ref': 'feature/cool\n',
    });

    const result = detectCurrentWorktree(exec);
    expect(result).toEqual({
      worktreePath: '/home/user/projects/nanoclaw/.claude/worktrees/my-wt',
      branchName: 'feature/cool',
    });
  });
});
