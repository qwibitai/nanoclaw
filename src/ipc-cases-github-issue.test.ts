import { describe, test, expect, vi, beforeEach } from 'vitest';

import fs from 'fs';

import type { Case } from './cases.js';
import type { IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

// Mock all heavy dependencies before importing the SUT
vi.mock('./case-auth.js', () => ({
  authorizeCaseCreation: vi.fn(() => ({
    status: 'authorized',
    caseType: 'dev',
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
    Promise.resolve({ success: true, issueNumber: 999 }),
  ),
  DEV_CASE_ISSUE_REPO: { owner: 'Garsson-io', repo: 'kaizen' },
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/test-groups/${folder}`,
}));

const mockInsertCase = vi.fn();
const mockGetActiveCasesByGithubIssue = vi.fn<(issueNumber: number) => Case[]>(
  () => [],
);

vi.mock('./cases.js', () => ({
  getActiveCasesByGithubIssue: (...args: unknown[]) =>
    mockGetActiveCasesByGithubIssue(args[0] as number),
  getCaseById: vi.fn(),
  insertCase: (...args: unknown[]) => mockInsertCase(...args),
  generateCaseId: () => 'case-test-id',
  generateCaseName: (desc: string) => '260319-test-github-issue',
  createCaseWorkspace: () => ({
    workspacePath: '/test/workspace',
    worktreePath: '/test/worktree',
    branchName: 'case/test',
  }),
  resolveExistingWorktree: () => null,
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
  DATA_DIR: '/tmp/test-nanoclaw-ipc-github-issue',
}));

import { processCaseIpc } from './ipc-cases.js';

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

// INVARIANT: When IPC case_create includes githubIssue, the created case stores that exact number
// SUT: processCaseIpc → handleCaseCreate → insertCase
// VERIFICATION: The Case object passed to insertCase has github_issue equal to the input value
describe('case_create githubIssue passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const testDir =
      '/tmp/test-nanoclaw-ipc-github-issue/ipc/telegram_test/case_results';
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('preserves 3-digit githubIssue (111) without truncation', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Test issue 111',
        caseType: 'dev',
        githubIssue: 111,
      },
      'telegram_test',
      true,
      deps,
    );

    expect(mockInsertCase).toHaveBeenCalledTimes(1);
    const insertedCase = mockInsertCase.mock.calls[0][0] as Case;
    expect(insertedCase.github_issue).toBe(111);
  });

  test('preserves 3-digit githubIssue (124) without truncation', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Test issue 124',
        caseType: 'dev',
        githubIssue: 124,
      },
      'telegram_test',
      true,
      deps,
    );

    expect(mockInsertCase).toHaveBeenCalledTimes(1);
    const insertedCase = mockInsertCase.mock.calls[0][0] as Case;
    expect(insertedCase.github_issue).toBe(124);
  });

  test('preserves 2-digit githubIssue', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Test issue 42',
        caseType: 'dev',
        githubIssue: 42,
      },
      'telegram_test',
      true,
      deps,
    );

    expect(mockInsertCase).toHaveBeenCalledTimes(1);
    const insertedCase = mockInsertCase.mock.calls[0][0] as Case;
    expect(insertedCase.github_issue).toBe(42);
  });

  test('preserves 4-digit githubIssue', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Test issue 1234',
        caseType: 'dev',
        githubIssue: 1234,
      },
      'telegram_test',
      true,
      deps,
    );

    expect(mockInsertCase).toHaveBeenCalledTimes(1);
    const insertedCase = mockInsertCase.mock.calls[0][0] as Case;
    expect(insertedCase.github_issue).toBe(1234);
  });

  test('auto-creates GitHub issue when githubIssue is not provided for dev case', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Dev case without issue number',
        caseType: 'dev',
      },
      'telegram_test',
      true,
      deps,
    );

    expect(mockInsertCase).toHaveBeenCalledTimes(1);
    const insertedCase = mockInsertCase.mock.calls[0][0] as Case;
    // Should get the auto-created issue number (999 from our mock)
    expect(insertedCase.github_issue).toBe(999);
  });

  test('sets github_issue for work cases when githubIssue is provided', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Work case with issue',
        caseType: 'work',
        githubIssue: 55,
      },
      'telegram_test',
      true,
      deps,
    );

    expect(mockInsertCase).toHaveBeenCalledTimes(1);
    const insertedCase = mockInsertCase.mock.calls[0][0] as Case;
    expect(insertedCase.github_issue).toBe(55);
  });

  test('sets github_issue_url when githubIssue is provided', async () => {
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Test URL generation',
        caseType: 'dev',
        githubIssue: 120,
      },
      'telegram_test',
      true,
      deps,
    );

    expect(mockInsertCase).toHaveBeenCalledTimes(1);
    const insertedCase = mockInsertCase.mock.calls[0][0] as Case;
    expect(insertedCase.github_issue).toBe(120);
    expect(insertedCase.github_issue_url).toBe(
      'https://github.com/Garsson-io/kaizen/issues/120',
    );
  });
});
