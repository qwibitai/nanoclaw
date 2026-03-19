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
    Promise.resolve({ success: true, issueNumber: 99 }),
  ),
  DEV_CASE_ISSUE_REPO: { owner: 'Garsson-io', repo: 'kaizen' },
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/test-groups/${folder}`,
}));

const mockGetActiveCasesByGithubIssue = vi.fn<(issueNumber: number) => Case[]>(
  () => [],
);
const mockInsertCase = vi.fn();
const mockCreateCaseWorkspace = vi.fn(() => ({
  workspacePath: '/test/workspace',
  worktreePath: '/test/worktree',
  branchName: 'case/test',
}));

vi.mock('./cases.js', () => ({
  getActiveCasesByGithubIssue: (...args: unknown[]) =>
    mockGetActiveCasesByGithubIssue(args[0] as number),
  getCaseById: vi.fn(),
  insertCase: (...args: unknown[]) => mockInsertCase(...args),
  generateCaseId: () => 'case-test-id',
  generateCaseName: (desc: string) => '260318-test-case',
  createCaseWorkspace: () => mockCreateCaseWorkspace(),
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

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-nanoclaw-ipc-collision',
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

// INVARIANT: Case creation is blocked when another active case exists for the same kaizen issue
// SUT: processCaseIpc with type 'case_create'
// VERIFICATION: Function returns true (handled) but does NOT call insertCase; writes collision error result
describe('case_create collision detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up any test result files
    const testDir =
      '/tmp/test-nanoclaw-ipc-collision/ipc/telegram_test/case_results';
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('blocks case creation when active case exists for same kaizen issue', async () => {
    const existingCase = {
      name: '260318-existing-case',
      status: 'active',
    } as Case;
    mockGetActiveCasesByGithubIssue.mockReturnValue([existingCase]);

    const deps = makeDeps();
    const result = await processCaseIpc(
      {
        type: 'case_create',
        description: 'Test duplicate case',
        caseType: 'dev',
        githubIssue: 42,
      },
      'telegram_test',
      true,
      deps,
    );

    expect(result).toBe(true); // Handled
    expect(mockInsertCase).not.toHaveBeenCalled(); // Case NOT created
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:-100test',
      expect.stringContaining('blocked to prevent parallel work'),
    );
  });

  test('writes collision error result file', async () => {
    const existingCase = {
      name: '260318-existing-case',
      status: 'active',
    } as Case;
    mockGetActiveCasesByGithubIssue.mockReturnValue([existingCase]);

    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Test collision result',
        caseType: 'dev',
        githubIssue: 55,
        requestId: 'test-req-123',
      },
      'telegram_test',
      true,
      deps,
    );

    const resultPath =
      '/tmp/test-nanoclaw-ipc-collision/ipc/telegram_test/case_results/test-req-123.json';
    expect(fs.existsSync(resultPath)).toBe(true);

    const resultContent = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(resultContent.error).toBe('collision');
    expect(resultContent.message).toContain('260318-existing-case');
    expect(resultContent.existingCases).toHaveLength(1);
    expect(resultContent.existingCases[0].name).toBe('260318-existing-case');
  });

  test('allows case creation with allowDuplicate override', async () => {
    const existingCase = {
      name: '260318-existing-case',
      status: 'active',
    } as Case;
    mockGetActiveCasesByGithubIssue.mockReturnValue([existingCase]);

    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Override duplicate',
        caseType: 'dev',
        githubIssue: 42,
        allowDuplicate: true,
      },
      'telegram_test',
      true,
      deps,
    );

    // Case creation should proceed (insertCase called)
    expect(mockInsertCase).toHaveBeenCalled();
  });

  test('sanitizes requestId to prevent path traversal in collision result file', async () => {
    const existingCase = {
      name: '260318-existing-case',
      status: 'active',
    } as Case;
    mockGetActiveCasesByGithubIssue.mockReturnValue([existingCase]);

    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Path traversal attempt',
        caseType: 'dev',
        githubIssue: 55,
        requestId: '../../etc/evil',
      },
      'telegram_test',
      true,
      deps,
    );

    // The sanitized file should be written with safe name, not the traversal path
    const safePath =
      '/tmp/test-nanoclaw-ipc-collision/ipc/telegram_test/case_results/etcevil.json';
    expect(fs.existsSync(safePath)).toBe(true);

    // The traversal path must NOT exist
    const evilPath =
      '/tmp/test-nanoclaw-ipc-collision/ipc/telegram_test/case_results/../../etc/evil.json';
    expect(fs.existsSync(evilPath)).toBe(false);
  });

  test('allows case creation when no collision exists', async () => {
    mockGetActiveCasesByGithubIssue.mockReturnValue([]);

    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'No collision case',
        caseType: 'dev',
        githubIssue: 99,
      },
      'telegram_test',
      true,
      deps,
    );

    // Case creation should proceed (insertCase called)
    expect(mockInsertCase).toHaveBeenCalled();
  });
});
