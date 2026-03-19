import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import type { Case } from './cases.js';
import {
  insertCase,
  getCaseById,
  updateCase,
  registerCaseMutationHook,
  _clearMutationHooks,
} from './cases.js';
import { CaseSyncService } from './case-backend.js';
import type { CaseSyncAdapter, SyncResult } from './case-backend.js';
import { onCaseEscalationEvent } from './escalation-hook.js';
import { logger } from './logger.js';
import { makeCase } from './test-helpers.test-util.js';

// Mock only the external HTTP boundary — GitHub API calls.
// Everything else (SQLite, mutation hooks, sync service) is real.
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

// Benign fields that do NOT trigger a sync call — mirrors index.ts logic exactly
const BENIGN_FIELDS = [
  'last_message',
  'last_activity_at',
  'total_cost_usd',
  'time_spent_ms',
  'github_issue',
  'github_issue_url',
];

// Wire up the mutation hook → sync chain exactly like index.ts does (lines 1086-1113)
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

beforeEach(() => {
  _initTestDatabase();
  _clearMutationHooks();
  vi.clearAllMocks();
});

afterEach(() => {
  _clearMutationHooks();
});

// INVARIANT: When a case is inserted with a pre-existing github_issue (kaizen link),
//   the sync backend must NOT overwrite it with the CRM issue number.
// SUT: Full chain — insertCase → mutation hook → CaseSyncService → adapter → DB state
// VERIFICATION: After sync completes, getCaseById returns the original github_issue.
describe('integration: insertCase → sync preserves github_issue', () => {
  test('sync does not overwrite pre-existing github_issue (kaizen #120)', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);

    // Adapter.createCase simulates what GitHubCaseSyncAdapter does:
    // creates a CRM issue and returns success. The adapter's createCase
    // is what we're testing indirectly — the real GitHubCaseSyncAdapter
    // would call updateCase here to store the CRM link.
    mockAdapterCreate.mockResolvedValue({
      success: true,
      issueNumber: 10,
    });

    // Insert case with pre-existing kaizen issue link
    const c = makeCase({
      id: 'case-integration-k120',
      github_issue: 111,
      github_issue_url: 'https://github.com/Garsson-io/kaizen/issues/111',
    });
    insertCase(c);

    // Wait for async sync to complete
    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });

    // Verify DB state — github_issue must still be 111, not 10
    const stored = getCaseById('case-integration-k120');
    expect(stored).toBeDefined();
    expect(stored!.github_issue).toBe(111);
    expect(stored!.github_issue_url).toBe(
      'https://github.com/Garsson-io/kaizen/issues/111',
    );
  });

  test('sync sets github_issue when not previously set', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);

    // Adapter creates CRM issue and stores the link back
    mockAdapterCreate.mockImplementation(async (caseObj: Case) => {
      updateCase(caseObj.id, {
        github_issue: 42,
        github_issue_url: 'https://github.com/Garsson-io/prints-demo/issues/42',
      });
      return { success: true, issueNumber: 42 };
    });

    const c = makeCase({
      id: 'case-integration-no-issue',
      github_issue: null,
      github_issue_url: null,
    });
    insertCase(c);

    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });

    const stored = getCaseById('case-integration-no-issue');
    expect(stored).toBeDefined();
    expect(stored!.github_issue).toBe(42);
    expect(stored!.github_issue_url).toBe(
      'https://github.com/Garsson-io/prints-demo/issues/42',
    );
  });

  test('mutation hook fires on insertCase', async () => {
    const hookFn = vi.fn();
    registerCaseMutationHook(hookFn);

    const c = makeCase({ id: 'case-hook-fire-test' });
    insertCase(c);

    expect(hookFn).toHaveBeenCalledOnce();
    expect(hookFn).toHaveBeenCalledWith(
      'inserted',
      expect.objectContaining({ id: 'case-hook-fire-test' }),
      undefined,
    );
  });

  test('mutation hook fires on updateCase with changes', async () => {
    const hookFn = vi.fn();
    const c = makeCase({ id: 'case-hook-update-test' });
    insertCase(c);

    // Register hook after insert to only capture updates
    _clearMutationHooks();
    registerCaseMutationHook(hookFn);

    updateCase('case-hook-update-test', {
      status: 'done',
      done_at: new Date().toISOString(),
    });

    expect(hookFn).toHaveBeenCalledOnce();
    expect(hookFn).toHaveBeenCalledWith(
      'updated',
      expect.objectContaining({ id: 'case-hook-update-test', status: 'done' }),
      expect.objectContaining({ status: 'done' }),
    );
  });

  test('sync service routes done status to adapter.closeCase', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);

    mockAdapterCreate.mockResolvedValue({ success: true });
    mockAdapterClose.mockResolvedValue({ success: true });

    const c = makeCase({
      id: 'case-done-route',
      github_issue: 50,
    });
    insertCase(c);

    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });

    // Now mark done — should trigger adapter.closeCase
    updateCase('case-done-route', {
      status: 'done',
      done_at: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(mockAdapterClose).toHaveBeenCalledOnce();
    });
  });
});

