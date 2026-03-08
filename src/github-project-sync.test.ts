import { describe, expect, it } from 'vitest';

import {
  deriveIssueStatus,
  derivePullRequestStatus,
  extractExecutionBoard,
  extractIssueNumbers,
  resolveBoardKey,
} from '../scripts/workflow/github-project-sync.js';

describe('github-project-sync helpers', () => {
  it('extracts linked issue numbers', () => {
    expect(extractIssueNumbers('Fixes #12 and follows up on #14. Duplicate #12 reference.')).toEqual(
      [12, 14],
    );
  });

  it('extracts execution board from issue form body', () => {
    const body = `### Problem Statement\nTest\n\n### Execution Board\nAndy/Jarvis Delivery\n`;
    expect(extractExecutionBoard(body)).toBe('Andy/Jarvis Delivery');
  });

  it('extracts board target from discussion-style body text', () => {
    expect(extractExecutionBoard('Board Target: NanoClaw Platform')).toBe('NanoClaw Platform');
  });

  it('resolves board key for delivery issues', () => {
    expect(resolveBoardKey('Andy/Jarvis Delivery')).toBe('delivery');
  });

  it('defaults unknown board values to platform', () => {
    expect(resolveBoardKey('Something Else')).toBe('platform');
  });

  it('derives issue status transitions', () => {
    expect(
      deriveIssueStatus({
        action: 'opened',
        currentStatus: null,
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 0,
        boardKey: 'platform',
      }),
    ).toBe('Triage');
  });

  it('uses delivery-specific initial issue status', () => {
    expect(
      deriveIssueStatus({
        action: 'opened',
        currentStatus: null,
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 0,
        boardKey: 'delivery',
      }),
    ).toBe('Triage');
  });

  it('derives pull request review status', () => {
    expect(
      derivePullRequestStatus({
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 1,
        pullRequestState: 'OPEN',
        isDraft: false,
        merged: false,
        currentStatus: 'Claude Running',
        boardKey: 'platform',
      }),
    ).toBe('Review Queue');
  });

  it('keeps draft platform pull requests in claude running state', () => {
    expect(
      derivePullRequestStatus({
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 1,
        pullRequestState: 'OPEN',
        isDraft: true,
        merged: false,
        currentStatus: 'Claude Running',
        boardKey: 'platform',
      }),
    ).toBe('Claude Running');
  });

  it('keeps delivery pull requests in review vocabulary', () => {
    expect(
      derivePullRequestStatus({
        issueState: 'OPEN',
        labels: [],
        assigneeCount: 1,
        pullRequestState: 'OPEN',
        isDraft: false,
        merged: false,
        currentStatus: 'Worker Running',
        boardKey: 'delivery',
      }),
    ).toBe('Review');
  });
});
