import { describe, test, expect, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

import {
  handleCaseCreate,
  handleCaseList,
  handleCaseByBranch,
  handleCaseUpdateStatus,
  resolveMainStoreDir,
} from './cli-kaizen.js';
import type { CaseCreateDeps, CaseQueryDeps } from './cli-kaizen.js';
import type { Case } from './cases.js';

const exec = promisify(execFile);
const CLI_SOURCE = path.resolve(__dirname, 'cli-kaizen.ts');

// INVARIANT: CLI wrapper parses arguments and delegates to domain model functions
// SUT: cli-kaizen.ts (run via tsx for CI compatibility)
// VERIFICATION: We test the CLI by running it as a subprocess for argument parsing,
// and test handleCaseCreate directly with injected deps for domain logic.

describe('cli-kaizen argument parsing', () => {
  test('shows usage on --help including case-create', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, '--help']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Usage:');
      expect(error.stderr).toContain('list');
      expect(error.stderr).toContain('view');
      expect(error.stderr).toContain('case-create');
    }
  });

  test('shows usage with no arguments', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE]);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Usage:');
    }
  });

  test('rejects unknown command and lists case-create', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'bogus']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Unknown command: bogus');
      expect(error.stderr).toContain('case-create');
    }
  });

  test('view requires a number argument', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'view']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Usage:');
      expect(error.stderr).toContain('view <number>');
    }
  });

  test('case-create requires --description', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'case-create', '--type', 'dev']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('--description is required');
    }
  });

  test('case-create rejects non-numeric --github-issue', async () => {
    try {
      await exec('npx', [
        'tsx',
        CLI_SOURCE,
        'case-create',
        '--description',
        'test',
        '--github-issue',
        'abc',
      ]);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('--github-issue must be a number');
    }
  });
});

// INVARIANT: handleCaseCreate calls domain model functions with correct arguments,
// performs collision detection, and outputs structured JSON.
// SUT: handleCaseCreate function with injected deps
// VERIFICATION: Verify dep calls and JSON output.

