import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  insertCase,
  getCaseById,
  getActiveCasesByGithubIssue,
  getStaleActiveCases,
  updateCase,
  formatCaseStatus,
  generateCaseName,
} from './cases.js';
import { makeCase } from './test-helpers.js';

beforeEach(() => {
  _initTestDatabase();
});

// INVARIANT: Cases with a github_issue store and retrieve the value correctly.
// SUT: insertCase + getCaseById round-trip
// VERIFICATION: Insert a case with github_issue set, retrieve it, confirm the value matches.
describe('github_issue storage', () => {
  it('stores and retrieves github_issue when set', () => {
    const c = makeCase({ id: 'case-gh-1', github_issue: 16 });
    insertCase(c);

    const retrieved = getCaseById('case-gh-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.github_issue).toBe(16);
  });

  it('stores and retrieves github_issue as null when not set', () => {
    const c = makeCase({ id: 'case-gh-2', github_issue: null });
    insertCase(c);

    const retrieved = getCaseById('case-gh-2');
    expect(retrieved).toBeDefined();
    expect(retrieved!.github_issue).toBeNull();
  });

  it('updates github_issue via updateCase', () => {
    const c = makeCase({ id: 'case-gh-3', github_issue: null });
    insertCase(c);

    updateCase('case-gh-3', { github_issue: 42 });
    const retrieved = getCaseById('case-gh-3');
    expect(retrieved!.github_issue).toBe(42);
  });

  it('updates priority and gap_type via updateCase', () => {
    const c = makeCase({ id: 'case-esc-1', priority: null, gap_type: null });
    insertCase(c);

    updateCase('case-esc-1', {
      priority: 'critical',
      gap_type: 'capability_expected',
    });
    const retrieved = getCaseById('case-esc-1');
    expect(retrieved!.priority).toBe('critical');
    expect(retrieved!.gap_type).toBe('capability_expected');
  });

  it('sets needs_input status on a case', () => {
    const c = makeCase({ id: 'case-esc-2', status: 'active' });
    insertCase(c);

    updateCase('case-esc-2', { status: 'needs_input' });
    const retrieved = getCaseById('case-esc-2');
    expect(retrieved!.status).toBe('needs_input');
  });

  it('sets needs_approval status on a case', () => {
    const c = makeCase({ id: 'case-esc-3', status: 'suggested' });
    insertCase(c);

    updateCase('case-esc-3', { status: 'needs_approval' });
    const retrieved = getCaseById('case-esc-3');
    expect(retrieved!.status).toBe('needs_approval');
  });
});

// INVARIANT: getActiveCasesByGithubIssue returns only active/backlog/blocked/suggested
//   cases matching the issue number, never done/reviewed/pruned cases.
// SUT: getActiveCasesByGithubIssue
// VERIFICATION: Insert cases with various statuses linked to the same issue,
//   confirm only non-terminal statuses are returned.
describe('getActiveCasesByGithubIssue', () => {
  it('returns active cases matching the issue number', () => {
    insertCase(
      makeCase({ id: 'active-16', status: 'active', github_issue: 16 }),
    );
    insertCase(
      makeCase({ id: 'backlog-16', status: 'backlog', github_issue: 16 }),
    );

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(2);
    expect(results.map((c) => c.id).sort()).toEqual([
      'active-16',
      'backlog-16',
    ]);
  });

  it('excludes done/reviewed/pruned cases', () => {
    insertCase(makeCase({ id: 'done-16', status: 'done', github_issue: 16 }));
    insertCase(
      makeCase({ id: 'reviewed-16', status: 'reviewed', github_issue: 16 }),
    );
    insertCase(
      makeCase({ id: 'pruned-16', status: 'pruned', github_issue: 16 }),
    );

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(0);
  });

  it('includes suggested and blocked cases', () => {
    insertCase(
      makeCase({ id: 'suggested-16', status: 'suggested', github_issue: 16 }),
    );
    insertCase(
      makeCase({ id: 'blocked-16', status: 'blocked', github_issue: 16 }),
    );

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(2);
  });

  it('does not return cases linked to a different issue', () => {
    insertCase(
      makeCase({ id: 'other-issue', status: 'active', github_issue: 99 }),
    );
    insertCase(
      makeCase({ id: 'no-issue', status: 'active', github_issue: null }),
    );

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no cases exist', () => {
    const results = getActiveCasesByGithubIssue(999);
    expect(results).toHaveLength(0);
  });
});

// INVARIANT: getStaleActiveCases returns only active cases whose last_activity_at
//   is older than the specified threshold, excluding done/blocked/other statuses.
// SUT: getStaleActiveCases
// VERIFICATION: Insert active cases with varying activity timestamps and non-active
//   cases, confirm only stale active cases are returned.
describe('getStaleActiveCases', () => {
  it('returns active cases idle longer than threshold', () => {
    const threeHoursAgo = new Date(
      Date.now() - 3 * 60 * 60 * 1000,
    ).toISOString();
    insertCase(
      makeCase({
        id: 'stale-active',
        status: 'active',
        last_activity_at: threeHoursAgo,
      }),
    );

    const results = getStaleActiveCases(2 * 60 * 60 * 1000);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('stale-active');
  });

  it('excludes active cases with recent activity', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    insertCase(
      makeCase({
        id: 'fresh-active',
        status: 'active',
        last_activity_at: fiveMinAgo,
      }),
    );

    const results = getStaleActiveCases(2 * 60 * 60 * 1000);
    expect(results).toHaveLength(0);
  });

  it('excludes done/blocked cases even if stale', () => {
    const threeHoursAgo = new Date(
      Date.now() - 3 * 60 * 60 * 1000,
    ).toISOString();
    insertCase(
      makeCase({
        id: 'stale-done',
        status: 'done',
        last_activity_at: threeHoursAgo,
      }),
    );
    insertCase(
      makeCase({
        id: 'stale-blocked',
        status: 'blocked',
        last_activity_at: threeHoursAgo,
      }),
    );

    const results = getStaleActiveCases(2 * 60 * 60 * 1000);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no cases exist', () => {
    const results = getStaleActiveCases(1000);
    expect(results).toHaveLength(0);
  });
});

