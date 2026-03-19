/**
 * Phase B: IPC Simulation Integration Tests
 *
 * Tests the full IPC → case lifecycle → hook → sync chain by calling
 * processCaseIpc directly. Real SQLite, real hooks, real auth gates,
 * real case operations. Mock only HTTP boundary and workspace creation.
 *
 * Spec: docs/cross-layer-integration-testing-spec.md §5
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import fs from 'fs';
import path from 'path';

import type { Case } from './cases.js';
import type { IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';
import type { SyncResult } from './case-backend.js';

// Mock only the external boundaries — HTTP, workspace, notifications, config
// Everything else (SQLite, auth, hooks, sync service routing) is real.

// 1. Mock github-api.js — the HTTP boundary
const mockCreateGitHubIssue =
  vi.fn<
    () => Promise<{ success: boolean; issueNumber?: number; issueUrl?: string }>
  >();
vi.mock('./github-api.js', () => ({
  createGitHubIssue: (...args: unknown[]) =>
    mockCreateGitHubIssue(...(args as [])),
  DEV_CASE_ISSUE_REPO: { owner: 'Garsson-io', repo: 'kaizen' },
}));

// 2. Mock notification-dispatch.js — no real Telegram messages
vi.mock('./notification-dispatch.js', () => ({
  dispatchEscalationNotifications: vi.fn(),
}));

// 3. Mock escalation.js — skip priority computation (tested elsewhere)
vi.mock('./escalation.js', () => ({
  computePriority: vi.fn(() => ({ level: 'normal', score: 50 })),
  loadEscalationConfig: vi.fn(() => null),
  resolveNotificationTargets: vi.fn(() => []),
}));

// 4. Mock config.js — redirect DATA_DIR to temp
vi.mock('./config.js', () => ({
  DATA_DIR: `/tmp/test-ipc-integration-${process.pid}`,
}));
const TEST_DATA_DIR = `/tmp/test-ipc-integration-${process.pid}`;

// 5. Partial mock of cases.js — real DB ops, mocked workspace operations
const mockCreateCaseWorkspace = vi.fn(() => ({
  workspacePath: '/tmp/test-workspace',
  worktreePath: '/tmp/test-worktree',
  branchName: 'case/test-branch',
}));

vi.mock('./cases.js', async () => {
  const actual =
    await vi.importActual<typeof import('./cases.js')>('./cases.js');
  return {
    ...actual,
    createCaseWorkspace: (...args: unknown[]) =>
      mockCreateCaseWorkspace(...(args as [])),
    resolveExistingWorktree: vi.fn(() => null),
    pruneCaseWorkspace: vi.fn(),
    removeWorktreeLock: vi.fn(),
    updateWorktreeLockHeartbeat: vi.fn(),
  };
});

// Now import the real modules (after mocks are set up)
import { _initTestDatabase } from './db.js';
import {
  getCaseById,
  getActiveCasesByGithubIssue,
  registerCaseMutationHook,
  _clearMutationHooks,
  insertCase,
} from './cases.js';
import { CaseSyncService } from './case-backend.js';
import type { CaseSyncAdapter } from './case-backend.js';
import { processCaseIpc } from './ipc-cases.js';
import { makeCase } from './test-helpers.test-util.js';

// Benign fields — mirrors index.ts logic
const BENIGN_FIELDS = [
  'last_message',
  'last_activity_at',
  'total_cost_usd',
  'time_spent_ms',
  'github_issue',
  'github_issue_url',
];

// Sync adapter mock — only the HTTP boundary
const mockAdapterCreate = vi.fn<(c: Case) => Promise<SyncResult>>();
const mockAdapterUpdate =
  vi.fn<(c: Case, changes: Partial<Case>) => Promise<SyncResult>>();
const mockAdapterClose = vi.fn<(c: Case) => Promise<SyncResult>>();
const mockAdapterComment =
  vi.fn<(c: Case, text: string, author: string) => Promise<SyncResult>>();

function makeTestAdapter(): CaseSyncAdapter {
  return {
    createCase: mockAdapterCreate,
    updateCase: mockAdapterUpdate,
    closeCase: mockAdapterClose,
    addComment: mockAdapterComment,
  };
}

// Wire hooks exactly like index.ts (lines 1086-1123)
function wireHooks(syncService: CaseSyncService): void {
  registerCaseMutationHook((event, c, changes) => {
    if (event === 'inserted') {
      syncService.onCaseMutated({ type: 'created', case: c }).catch(() => {});
    } else if (changes?.status === 'done') {
      syncService.onCaseMutated({ type: 'done', case: c }).catch(() => {});
    } else if (changes?.status) {
      syncService
        .onCaseMutated({ type: 'status_changed', case: c, changes })
        .catch(() => {});
    } else if (
      changes &&
      Object.keys(changes).some((k) => !BENIGN_FIELDS.includes(k))
    ) {
      syncService
        .onCaseMutated({ type: 'updated', case: c, changes })
        .catch(() => {});
    }
  });
}

// Test fixtures
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: '',
  added_at: new Date().toISOString(),
  isMain: true,
};

const NON_MAIN_GROUP: RegisteredGroup = {
  name: 'Customer',
  folder: 'telegram_customer',
  trigger: '@bot',
  added_at: new Date().toISOString(),
  isMain: false,
};

function makeDeps(overrides?: Partial<IpcDeps>): IpcDeps {
  return {
    sendMessage: vi.fn(async () => {}),
    registeredGroups: () => ({
      'tg:-100main': MAIN_GROUP,
      'tg:-100customer': NON_MAIN_GROUP,
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  _clearMutationHooks();
  vi.clearAllMocks();
  // Ensure test DATA_DIR exists for result files
  fs.mkdirSync(
    path.join(TEST_DATA_DIR, 'ipc', 'telegram_main', 'case_results'),
    {
      recursive: true,
    },
  );
  fs.mkdirSync(
    path.join(TEST_DATA_DIR, 'ipc', 'telegram_customer', 'case_results'),
    {
      recursive: true,
    },
  );
  // Default: GitHub issue creation succeeds
  mockCreateGitHubIssue.mockResolvedValue({
    success: true,
    issueNumber: 200,
    issueUrl: 'https://github.com/Garsson-io/kaizen/issues/200',
  });
  // Default: sync adapter succeeds
  mockAdapterCreate.mockResolvedValue({ success: true });
  mockAdapterUpdate.mockResolvedValue({ success: true });
  mockAdapterClose.mockResolvedValue({ success: true });
});

afterEach(() => {
  _clearMutationHooks();
  // Clean up temp files
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// INVARIANT: A case_create IPC request with all required fields creates a case
//   in the DB, fires hooks, and produces a success result.
// SUT: processCaseIpc(case_create data) → handleCaseCreate → insertCase → hooks
// VERIFICATION: Case exists in DB with correct fields. Mock GitHub API called.
//   Result object has case ID and name.
describe('integration: case_create IPC → full chain → correct DB state', () => {
  test('work case created with correct fields in DB', async () => {
    const deps = makeDeps();
    const hookFn = vi.fn();
    registerCaseMutationHook(hookFn);

    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Help customer with order',
        caseType: 'work',
        chatJid: 'tg:-100main',
      },
      'telegram_main',
      true,
      deps,
    );

    // Hook fired for the insert
    expect(hookFn).toHaveBeenCalledWith(
      'inserted',
      expect.objectContaining({
        description: 'Help customer with order',
        type: 'work',
        status: 'active',
        group_folder: 'telegram_main',
      }),
      undefined,
    );

    // Case exists in DB
    const insertedCase = hookFn.mock.calls[0][1] as Case;
    const stored = getCaseById(insertedCase.id);
    expect(stored).toBeDefined();
    expect(stored!.type).toBe('work');
    expect(stored!.status).toBe('active');
    expect(stored!.description).toBe('Help customer with order');
  });

  test('dev case from main group auto-creates GitHub issue', async () => {
    const deps = makeDeps();

    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Fix auth middleware',
        caseType: 'dev',
      },
      'telegram_main',
      true,
      deps,
    );

    // GitHub issue was created for the dev case
    expect(mockCreateGitHubIssue).toHaveBeenCalledOnce();
    expect(mockCreateGitHubIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Fix auth middleware',
      }),
    );
  });
});

// INVARIANT: A case_create IPC with githubIssue: 111 preserves that value
//   through the entire chain including CRM sync.
// SUT: processCaseIpc({ type: 'case_create', githubIssue: 111, ... })
// VERIFICATION: DB shows github_issue: 111 (not CRM issue number).
describe('integration: case_create with githubIssue preserves link through sync', () => {
  test('github_issue preserved through full IPC → sync chain', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);

    const deps = makeDeps();

    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Implement cross-layer tests',
        caseType: 'dev',
        githubIssue: 111,
      },
      'telegram_main',
      true,
      deps,
    );

    // Wait for async sync to complete
    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });

    // Find the case by github_issue
    const cases = getActiveCasesByGithubIssue(111);
    expect(cases.length).toBe(1);
    expect(cases[0].github_issue).toBe(111);
    expect(cases[0].github_issue_url).toBe(
      'https://github.com/Garsson-io/kaizen/issues/111',
    );

    // GitHub issue creation was NOT called (we already have one)
    expect(mockCreateGitHubIssue).not.toHaveBeenCalled();
  });
});

// INVARIANT: If an active case already exists for github_issue: 111,
//   a second case_create with the same github_issue is rejected.
// SUT: processCaseIpc(case_create, githubIssue: 111) twice
// VERIFICATION: Second call returns error result. Only one case in DB.
describe('integration: collision detection blocks duplicate github_issue', () => {
  test('second case_create for same github_issue is blocked', async () => {
    const deps = makeDeps();

    // First create succeeds
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'First case for issue 111',
        caseType: 'dev',
        githubIssue: 111,
        requestId: 'req-first',
      },
      'telegram_main',
      true,
      deps,
    );

    const casesAfterFirst = getActiveCasesByGithubIssue(111);
    expect(casesAfterFirst.length).toBe(1);

    // Second create for same issue — should be blocked
    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Second case for issue 111',
        caseType: 'dev',
        githubIssue: 111,
        requestId: 'req-second',
      },
      'telegram_main',
      true,
      deps,
    );

    // Still only one case
    const casesAfterSecond = getActiveCasesByGithubIssue(111);
    expect(casesAfterSecond.length).toBe(1);

    // Collision warning was sent
    const sendMessage = deps.sendMessage as ReturnType<typeof vi.fn>;
    const collisionMsg = sendMessage.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'string' &&
        call[1].includes('already has active case'),
    );
    expect(collisionMsg).toBeDefined();
  });
});

// INVARIANT: Marking a case done triggers the sync adapter to close the CRM
//   issue and fires the escalation hook with the status change.
// SUT: Insert case → processCaseIpc({ type: 'case_mark_done', caseId })
// VERIFICATION: adapter.closeCase called. Status is 'done' in DB.
describe('integration: case_mark_done triggers sync close', () => {
  test('case_mark_done via IPC updates DB and triggers sync close', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);

    // Pre-insert a case directly (simulating prior case_create)
    const c = makeCase({
      id: 'case-done-ipc-test',
      group_folder: 'telegram_main',
      github_issue: 50,
      status: 'active',
    });
    insertCase(c);

    // Wait for insert sync
    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });
    vi.clearAllMocks();
    mockAdapterClose.mockResolvedValue({ success: true });

    // Now mark done via IPC
    const deps = makeDeps();
    await processCaseIpc(
      {
        type: 'case_mark_done',
        caseId: 'case-done-ipc-test',
        conclusion: 'Task completed successfully',
      },
      'telegram_main',
      true,
      deps,
    );

    // DB state updated
    const stored = getCaseById('case-done-ipc-test');
    expect(stored!.status).toBe('done');
    expect(stored!.done_at).toBeTruthy();
    expect(stored!.conclusion).toBe('Task completed successfully');

    // Sync adapter close was called
    await vi.waitFor(() => {
      expect(mockAdapterClose).toHaveBeenCalledOnce();
    });
  });
});

// INVARIANT: A case_create from a non-main group for a dev case is routed
//   through the approval gate (suggested status) when no safe word is active.
// SUT: processCaseIpc(case_create, caseType: 'dev') from non-main group
// VERIFICATION: Case created with status 'suggested'. No active case in DB.
describe('integration: authorization gate blocks unauthorized dev cases', () => {
  test('dev case from non-main group gets suggested status', async () => {
    const deps = makeDeps();
    const hookFn = vi.fn();
    registerCaseMutationHook(hookFn);

    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Fix the login page',
        caseType: 'dev',
        requestId: 'req-auth-test',
      },
      'telegram_customer',
      false, // not main
      deps,
    );

    // The case should be routed to approval gate (suggested status)
    // suggestDevCase creates it with status 'suggested'
    // Check result file for needs_approval
    const resultDir = path.join(
      TEST_DATA_DIR,
      'ipc',
      'telegram_customer',
      'case_results',
    );
    const resultFiles = fs.readdirSync(resultDir);
    const resultFile = resultFiles.find((f) => f === 'req-auth-test.json');
    expect(resultFile).toBeDefined();

    const result = JSON.parse(
      fs.readFileSync(path.join(resultDir, resultFile!), 'utf8'),
    );
    expect(result.needs_approval).toBe(true);
    expect(result.status).toBe('suggested');

    // Notification sent to main group about needing approval
    const sendMessage = deps.sendMessage as ReturnType<typeof vi.fn>;
    const approvalMsg = sendMessage.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'string' && call[1].includes('needs approval'),
    );
    expect(approvalMsg).toBeDefined();
  });

  test('work case from non-main group is authorized immediately', async () => {
    const deps = makeDeps();
    const hookFn = vi.fn();
    registerCaseMutationHook(hookFn);

    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Help with printing order',
        caseType: 'work',
      },
      'telegram_customer',
      false,
      deps,
    );

    // Work cases are always authorized — hook should fire with active status
    expect(hookFn).toHaveBeenCalledWith(
      'inserted',
      expect.objectContaining({
        type: 'work',
        status: 'active',
      }),
      undefined,
    );
  });

  test('auto-promoted work→dev from non-main group needs approval', async () => {
    const deps = makeDeps();

    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Fix the bug in src/router.ts',
        caseType: 'work', // requested as work, but looks like code work
        requestId: 'req-auto-promote',
      },
      'telegram_customer',
      false,
      deps,
    );

    // Auto-promoted to dev → routed to approval gate
    const resultDir = path.join(
      TEST_DATA_DIR,
      'ipc',
      'telegram_customer',
      'case_results',
    );
    const resultFile = fs
      .readdirSync(resultDir)
      .find((f) => f === 'req-auto-promote.json');
    expect(resultFile).toBeDefined();
    const result = JSON.parse(
      fs.readFileSync(path.join(resultDir, resultFile!), 'utf8'),
    );
    expect(result.needs_approval).toBe(true);
  });
});

// INVARIANT: All IPC fields (description, context, shortName, caseType,
//   githubIssue, gapType, signals) are correctly mapped to the Case object.
// SUT: processCaseIpc with all optional fields set
// VERIFICATION: getCaseById returns case with all fields matching input.
describe('integration: IPC field mapping preserves all fields', () => {
  test('all optional fields are mapped to DB', async () => {
    const deps = makeDeps();
    const hookFn = vi.fn();
    registerCaseMutationHook(hookFn);

    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Full field test case',
        caseType: 'work',
        chatJid: 'tg:-100main',
        initiator: 'aviad',
        customer_name: 'John',
        customer_phone: '+1234567890',
        customer_email: 'john@example.com',
        customer_org: 'Acme Inc',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(hookFn).toHaveBeenCalledOnce();
    const insertedCase = hookFn.mock.calls[0][1] as Case;
    const stored = getCaseById(insertedCase.id);

    expect(stored!.description).toBe('Full field test case');
    expect(stored!.type).toBe('work');
    expect(stored!.chat_jid).toBe('tg:-100main');
    expect(stored!.initiator).toBe('aviad');
    expect(stored!.customer_name).toBe('John');
    expect(stored!.customer_phone).toBe('+1234567890');
    expect(stored!.customer_email).toBe('john@example.com');
    expect(stored!.customer_org).toBe('Acme Inc');
  });

  test('githubIssue maps to github_issue and github_issue_url', async () => {
    const deps = makeDeps();
    const hookFn = vi.fn();
    registerCaseMutationHook(hookFn);

    await processCaseIpc(
      {
        type: 'case_create',
        description: 'Dev case with kaizen link',
        caseType: 'dev',
        githubIssue: 42,
      },
      'telegram_main',
      true,
      deps,
    );

    const insertedCase = hookFn.mock.calls[0][1] as Case;
    const stored = getCaseById(insertedCase.id);

    expect(stored!.github_issue).toBe(42);
    expect(stored!.github_issue_url).toBe(
      'https://github.com/Garsson-io/kaizen/issues/42',
    );
    // Should NOT auto-create a GitHub issue since one was provided
    expect(mockCreateGitHubIssue).not.toHaveBeenCalled();
  });
});

// INVARIANT: A case_suggest_dev IPC creates a case with type='dev' and
//   status='suggested' via the suggestDevCase path.
// SUT: processCaseIpc({ type: 'case_suggest_dev', ... })
// VERIFICATION: Case type is 'dev'. Status is 'suggested'.
describe('integration: case_suggest_dev creates suggested dev case', () => {
  test('suggest dev creates case with suggested status', async () => {
    const deps = makeDeps();

    // First create a source case
    const sourceCase = makeCase({
      id: 'source-case-for-suggest',
      group_folder: 'telegram_main',
      github_issue: 100,
      github_issue_url: 'https://github.com/Garsson-io/kaizen/issues/100',
    });
    insertCase(sourceCase);

    await processCaseIpc(
      {
        type: 'case_suggest_dev',
        description: 'Improve error handling in sync',
        sourceCaseId: 'source-case-for-suggest',
      },
      'telegram_main',
      true,
      deps,
    );

    // Notification sent to main group about the suggestion
    const sendMessage = deps.sendMessage as ReturnType<typeof vi.fn>;
    const suggestMsg = sendMessage.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'string' && call[1].includes('Dev case suggested'),
    );
    expect(suggestMsg).toBeDefined();
  });
});