function makeDeps(overrides?: Partial<CaseCreateDeps>): CaseCreateDeps {
  return {
    initDb: vi.fn(),
    generateId: vi.fn().mockReturnValue('case-123-abc'),
    generateName: vi.fn().mockReturnValue('260319-0512-test-case'),
    createWorkspace: vi.fn().mockReturnValue({
      workspacePath: '/tmp/worktree',
      worktreePath: '/tmp/worktree',
      branchName: 'case/260319-0512-test-case',
    }),
    resolveWorktree: vi.fn().mockReturnValue(null),
    insert: vi.fn(),
    getActiveByIssue: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe('handleCaseCreate', () => {
  test('creates a dev case with all required fields', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(
      [
        '--description',
        'Fix the auth flow',
        '--type',
        'dev',
        '--github-issue',
        '42',
      ],
      deps,
    );

    expect(deps.initDb).toHaveBeenCalled();
    expect(deps.getActiveByIssue).toHaveBeenCalledWith(42);
    expect(deps.generateId).toHaveBeenCalled();
    expect(deps.generateName).toHaveBeenCalledWith('Fix the auth flow');
    expect(deps.createWorkspace).toHaveBeenCalledWith(
      '260319-0512-test-case',
      'dev',
      'case-123-abc',
    );
    expect(deps.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'case-123-abc',
        name: '260319-0512-test-case',
        description: 'Fix the auth flow',
        type: 'dev',
        status: 'active',
        github_issue: 42,
        initiator: 'cli',
        group_folder: 'main',
        chat_jid: 'cli',
      }),
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.id).toBe('case-123-abc');
    expect(output.name).toBe('260319-0512-test-case');
    expect(output.branch_name).toBe('case/260319-0512-test-case');
    expect(output.github_issue).toBe(42);
    expect(output.type).toBe('dev');
    expect(output.status).toBe('active');

    logSpy.mockRestore();
  });

  test('uses --name override and skips generateName', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(
      [
        '--description',
        'Fix auth',
        '--type',
        'dev',
        '--name',
        '260319-0512-k42-fix-auth',
      ],
      deps,
    );

    expect(deps.generateName).not.toHaveBeenCalled();
    expect(deps.createWorkspace).toHaveBeenCalledWith(
      '260319-0512-k42-fix-auth',
      'dev',
      'case-123-abc',
    );

    logSpy.mockRestore();
  });

  test('defaults to work type when --type is not dev', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(['--description', 'Customer request'], deps);

    expect(deps.createWorkspace).toHaveBeenCalledWith(
      '260319-0512-test-case',
      'work',
      'case-123-abc',
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.type).toBe('work');

    logSpy.mockRestore();
  });

  test('blocks creation when github issue has active case', async () => {
    const deps = makeDeps({
      getActiveByIssue: vi
        .fn()
        .mockReturnValue([{ name: 'existing-case', status: 'active' }]),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      handleCaseCreate(
        ['--description', 'Test', '--type', 'dev', '--github-issue', '42'],
        deps,
      ),
    ).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('already has active case(s): existing-case'),
    );
    expect(deps.insert).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('allows duplicate with --allow-duplicate flag', async () => {
    const deps = makeDeps({
      getActiveByIssue: vi
        .fn()
        .mockReturnValue([{ name: 'existing-case', status: 'active' }]),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(
      [
        '--description',
        'Test',
        '--type',
        'dev',
        '--github-issue',
        '42',
        '--allow-duplicate',
      ],
      deps,
    );

    expect(deps.insert).toHaveBeenCalled();

    logSpy.mockRestore();
  });

  test('sets github_issue_url when github-issue provided', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(
      ['--description', 'Test', '--type', 'dev', '--github-issue', '99'],
      deps,
    );

    expect(deps.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        github_issue: 99,
        github_issue_url: expect.stringContaining('/issues/99'),
      }),
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.github_issue_url).toContain('/issues/99');

    logSpy.mockRestore();
  });

  test('sets github_issue to null when not provided', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(['--description', 'Simple work case'], deps);

    expect(deps.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        github_issue: null,
        github_issue_url: null,
      }),
    );
    expect(deps.getActiveByIssue).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  // INVARIANT: When --worktree-path and --branch-name are provided,
  // handleCaseCreate adopts the existing worktree instead of creating a new one.
  // SUT: handleCaseCreate with --worktree-path and --branch-name flags
  // VERIFICATION: createWorkspace is NOT called; case record uses provided paths.

  test('adopts existing worktree when --worktree-path and --branch-name provided', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(
      [
        '--description',
        'Fix auth',
        '--type',
        'dev',
        '--worktree-path',
        '/home/user/projects/nanoclaw/.claude/worktrees/260319-fix-auth',
        '--branch-name',
        'case/260319-fix-auth',
      ],
      deps,
    );

    expect(deps.createWorkspace).not.toHaveBeenCalled();

    expect(deps.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree_path:
          '/home/user/projects/nanoclaw/.claude/worktrees/260319-fix-auth',
        branch_name: 'case/260319-fix-auth',
        workspace_path:
          '/home/user/projects/nanoclaw/.claude/worktrees/260319-fix-auth',
      }),
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.worktree_path).toBe(
      '/home/user/projects/nanoclaw/.claude/worktrees/260319-fix-auth',
    );
    expect(output.branch_name).toBe('case/260319-fix-auth');

    logSpy.mockRestore();
  });

  test('requires both --worktree-path and --branch-name together', async () => {
    const deps = makeDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      handleCaseCreate(
        [
          '--description',
          'Test',
          '--type',
          'dev',
          '--worktree-path',
          '/tmp/worktree',
        ],
        deps,
      ),
    ).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '--worktree-path and --branch-name must be used together',
      ),
    );
    expect(deps.insert).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('requires both --branch-name and --worktree-path together (reverse)', async () => {
    const deps = makeDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      handleCaseCreate(
        [
          '--description',
          'Test',
          '--type',
          'dev',
          '--branch-name',
          'case/test',
        ],
        deps,
      ),
    ).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '--worktree-path and --branch-name must be used together',
      ),
    );
    expect(deps.insert).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// INVARIANT: resolveMainStoreDir returns the main checkout's store dir,
// not the worktree's, using resolveProjectRoot() internally.
// SUT: resolveMainStoreDir function
// VERIFICATION: Returns <main-checkout>/store (or store-{instance}).

describe('resolveMainStoreDir', () => {
  test('resolves store dir under project root', () => {
    const result = resolveMainStoreDir();
    // Should end with /store (basename check, CI-portable)
    expect(path.basename(result)).toBe('store');
  });

  test('handles instance suffix via NANOCLAW_INSTANCE env var', () => {
    const original = process.env.NANOCLAW_INSTANCE;
    process.env.NANOCLAW_INSTANCE = 'staging';
    try {
      const result = resolveMainStoreDir();
      expect(path.basename(result)).toBe('store-staging');
    } finally {
      if (original === undefined) {
        delete process.env.NANOCLAW_INSTANCE;
      } else {
        process.env.NANOCLAW_INSTANCE = original;
      }
    }
  });
});