// INVARIANT: The escalation hook fires through the real mutation chain when cases
//   with escalation data (priority + gap_type) are inserted or updated.
// SUT: Full chain — insertCase/updateCase → fireMutationHooks → onCaseEscalationEvent → logger
// VERIFICATION: logger.info is called with the correct escalation fields after real DB mutations.
describe('integration: escalation hook fires through mutation chain', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(logger, 'info');
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('escalation hook logs on insert with priority and gap_type', () => {
    registerCaseMutationHook(onCaseEscalationEvent);

    const c = makeCase({
      id: 'case-esc-insert',
      name: 'test-escalation-insert',
      priority: 'high',
      gap_type: 'information_expected',
    });
    insertCase(c);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: 'case-esc-insert',
        name: 'test-escalation-insert',
        priority: 'high',
        gapType: 'information_expected',
      }),
      'Case with escalation data inserted',
    );
  });

  test('escalation hook does not log on insert without escalation data', () => {
    registerCaseMutationHook(onCaseEscalationEvent);

    const c = makeCase({
      id: 'case-esc-no-data',
      priority: null,
      gap_type: null,
    });
    insertCase(c);

    expect(logSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      'Case with escalation data inserted',
    );
  });

  test('escalation hook logs on priority update', () => {
    const c = makeCase({
      id: 'case-esc-update',
      name: 'test-escalation-update',
      priority: 'normal',
      gap_type: 'information_expected',
    });
    insertCase(c);

    _clearMutationHooks();
    logSpy.mockClear();
    registerCaseMutationHook(onCaseEscalationEvent);

    updateCase('case-esc-update', { priority: 'critical' });

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: 'case-esc-update',
        name: 'test-escalation-update',
        newPriority: 'critical',
      }),
      'Case escalation priority updated',
    );
  });

  test('escalation hook does not log on non-priority update', () => {
    const c = makeCase({
      id: 'case-esc-status-only',
      priority: 'high',
      gap_type: 'information_expected',
    });
    insertCase(c);

    _clearMutationHooks();
    logSpy.mockClear();
    registerCaseMutationHook(onCaseEscalationEvent);

    updateCase('case-esc-status-only', {
      status: 'done',
      done_at: new Date().toISOString(),
    });

    expect(logSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      'Case escalation priority updated',
    );
  });
});

// INVARIANT: Both sync and escalation hooks can be registered simultaneously and
//   fire independently on the same mutation event without interference.
// SUT: Full chain — insertCase → fireMutationHooks → [sync hook, escalation hook]
// VERIFICATION: Both hooks produce their expected side effects on the same insert.
describe('integration: sync + escalation hooks coexist without interference', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(logger, 'info');
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('both hooks fire on insert — sync calls adapter, escalation logs', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);
    registerCaseMutationHook(onCaseEscalationEvent);

    mockAdapterCreate.mockResolvedValue({ success: true });

    const c = makeCase({
      id: 'case-both-hooks',
      name: 'test-both-hooks',
      priority: 'high',
      gap_type: 'information_expected',
      github_issue: 99,
    });
    insertCase(c);

    // Sync hook fired — adapter was called
    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });

    // Escalation hook fired — logger was called
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: 'case-both-hooks',
        priority: 'high',
        gapType: 'information_expected',
      }),
      'Case with escalation data inserted',
    );

    // DB state is consistent — github_issue preserved
    const stored = getCaseById('case-both-hooks');
    expect(stored).toBeDefined();
    expect(stored!.github_issue).toBe(99);
  });

  test('escalation hook failure does not block sync hook', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);

    // Register a broken escalation hook first
    registerCaseMutationHook(() => {
      throw new Error('escalation hook crashed');
    });
    // Then register sync hook — it should still fire despite prior hook failure
    wireHooks(syncService);

    mockAdapterCreate.mockResolvedValue({ success: true });

    const c = makeCase({ id: 'case-hook-crash' });
    insertCase(c);

    // Sync hook still fires despite the earlier hook throwing
    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });
  });
});

