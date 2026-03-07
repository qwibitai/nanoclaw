import { describe, expect, it } from 'vitest';

import {
  deriveIssueStatus,
  derivePullRequestStatus,
  extractIssueNumbers,
} from '../scripts/workflow/github-project-sync.js';

describe('extractIssueNumbers', () => {
  it('deduplicates issue references from PR bodies', () => {
    expect(extractIssueNumbers('Fixes #12\nRelated to #12 and #19')).toEqual([12, 19]);
  });
});

describe('deriveIssueStatus', () => {
  it('puts new issues into Backlog', () => {
    expect(
      deriveIssueStatus({
        action: 'opened',
        currentStatus: null,
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 0,
      }),
    ).toBe('Backlog');
  });

  it('marks blocked issues as Blocked', () => {
    expect(
      deriveIssueStatus({
        action: 'labeled',
        currentStatus: 'In Progress',
        issueState: 'OPEN',
        labels: ['status:blocked'],
        assigneeCount: 1,
      }),
    ).toBe('Blocked');
  });

  it('moves unassigned active issues back to Ready', () => {
    expect(
      deriveIssueStatus({
        action: 'unassigned',
        currentStatus: 'In Progress',
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 0,
      }),
    ).toBe('Ready');
  });
});

describe('derivePullRequestStatus', () => {
  it('moves linked issues into Review for open PRs', () => {
    expect(
      derivePullRequestStatus({
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 1,
        pullRequestState: 'OPEN',
        isDraft: false,
        merged: false,
        currentStatus: 'In Progress',
      }),
    ).toBe('Review');
  });

  it('returns merged work to Done', () => {
    expect(
      derivePullRequestStatus({
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 1,
        pullRequestState: 'CLOSED',
        isDraft: false,
        merged: true,
        currentStatus: 'Review',
      }),
    ).toBe('Done');
  });

  it('returns closed unmerged work to Ready when no owner remains', () => {
    expect(
      derivePullRequestStatus({
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 0,
        pullRequestState: 'CLOSED',
        isDraft: false,
        merged: false,
        currentStatus: 'Review',
      }),
    ).toBe('Ready');
  });
});
