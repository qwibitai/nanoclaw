import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from './db.js';
import { insertCase, getCaseById } from './cases.js';
import { makeCase } from './test-helpers.test-util.js';

// Mock dev-session-orchestrator
const mockActivateDevSession = vi.fn();
const mockDeactivateDevSession = vi.fn();
const mockCanStartDevSession = vi.fn();

vi.mock('./dev-session-orchestrator.js', () => ({
  activateDevSession: (...args: unknown[]) => mockActivateDevSession(...args),
  deactivateDevSession: (...args: unknown[]) =>
    mockDeactivateDevSession(...args),
  canStartDevSession: () => mockCanStartDevSession(),
}));

// Mock case-auth
vi.mock('./case-auth.js', () => ({
  authorizeCaseCreation: vi.fn(() => ({
    status: 'authorized',
    caseType: 'dev',
    autoPromoted: false,
    reason: 'test',
  })),
}));

// Mock case-backend
vi.mock('./case-backend.js', () => ({
  getCaseSyncService: vi.fn(() => null),
}));

// Mock github-api
vi.mock('./github-api.js', () => ({
  createGitHubIssue: vi.fn(() =>
    Promise.resolve({ success: false, error: 'test' }),
  ),
  DEV_CASE_ISSUE_REPO: { owner: 'test', repo: 'test' },
}));

// Mock escalation
vi.mock('./escalation.js', () => ({
  computePriority: vi.fn(),
  loadEscalationConfig: vi.fn(() => null),
  resolveNotificationTargets: vi.fn(() => []),
}));

// Mock notification-dispatch
vi.mock('./notification-dispatch.js', () => ({
  dispatchEscalationNotifications: vi.fn(),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

// Mock fs for result writing
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

// Mock ipc-sanitize
vi.mock('./ipc-sanitize.js', () => ({
  sanitizeRequestId: vi.fn((id: string) => id),
}));

import { processCaseIpc } from './ipc-cases.js';
import type { IpcDeps } from './ipc.js';

const mockDeps: IpcDeps = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendPoolMessage: vi.fn().mockResolvedValue(false),
  registeredGroups: vi.fn(() => ({
    'tg:123': {
      name: 'Main',
      folder: 'main',
      trigger: 'test',
      added_at: new Date().toISOString(),
      isMain: true,
    },
  })),
  registerGroup: vi.fn(),
  syncGroups: vi.fn().mockResolvedValue(undefined),
  getAvailableGroups: vi.fn(() => []),
  writeGroupsSnapshot: vi.fn(),
};

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
  mockCanStartDevSession.mockReturnValue({ available: true });
  mockActivateDevSession.mockResolvedValue({
    session: {
      caseId: 'case-1',
      containerName: 'nanoclaw-dev-main-123',
      botName: 'DevAda',
    },
  });
  mockDeactivateDevSession.mockResolvedValue(undefined);
});

// INVARIANT: dev_session_start activates a dev session for an existing dev case.
// SUT: processCaseIpc with type=dev_session_start
// VERIFICATION: activateDevSession is called with the correct case and prompt.
describe('dev_session_start IPC', () => {
  it('starts a dev session for an existing case', async () => {
    const c = makeCase({ id: 'case-dev-1', type: 'dev', group_folder: 'main' });
    insertCase(c);

    const result = await processCaseIpc(
      {
        type: 'dev_session_start',
        caseId: 'case-dev-1',
        initialPrompt: 'Implement the fix',
      },
      'main',
      true,
      mockDeps,
    );

    expect(result).toBe(true);
    expect(mockActivateDevSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'case-dev-1' }),
      'Implement the fix',
      expect.any(Object),
    );
  });

  it('generates default prompt when none provided', async () => {
    const c = makeCase({
      id: 'case-dev-2',
      type: 'dev',
      group_folder: 'main',
      name: 'test-case',
      description: 'Fix the bug',
      github_issue: 42,
    });
    insertCase(c);

    await processCaseIpc(
      { type: 'dev_session_start', caseId: 'case-dev-2' },
      'main',
      true,
      mockDeps,
    );

    expect(mockActivateDevSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Fix the bug'),
      expect.any(Object),
    );
    // Should also include kaizen issue ref
    const prompt = mockActivateDevSession.mock.calls[0][1];
    expect(prompt).toContain('#42');
  });

  it('rejects when caseId is missing', async () => {
    const result = await processCaseIpc(
      { type: 'dev_session_start' },
      'main',
      true,
      mockDeps,
    );

    expect(result).toBe(true); // Handled (even if error)
    expect(mockActivateDevSession).not.toHaveBeenCalled();
  });

  it('rejects when case not found', async () => {
    const result = await processCaseIpc(
      { type: 'dev_session_start', caseId: 'nonexistent' },
      'main',
      true,
      mockDeps,
    );

    expect(result).toBe(true);
    expect(mockActivateDevSession).not.toHaveBeenCalled();
  });

  it('rejects unauthorized non-main group', async () => {
    const c = makeCase({
      id: 'case-dev-3',
      type: 'dev',
      group_folder: 'main',
    });
    insertCase(c);

    await processCaseIpc(
      { type: 'dev_session_start', caseId: 'case-dev-3' },
      'other-group',
      false,
      mockDeps,
    );

    expect(mockActivateDevSession).not.toHaveBeenCalled();
  });

  it('checks availability before starting', async () => {
    mockCanStartDevSession.mockReturnValue({
      available: false,
      reason: 'Bot busy',
    });

    const c = makeCase({ id: 'case-dev-4', type: 'dev', group_folder: 'main' });
    insertCase(c);

    await processCaseIpc(
      { type: 'dev_session_start', caseId: 'case-dev-4' },
      'main',
      true,
      mockDeps,
    );

    expect(mockActivateDevSession).not.toHaveBeenCalled();
  });

  it('writes error result when activation fails', async () => {
    mockActivateDevSession.mockResolvedValue({
      session: null,
      error: 'Docker unavailable',
    });

    const c = makeCase({ id: 'case-dev-5', type: 'dev', group_folder: 'main' });
    insertCase(c);

    const fs = await import('fs');
    await processCaseIpc(
      { type: 'dev_session_start', caseId: 'case-dev-5' },
      'main',
      true,
      mockDeps,
    );

    expect(fs.default.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('activation_failed'),
    );
  });
});