// INVARIANT: When sync calls updateCase with github_issue/github_issue_url (benign fields),
//   the re-fired mutation hook does NOT trigger another sync call.
// SUT: insertCase → sync hook → adapter.createCase → updateCase({github_issue}) → hook filter
// VERIFICATION: createGitHubIssue-equivalent called exactly once (no recursive loop).
describe('integration: sync loop prevention — benign field filter', () => {
  test('sync-originated github_issue update does not trigger recursive sync', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);

    // Adapter simulates real GitHubCaseSyncAdapter: creates CRM issue,
    // then calls updateCase to store the link back
    mockAdapterCreate.mockImplementation(async (caseObj: Case) => {
      updateCase(caseObj.id, {
        github_issue: 77,
        github_issue_url: 'https://github.com/example/repo/issues/77',
      });
      return { success: true, issueNumber: 77 };
    });

    const c = makeCase({ id: 'case-loop-test', github_issue: null });
    insertCase(c);

    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });

    // The key invariant: adapter.createCase was called exactly once.
    // If the benign field filter wasn't working, the updateCase({github_issue})
    // would re-trigger the sync hook, causing a second adapter call.
    expect(mockAdapterCreate).toHaveBeenCalledTimes(1);
    expect(mockAdapterUpdate).not.toHaveBeenCalled();
  });

  test('benign field updates (last_message, costs, time) do not trigger sync', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);

    mockAdapterCreate.mockResolvedValue({ success: true });

    const c = makeCase({ id: 'case-benign-test' });
    insertCase(c);

    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });

    // Clear mocks to isolate the update calls
    vi.clearAllMocks();

    // Update with benign-only fields — none should trigger sync
    updateCase('case-benign-test', { last_message: 'hello' });
    updateCase('case-benign-test', {
      last_activity_at: new Date().toISOString(),
    });
    updateCase('case-benign-test', { total_cost_usd: 1.5 });
    updateCase('case-benign-test', { time_spent_ms: 30000 });

    // Give async hooks a tick to fire (they shouldn't)
    await new Promise((r) => setTimeout(r, 50));

    expect(mockAdapterCreate).not.toHaveBeenCalled();
    expect(mockAdapterUpdate).not.toHaveBeenCalled();
    expect(mockAdapterClose).not.toHaveBeenCalled();
  });

  test('non-benign field update triggers sync', async () => {
    const adapter = makeTestAdapter();
    const syncService = new CaseSyncService(adapter);
    wireHooks(syncService);

    mockAdapterCreate.mockResolvedValue({ success: true });
    mockAdapterUpdate.mockResolvedValue({ success: true });

    const c = makeCase({ id: 'case-nonbenign-test' });
    insertCase(c);

    await vi.waitFor(() => {
      expect(mockAdapterCreate).toHaveBeenCalledOnce();
    });

    vi.clearAllMocks();

    // Update description — a non-benign field — should trigger sync
    updateCase('case-nonbenign-test', { description: 'updated description' });

    await vi.waitFor(() => {
      expect(mockAdapterUpdate).toHaveBeenCalledOnce();
    });
  });
});

// INVARIANT: All registered mutation hooks fire in registration order,
//   regardless of individual hook behavior.
// SUT: registerCaseMutationHook(hook1), registerCaseMutationHook(hook2) → insertCase
// VERIFICATION: hook1 called before hook2, both called.
describe('integration: hooks fire in registration order', () => {
  test('hooks fire in the order they were registered', () => {
    const callOrder: string[] = [];

    registerCaseMutationHook(() => callOrder.push('first'));
    registerCaseMutationHook(() => callOrder.push('second'));
    registerCaseMutationHook(() => callOrder.push('third'));

    const c = makeCase({ id: 'case-order-test' });
    insertCase(c);

    expect(callOrder).toEqual(['first', 'second', 'third']);
  });

  test('registration order preserved even when earlier hooks throw', () => {
    const callOrder: string[] = [];

    registerCaseMutationHook(() => callOrder.push('first'));
    registerCaseMutationHook(() => {
      callOrder.push('second-throws');
      throw new Error('boom');
    });
    registerCaseMutationHook(() => callOrder.push('third'));

    const c = makeCase({ id: 'case-order-throw-test' });
    insertCase(c);

    expect(callOrder).toEqual(['first', 'second-throws', 'third']);
  });
});
