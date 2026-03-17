import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  insertCase,
  getCaseById,
  getActiveCasesByGithubIssue,
  updateCase,
  formatCaseStatus,
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
});

// INVARIANT: getActiveCasesByGithubIssue returns only active/backlog/blocked/suggested
//   cases matching the issue number, never done/reviewed/pruned cases.
// SUT: getActiveCasesByGithubIssue
// VERIFICATION: Insert cases with various statuses linked to the same issue,
//   confirm only non-terminal statuses are returned.
describe('getActiveCasesByGithubIssue', () => {
  it('returns active cases matching the issue number', () => {
    insertCase(makeCase({ id: 'active-16', status: 'active', github_issue: 16 }));
    insertCase(makeCase({ id: 'backlog-16', status: 'backlog', github_issue: 16 }));

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(2);
    expect(results.map((c) => c.id).sort()).toEqual(['active-16', 'backlog-16']);
  });

  it('excludes done/reviewed/pruned cases', () => {
    insertCase(makeCase({ id: 'done-16', status: 'done', github_issue: 16 }));
    insertCase(makeCase({ id: 'reviewed-16', status: 'reviewed', github_issue: 16 }));
    insertCase(makeCase({ id: 'pruned-16', status: 'pruned', github_issue: 16 }));

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(0);
  });

  it('includes suggested and blocked cases', () => {
    insertCase(makeCase({ id: 'suggested-16', status: 'suggested', github_issue: 16 }));
    insertCase(makeCase({ id: 'blocked-16', status: 'blocked', github_issue: 16 }));

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(2);
  });

  it('does not return cases linked to a different issue', () => {
    insertCase(makeCase({ id: 'other-issue', status: 'active', github_issue: 99 }));
    insertCase(makeCase({ id: 'no-issue', status: 'active', github_issue: null }));

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no cases exist', () => {
    const results = getActiveCasesByGithubIssue(999);
    expect(results).toHaveLength(0);
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
});
