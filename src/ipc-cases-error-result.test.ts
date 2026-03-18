import { describe, test, expect, vi, beforeEach } from 'vitest';

import fs from 'fs';
import path from 'path';

import type { Case } from './cases.js';
import type { IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

// Mock all heavy dependencies before importing the SUT
vi.mock('./case-auth.js', () => ({
  authorizeCaseCreation: vi.fn(() => ({
    status: 'authorized',
    caseType: 'work',
    autoPromoted: false,
  })),
}));

vi.mock('./case-backend.js', () => ({
  getCaseSyncService: vi.fn(() => null),
}));

vi.mock('./escalation.js', () => ({
  computePriority: vi.fn(() => ({ level: 'normal' })),
  loadEscalationConfig: vi.fn(() => null),
  resolveNotificationTargets: vi.fn(() => []),
}));

vi.mock('./notification-dispatch.js', () => ({
  dispatchEscalationNotifications: vi.fn(),
}));

vi.mock('./github-api.js', () => ({
  createGitHubIssue: vi.fn(() =>
    Promise.resolve({ success: true, issueNumber: 99 }),
  ),
  DEV_CASE_ISSUE_REPO: { owner: 'Garsson-io', repo: 'kaizen' },
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/test-groups/${folder}`,
}));

const mockCreateCaseWorkspace = vi.fn(() => ({
  workspacePath: '/test/workspace',
  worktreePath: '/test/worktree',
  branchName: 'case/test',
}));

vi.mock('./cases.js', () => ({
  getActiveCasesByGithubIssue: vi.fn(() => []),
  getCaseById: vi.fn(),
  insertCase: vi.fn(),
  generateCaseId: () => 'case-test-id',
  generateCaseName: (desc: string) => '260319-test-case',
  createCaseWorkspace: (...args: unknown[]) => mockCreateCaseWorkspace(),
  suggestDevCase: vi.fn(() => ({
    id: 'suggested-id',
    name: 'suggested-name',
    github_issue: null,
  })),
  updateCase: vi.fn(),
  pruneCaseWorkspace: vi.fn(),
  removeWorktreeLock: vi.fn(),
  updateWorktreeLockHeartbeat: vi.fn(),
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-nanoclaw-ipc-error-result',
}));

import { processCaseIpc, writeCaseErrorResult } from './ipc-cases.js';

const TEST_DATA_DIR = '/tmp/test-nanoclaw-ipc-error-result';

const TEST_GROUP: RegisteredGroup = {
  name: 'Test',
  folder: 'telegram_test',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn(() => Promise.resolve()),
    registeredGroups: () => ({ 'tg:-100test': TEST_GROUP }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(() => Promise.resolve()),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    ...overrides,
  };
}

function getResultDir(): string {
  return path.join(TEST_DATA_DIR, 'ipc', 'telegram_test', 'case_results');
}

beforeEach(() => {
  vi.clearAllMocks();
  const resultDir = getResultDir();
  if (fs.existsSync(resultDir)) {
    fs.rmSync(resultDir, { recursive: true });
  }
});

// INVARIANT: Every consumed case_create IPC request produces a result file,
// even when the request is invalid or processing throws an exception.
// SUT: processCaseIpc with type 'case_create', writeCaseErrorResult
// VERIFICATION: An error result JSON file exists in case_results/ with
// error type and message after each failure path.
describe('case_create error result on failure', () => {
  test('writes error result when description is missing', async () => {
    const deps = makeDeps();
    const result = await processCaseIpc(
      {
        type: 'case_create',
        requestId: 'req-no-desc',
        // no description
      },
      'telegram_test',
      true,
      deps,
    );

    expect(result).toBe(true);

    const resultPath = path.join(getResultDir(), 'req-no-desc.json');
    expect(fs.existsSync(resultPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(content.error).toBe('validation');
    expect(content.message).toContain('description');
  });

  test('writes error result when createCaseWorkspace throws', async () => {
    mockCreateCaseWorkspace.mockImplementationOnce(() => {
      throw new Error('worktree creation failed: branch already exists');
    });

    const deps = makeDeps();
    const result = await processCaseIpc(
      {
        type: 'case_create',
        description: 'Test workspace failure',
        requestId: 'req-workspace-err',
      },
      'telegram_test',
      true,
      deps,
    );

    expect(result).toBe(true);

    const resultPath = path.join(getResultDir(), 'req-workspace-err.json');
    expect(fs.existsSync(resultPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(content.error).toBe('internal');
    expect(content.message).toContain('worktree creation failed');
  });

  test('writes error result with fallback filename when requestId is missing', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        // no description, no requestId
      },
      'telegram_test',
      true,
      deps,
    );

    const resultDir = getResultDir();
    expect(fs.existsSync(resultDir)).toBe(true);

    const files = fs.readdirSync(resultDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^error-\d+\.json$/);

    const content = JSON.parse(
      fs.readFileSync(path.join(resultDir, files[0]), 'utf-8'),
    );
    expect(content.error).toBe('validation');
  });

  test('sanitizes requestId in error result file path', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        requestId: '../../../etc/evil',
        // no description
      },
      'telegram_test',
      true,
      deps,
    );

    const safePath = path.join(getResultDir(), 'etcevil.json');
    expect(fs.existsSync(safePath)).toBe(true);

    const evilPath = path.join(getResultDir(), '../../../etc/evil.json');
    expect(fs.existsSync(evilPath)).toBe(false);
  });
});

// INVARIANT: writeCaseErrorResult always creates the result directory and file.
// SUT: writeCaseErrorResult
// VERIFICATION: Result file exists with expected content after call.
describe('writeCaseErrorResult', () => {
  test('creates result directory and writes error file', () => {
    writeCaseErrorResult({ requestId: 'req-unit-test' }, 'telegram_test', {
      error: 'test_error',
      message: 'something went wrong',
    });

    const resultPath = path.join(getResultDir(), 'req-unit-test.json');
    expect(fs.existsSync(resultPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(content).toEqual({
      error: 'test_error',
      message: 'something went wrong',
    });
  });

  test('uses timestamp fallback when requestId is absent', () => {
    writeCaseErrorResult({}, 'telegram_test', {
      error: 'no_id',
      message: 'no request id',
    });

    const files = fs.readdirSync(getResultDir());
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^error-\d+\.json$/);
  });
});
