import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  getStaleActiveCases,
  getCaseById,
  insertCase,
  updateCase,
  removeWorktreeLock,
} from './cases.js';
import { makeCase } from './test-helpers.test-util.js';

beforeEach(() => {
  _initTestDatabase();
});

// INVARIANT: The auto-done reaper in ipc.ts marks stale active cases as done
//   and releases worktree locks. This test exercises the exact composition
//   used in the setInterval callback in startIpcWatcher.
// SUT: getStaleActiveCases → removeWorktreeLock → updateCase (ipc.ts reaper logic)
// VERIFICATION: Create stale active cases, run the reaper composition, verify
//   status transitions and that fresh cases are untouched.
describe('ipc auto-done reaper logic', () => {
  it('marks stale active cases as done with conclusion', () => {
    const threeHoursAgo = new Date(
      Date.now() - 3 * 60 * 60 * 1000,
    ).toISOString();
    insertCase(
      makeCase({
        id: 'reaper-stale',
        status: 'active',
        last_activity_at: threeHoursAgo,
        done_at: null,
        conclusion: null,
      }),
    );

    // Mirror the ipc.ts reaper logic exactly
    const staleCases = getStaleActiveCases(2 * 60 * 60 * 1000);
    for (const c of staleCases) {
      if (c.worktree_path) {
        removeWorktreeLock(c.worktree_path);
      }
      updateCase(c.id, {
        status: 'done',
        done_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        conclusion:
          'Auto-completed: no activity for 2+ hours without calling case_mark_done',
      });
    }

    const updated = getCaseById('reaper-stale');
    expect(updated!.status).toBe('done');
    expect(updated!.done_at).toBeTruthy();
    expect(updated!.conclusion).toContain('Auto-completed');
  });

  it('leaves fresh active cases untouched', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    insertCase(
      makeCase({
        id: 'reaper-fresh',
        status: 'active',
        last_activity_at: fiveMinAgo,
      }),
    );

    const staleCases = getStaleActiveCases(2 * 60 * 60 * 1000);
    expect(staleCases).toHaveLength(0);

    const unchanged = getCaseById('reaper-fresh');
    expect(unchanged!.status).toBe('active');
  });

  it('processes multiple stale cases in one sweep', () => {
    const threeHoursAgo = new Date(
      Date.now() - 3 * 60 * 60 * 1000,
    ).toISOString();
    const fourHoursAgo = new Date(
      Date.now() - 4 * 60 * 60 * 1000,
    ).toISOString();

    insertCase(
      makeCase({
        id: 'reaper-a',
        status: 'active',
        last_activity_at: threeHoursAgo,
      }),
    );
    insertCase(
      makeCase({
        id: 'reaper-b',
        status: 'active',
        last_activity_at: fourHoursAgo,
      }),
    );

    const staleCases = getStaleActiveCases(2 * 60 * 60 * 1000);
    expect(staleCases).toHaveLength(2);

    for (const c of staleCases) {
      updateCase(c.id, {
        status: 'done',
        done_at: new Date().toISOString(),
        conclusion: 'Auto-completed',
      });
    }

    expect(getCaseById('reaper-a')!.status).toBe('done');
    expect(getCaseById('reaper-b')!.status).toBe('done');
    expect(getStaleActiveCases(2 * 60 * 60 * 1000)).toHaveLength(0);
  });
});