// INVARIANT: When --branch-name and --worktree-path are provided and the worktree path
//   exists, handleCaseCreate skips createWorkspace and uses the existing worktree.
// SUT: handleCaseCreate with --branch-name and --worktree-path flags
// VERIFICATION: Verify createWorkspace is NOT called, and the case record uses the
//   provided branch/worktree values.

describe('handleCaseCreate with existing worktree', () => {
  test('reuses existing worktree when --branch-name and --worktree-path provided', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(
      [
        '--description',
        'Fix auth',
        '--type',
        'dev',
        '--branch-name',
        'my-existing-branch',
        '--worktree-path',
        '/existing/worktree',
      ],
      deps,
    );

    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(deps.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree_path: '/existing/worktree',
        workspace_path: '/existing/worktree',
        branch_name: 'my-existing-branch',
      }),
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.worktree_path).toBe('/existing/worktree');
    expect(output.branch_name).toBe('my-existing-branch');

    logSpy.mockRestore();
  });

  test('creates new workspace when no worktree flags provided', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCaseCreate(
      ['--description', 'Fix auth', '--type', 'dev'],
      deps,
    );

    expect(deps.createWorkspace).toHaveBeenCalled();

    logSpy.mockRestore();
  });

  test('errors when --branch-name provided without --worktree-path', async () => {
    const deps = makeDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      handleCaseCreate(
        [
          '--description',
          'Fix auth',
          '--type',
          'dev',
          '--branch-name',
          'my-branch',
        ],
        deps,
      ),
    ).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      'Error: --worktree-path and --branch-name must be used together',
    );
    expect(deps.createWorkspace).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('errors when --worktree-path provided without --branch-name', async () => {
    const deps = makeDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      handleCaseCreate(
        [
          '--description',
          'Fix auth',
          '--type',
          'dev',
          '--worktree-path',
          '/some/path',
        ],
        deps,
      ),
    ).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      'Error: --worktree-path and --branch-name must be used together',
    );
    expect(deps.createWorkspace).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// INVARIANT: case-list returns cases from the domain model, filtered by status/type.
// SUT: handleCaseList with injected deps
// VERIFICATION: Verify correct domain functions are called and JSON output is produced.

const FAKE_CASE: Case = {
  id: 'case-1',
  group_folder: 'main',
  chat_jid: 'cli',
  name: '260319-test-case',
  description: 'Test case',
  type: 'dev',
  status: 'active',
  blocked_on: null,
  worktree_path: '/tmp/wt',
  workspace_path: '/tmp/wt',
  branch_name: 'case/test',
  initiator: 'cli',
  initiator_channel: null,
  last_message: null,
  last_activity_at: '2026-03-19T00:00:00Z',
  conclusion: null,
  created_at: '2026-03-19T00:00:00Z',
  done_at: null,
  reviewed_at: null,
  pruned_at: null,
  total_cost_usd: 0,
  token_source: null,
  time_spent_ms: 0,
  github_issue: 42,
  github_issue_url: 'https://github.com/Garsson-io/kaizen/issues/42',
  customer_name: null,
  customer_phone: null,
  customer_email: null,
  customer_org: null,
  priority: null,
  gap_type: null,
};

function makeQueryDeps(overrides?: Partial<CaseQueryDeps>): CaseQueryDeps {
  return {
    initDb: vi.fn(),
    getAllCases: vi.fn().mockReturnValue([FAKE_CASE]),
    getActiveCases: vi.fn().mockReturnValue([FAKE_CASE]),
    getCasesByStatus: vi.fn().mockReturnValue([FAKE_CASE]),
    getActiveCaseByBranch: vi.fn().mockReturnValue(FAKE_CASE),
    getCaseByName: vi.fn().mockReturnValue(FAKE_CASE),
    updateCase: vi.fn(),
    ...overrides,
  };
}