// INVARIANT: dev_session_stop deactivates an active dev session.
// SUT: processCaseIpc with type=dev_session_stop
// VERIFICATION: deactivateDevSession is called with correct caseId and reason.
describe('dev_session_stop IPC', () => {
  it('stops a dev session', async () => {
    const result = await processCaseIpc(
      { type: 'dev_session_stop', caseId: 'case-1', reason: 'admin-request' },
      'main',
      true,
      mockDeps,
    );

    expect(result).toBe(true);
    expect(mockDeactivateDevSession).toHaveBeenCalledWith(
      'case-1',
      'admin-request',
      mockDeps,
    );
  });

  it('uses default reason when none provided', async () => {
    await processCaseIpc(
      { type: 'dev_session_stop', caseId: 'case-1' },
      'main',
      true,
      mockDeps,
    );

    expect(mockDeactivateDevSession).toHaveBeenCalledWith(
      'case-1',
      'manual-stop',
      mockDeps,
    );
  });
});

// INVARIANT: case_mark_done deactivates dev sessions for dev cases.
// SUT: processCaseIpc with type=case_mark_done for a dev case
// VERIFICATION: deactivateDevSession is called with 'case-done' reason.
describe('case_mark_done → dev session deactivation', () => {
  it('deactivates dev session when dev case is marked done', async () => {
    const c = makeCase({
      id: 'case-dev-done-1',
      type: 'dev',
      group_folder: 'main',
      status: 'active',
    });
    insertCase(c);

    await processCaseIpc(
      {
        type: 'case_mark_done',
        caseId: 'case-dev-done-1',
        conclusion: 'PR merged',
      },
      'main',
      true,
      mockDeps,
    );

    expect(mockDeactivateDevSession).toHaveBeenCalledWith(
      'case-dev-done-1',
      'case-done',
      mockDeps,
    );
  });

  it('does NOT deactivate for work cases', async () => {
    const c = makeCase({
      id: 'case-work-done-1',
      type: 'work',
      group_folder: 'main',
      status: 'active',
    });
    insertCase(c);

    await processCaseIpc(
      { type: 'case_mark_done', caseId: 'case-work-done-1' },
      'main',
      true,
      mockDeps,
    );

    expect(mockDeactivateDevSession).not.toHaveBeenCalled();
  });

  it('updates case status to done even if deactivation fails', async () => {
    mockDeactivateDevSession.mockRejectedValue(new Error('cleanup failed'));

    const c = makeCase({
      id: 'case-dev-done-2',
      type: 'dev',
      group_folder: 'main',
      status: 'active',
    });
    insertCase(c);

    await processCaseIpc(
      { type: 'case_mark_done', caseId: 'case-dev-done-2' },
      'main',
      true,
      mockDeps,
    );

    // Case should still be marked done despite deactivation error
    const updated = getCaseById('case-dev-done-2');
    expect(updated?.status).toBe('done');
  });
});

// INVARIANT: case_mark_blocked deactivates dev sessions for dev cases.
// SUT: processCaseIpc with type=case_mark_blocked for a dev case
// VERIFICATION: deactivateDevSession is called with blocked reason.
describe('case_mark_blocked → dev session deactivation', () => {
  it('deactivates dev session when dev case is blocked', async () => {
    const c = makeCase({
      id: 'case-dev-blocked-1',
      type: 'dev',
      group_folder: 'main',
      status: 'active',
    });
    insertCase(c);

    await processCaseIpc(
      {
        type: 'case_mark_blocked',
        caseId: 'case-dev-blocked-1',
        blocked_on: 'tests failing',
      },
      'main',
      true,
      mockDeps,
    );

    expect(mockDeactivateDevSession).toHaveBeenCalledWith(
      'case-dev-blocked-1',
      'blocked: tests failing',
      mockDeps,
    );
  });

  it('does NOT deactivate for work cases', async () => {
    const c = makeCase({
      id: 'case-work-blocked-1',
      type: 'work',
      group_folder: 'main',
      status: 'active',
    });
    insertCase(c);

    await processCaseIpc(
      { type: 'case_mark_blocked', caseId: 'case-work-blocked-1' },
      'main',
      true,
      mockDeps,
    );

    expect(mockDeactivateDevSession).not.toHaveBeenCalled();
  });
});