// INVARIANT: The auto-done reaper workflow (getStaleActiveCases → updateCase) correctly
//   transitions stale active cases to done status with a conclusion and timestamp.
// SUT: getStaleActiveCases + updateCase composition (mirrors ipc.ts auto-done reaper)
// VERIFICATION: Insert a stale active case, run the reaper logic, confirm status
//   transitions to done with appropriate fields set.
describe('auto-done reaper workflow', () => {
  it('transitions stale active case to done with conclusion', () => {
    const threeHoursAgo = new Date(
      Date.now() - 3 * 60 * 60 * 1000,
    ).toISOString();
    insertCase(
      makeCase({
        id: 'reaper-target',
        status: 'active',
        last_activity_at: threeHoursAgo,
        done_at: null,
        conclusion: null,
      }),
    );

    // Run the same logic as the ipc.ts auto-done reaper
    const staleCases = getStaleActiveCases(2 * 60 * 60 * 1000);
    expect(staleCases).toHaveLength(1);

    for (const c of staleCases) {
      updateCase(c.id, {
        status: 'done',
        done_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        conclusion:
          'Auto-completed: no activity for 2+ hours without calling case_mark_done',
      });
    }

    const updated = getCaseById('reaper-target');
    expect(updated!.status).toBe('done');
    expect(updated!.done_at).toBeTruthy();
    expect(updated!.conclusion).toContain('Auto-completed');

    // Should no longer appear in stale active list
    const remaining = getStaleActiveCases(2 * 60 * 60 * 1000);
    expect(remaining).toHaveLength(0);
  });

  it('does not touch fresh active cases', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    insertCase(
      makeCase({
        id: 'fresh-case',
        status: 'active',
        last_activity_at: fiveMinAgo,
      }),
    );

    const staleCases = getStaleActiveCases(2 * 60 * 60 * 1000);
    expect(staleCases).toHaveLength(0);

    const unchanged = getCaseById('fresh-case');
    expect(unchanged!.status).toBe('active');
  });
});