describe('handleCaseList', () => {
  test('lists all cases when no filters provided', () => {
    const deps = makeQueryDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleCaseList([], deps);

    expect(deps.initDb).toHaveBeenCalled();
    expect(deps.getAllCases).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toHaveLength(1);
    expect(output[0].name).toBe('260319-test-case');

    logSpy.mockRestore();
  });

  test('filters by single status', () => {
    const deps = makeQueryDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleCaseList(['--status', 'active'], deps);

    expect(deps.getCasesByStatus).toHaveBeenCalledWith('active');
    expect(deps.getAllCases).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  test('filters by comma-separated statuses', () => {
    const deps = makeQueryDeps({
      getCasesByStatus: vi
        .fn()
        .mockImplementation((s) => (s === 'active' ? [FAKE_CASE] : [])),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleCaseList(['--status', 'active,blocked'], deps);

    expect(deps.getCasesByStatus).toHaveBeenCalledWith('active');
    expect(deps.getCasesByStatus).toHaveBeenCalledWith('blocked');

    logSpy.mockRestore();
  });

  test('filters by type', () => {
    const workCase = { ...FAKE_CASE, type: 'work' as const, name: 'work-case' };
    const deps = makeQueryDeps({
      getAllCases: vi.fn().mockReturnValue([FAKE_CASE, workCase]),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleCaseList(['--type', 'dev'], deps);

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe('dev');

    logSpy.mockRestore();
  });

  test('rejects invalid status', () => {
    const deps = makeQueryDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    expect(() => handleCaseList(['--status', 'invalid'], deps)).toThrow(
      'process.exit(1)',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid status 'invalid'"),
    );

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// INVARIANT: case-by-branch returns the active case for a branch, or null if none.
// SUT: handleCaseByBranch with injected deps
// VERIFICATION: Correct domain function called, JSON output matches.

describe('handleCaseByBranch', () => {
  test('returns case JSON when found', () => {
    const deps = makeQueryDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleCaseByBranch(['case/test'], deps);

    expect(deps.getActiveCaseByBranch).toHaveBeenCalledWith('case/test');
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.name).toBe('260319-test-case');

    logSpy.mockRestore();
  });

  test('returns null when no case found', () => {
    const deps = makeQueryDeps({
      getActiveCaseByBranch: vi.fn().mockReturnValue(undefined),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleCaseByBranch(['some-branch'], deps);

    expect(logSpy).toHaveBeenCalledWith('null');

    logSpy.mockRestore();
  });

  test('requires branch name argument', () => {
    const deps = makeQueryDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    expect(() => handleCaseByBranch([], deps)).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('case-by-branch'),
    );

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// INVARIANT: case-update-status updates case status through the domain model
// (which fires mutation hooks including GitHub sync), not raw SQL.
// SUT: handleCaseUpdateStatus with injected deps
// VERIFICATION: updateCase called with correct id and status; done_at set when status=done.

describe('handleCaseUpdateStatus', () => {
  test('updates status via domain model', () => {
    const deps = makeQueryDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleCaseUpdateStatus(['260319-test-case', 'done'], deps);

    expect(deps.getCaseByName).toHaveBeenCalledWith('260319-test-case');
    expect(deps.updateCase).toHaveBeenCalledWith(
      'case-1',
      expect.objectContaining({ status: 'done', done_at: expect.any(String) }),
    );

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.previousStatus).toBe('active');
    expect(output.newStatus).toBe('done');

    logSpy.mockRestore();
  });

  test('does not set done_at for non-done status', () => {
    const deps = makeQueryDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleCaseUpdateStatus(['260319-test-case', 'blocked'], deps);

    expect(deps.updateCase).toHaveBeenCalledWith('case-1', {
      status: 'blocked',
    });

    logSpy.mockRestore();
  });

  test('requires both name and status arguments', () => {
    const deps = makeQueryDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    expect(() => handleCaseUpdateStatus(['260319-test-case'], deps)).toThrow(
      'process.exit(1)',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('case-update-status'),
    );

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('rejects invalid status', () => {
    const deps = makeQueryDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    expect(() =>
      handleCaseUpdateStatus(['260319-test-case', 'bogus'], deps),
    ).toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid status 'bogus'"),
    );

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('errors when case not found', () => {
    const deps = makeQueryDeps({
      getCaseByName: vi.fn().mockReturnValue(undefined),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    expect(() => handleCaseUpdateStatus(['nonexistent', 'done'], deps)).toThrow(
      'process.exit(1)',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("no case found with name 'nonexistent'"),
    );

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// INVARIANT: CLI help and routing include the new case query subcommands.
// SUT: CLI subprocess execution
// VERIFICATION: Help text includes new commands; unknown command lists them.

describe('cli-kaizen case query argument parsing', () => {
  test('help includes case-list, case-by-branch, case-update-status', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, '--help']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('case-list');
      expect(error.stderr).toContain('case-by-branch');
      expect(error.stderr).toContain('case-update-status');
    }
  });

  test('unknown command lists all available commands', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'bogus']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('case-list');
      expect(error.stderr).toContain('case-by-branch');
      expect(error.stderr).toContain('case-update-status');
    }
  });
});
