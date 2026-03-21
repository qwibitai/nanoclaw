import { describe, it, expect } from 'vitest';
import { classifyCaseMutation } from './case-sync-routing.js';
import type { Case } from './cases.js';

describe('classifyCaseMutation', () => {
  // INVARIANT: classifyCaseMutation maps a case mutation hook event
  // to the appropriate CaseSyncEventType, or null if no sync is needed.
  // This was previously inline in index.ts main(), making it untestable.

  const baseCase: Case = {
    id: 'case-1',
    name: 'test-case',
    type: 'work',
    status: 'active',
    description: 'test',
    created_at: '2026-03-21T12:00:00Z',
    group_folder: 'test',
  } as Case;

  it('returns "created" for inserted events', () => {
    const result = classifyCaseMutation('inserted', baseCase);
    expect(result).toBe('created');
  });

  it('returns "done" when status changes to done', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      status: 'done',
    });
    expect(result).toBe('done');
  });

  it('returns "status_changed" for other status changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      status: 'blocked',
    });
    expect(result).toBe('status_changed');
  });

  it('returns "updated" for meaningful field changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      description: 'new description',
    });
    expect(result).toBe('updated');
  });

  it('returns null for last_message-only changes (noise)', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      last_message: 'some message',
    });
    expect(result).toBeNull();
  });

  it('returns null for last_activity_at-only changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      last_activity_at: '2026-03-21T13:00:00Z',
    });
    expect(result).toBeNull();
  });

  it('returns null for total_cost_usd-only changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      total_cost_usd: 1.5,
    });
    expect(result).toBeNull();
  });

  it('returns null for time_spent_ms-only changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      time_spent_ms: 60000,
    });
    expect(result).toBeNull();
  });

  it('returns null for github_issue-only changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      github_issue: 42,
    } as Partial<Case>);
    expect(result).toBeNull();
  });

  it('returns null for github_issue_url-only changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      github_issue_url: 'https://github.com/org/repo/issues/42',
    } as Partial<Case>);
    expect(result).toBeNull();
  });

  it('returns null when no changes provided for updated event', () => {
    const result = classifyCaseMutation('updated', baseCase);
    expect(result).toBeNull();
  });

  it('returns "updated" when mixed noise + meaningful changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      last_message: 'noise',
      description: 'meaningful',
    });
    expect(result).toBe('updated');
  });

  it('status done takes priority over other changes', () => {
    const result = classifyCaseMutation('updated', baseCase, {
      status: 'done',
      description: 'changed',
    });
    expect(result).toBe('done');
  });
});