// INVARIANT: formatCaseStatus includes [kaizen #N] when github_issue is set,
//   and omits it when null.
// SUT: formatCaseStatus
// VERIFICATION: Format cases with and without github_issue, check output string.
describe('formatCaseStatus with github_issue', () => {
  it('includes kaizen issue reference when set', () => {
    const c = makeCase({ github_issue: 16 });
    const output = formatCaseStatus(c);
    expect(output).toContain('[kaizen #16]');
  });

  it('omits kaizen issue reference when null', () => {
    const c = makeCase({ github_issue: null });
    const output = formatCaseStatus(c);
    expect(output).not.toContain('[kaizen');
  });
});

// INVARIANT: Schema migration adds github_issue column to existing tables
//   without error, and calling createCasesSchema twice does not fail.
// SUT: createCasesSchema (migration path)
// VERIFICATION: _initTestDatabase calls createCasesSchema — calling it again
//   should not throw (migration is idempotent).
describe('schema migration idempotency', () => {
  it('calling _initTestDatabase twice does not throw', () => {
    expect(() => _initTestDatabase()).not.toThrow();
    expect(() => _initTestDatabase()).not.toThrow();
  });

  it('cases inserted after double-init have github_issue', () => {
    _initTestDatabase();
    const c = makeCase({ id: 'post-migrate', github_issue: 7 });
    insertCase(c);

    const retrieved = getCaseById('post-migrate');
    expect(retrieved!.github_issue).toBe(7);
  });

  it('cases inserted after migration have priority and gap_type', () => {
    _initTestDatabase();
    const c = makeCase({
      id: 'post-migrate-esc',
      priority: 'high',
      gap_type: 'information_expected',
    });
    insertCase(c);

    const retrieved = getCaseById('post-migrate-esc');
    expect(retrieved!.priority).toBe('high');
    expect(retrieved!.gap_type).toBe('information_expected');
  });

  it('priority and gap_type default to null', () => {
    _initTestDatabase();
    const c = makeCase({ id: 'post-migrate-null' });
    insertCase(c);

    const retrieved = getCaseById('post-migrate-null');
    expect(retrieved!.priority).toBeNull();
    expect(retrieved!.gap_type).toBeNull();
  });
});

// INVARIANT: generateCaseName produces a date-prefixed slug, preferring shortName over description.
// SUT: generateCaseName
// VERIFICATION: Check slug format with and without shortName, and verify truncation.
describe('generateCaseName', () => {
  it('uses description when no shortName provided', () => {
    const name = generateCaseName('Convert photo to CMYK');
    expect(name).toMatch(/^\d{6}-\d{4}-convert-photo-to-cmyk$/);
  });

  it('prefers shortName over description', () => {
    const name = generateCaseName(
      'Convert photo 134.jpg to CMYK for printing at Demarco shop',
      'Demarco T. CMYK Magnificent',
    );
    expect(name).toMatch(/^\d{6}-\d{4}-demarco-t-cmyk-magnificent$/);
  });

  it('truncates slug to 30 characters', () => {
    const name = generateCaseName(
      'This is an extremely long description that should be truncated to fit',
    );
    const slug = name.replace(/^\d{6}-\d{4}-/, '');
    expect(slug.length).toBeLessThanOrEqual(30);
  });

  it('strips special characters from slug', () => {
    const name = generateCaseName('Sarah K. Logo! @#$% Sparkly!!!');
    expect(name).toMatch(/^\d{6}-\d{4}-sarah-k-logo-sparkly$/);
  });
});
