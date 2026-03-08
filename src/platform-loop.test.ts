import { describe, expect, it } from 'vitest';

import {
  buildPlatformBranchName,
  buildPlatformRunContext,
  missingPlatformSections,
  selectPlatformCandidate,
} from '../scripts/workflow/platform-loop.js';

describe('platform-loop helpers', () => {
  it('builds stable branch names', () => {
    expect(buildPlatformBranchName(42, 'Claude /loop adoption for platform')).toBe(
      'claude-platform-42-claude-loop-adoption-for-platform',
    );
  });

  it('builds request and run ids', () => {
    const context = buildPlatformRunContext(
      12,
      'Loop over another command',
      new Date('2026-03-08T10:20:30.000Z'),
    );

    expect(context).toEqual({
      requestId: 'platform-issue-12-20260308t102030z',
      runId: 'claude-platform-12-20260308t102030z',
      branch: 'claude-platform-12-loop-over-another-command',
    });
  });

  it('detects missing required platform sections', () => {
    expect(
      missingPlatformSections(
        '### Problem Statement\nX\n\n### Scope\nY\n\n### Acceptance Criteria\nZ\n',
      ),
    ).toEqual([
      'Expected Productivity Gain',
      'Required Checks',
      'Required Evidence',
      'Blocked If',
    ]);
  });

  it('prefers review queue blocks before picking new work', () => {
    const result = selectPlatformCandidate([
      {
        number: 10,
        state: 'OPEN',
        status: 'Review Queue',
        priority: 'p1',
        labels: [],
        missingSections: [],
      },
      {
        number: 11,
        state: 'OPEN',
        status: 'Ready for Dispatch',
        priority: 'p0',
        labels: [],
        missingSections: [],
      },
    ]);

    expect(result).toEqual({
      action: 'noop',
      reason: 'review_queue_present',
      blockingIssueNumbers: [10],
    });
  });

  it('picks the highest-priority ready issue with full readiness sections', () => {
    const result = selectPlatformCandidate([
      {
        number: 22,
        title: 'Lower priority item',
        url: 'https://example.com/22',
        state: 'OPEN',
        status: 'Ready for Dispatch',
        priority: 'p2',
        labels: [],
        missingSections: [],
        requestId: '',
        runId: '',
        nextDecision: '',
      },
      {
        number: 21,
        title: 'Adopt /loop over another command',
        url: 'https://example.com/21',
        state: 'OPEN',
        status: 'Ready for Dispatch',
        priority: 'p0',
        labels: [],
        missingSections: [],
        requestId: '',
        runId: '',
        nextDecision: '',
      },
    ]);

    expect(result).toEqual({
      action: 'pickup',
      issue: {
        number: 21,
        title: 'Adopt /loop over another command',
        url: 'https://example.com/21',
        status: 'Ready for Dispatch',
        priority: 'p0',
        labels: [],
        missingSections: [],
        requestId: '',
        runId: '',
        nextDecision: '',
        branch: 'claude-platform-21-adopt-loop-over-another-command',
      },
    });
  });
});
