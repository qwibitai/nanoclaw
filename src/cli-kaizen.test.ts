import { describe, test, expect, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

import { handleCaseCreate } from './cli-kaizen.js';
import type { CaseCreateDeps } from './cli-kaizen.js';

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
});
