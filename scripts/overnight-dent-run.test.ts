/**
 * Tests for overnight-dent-run stream-json parsing, stop signal detection,
 * and post-run hygiene (labeling, auto-merge, batch progress issue).
 *
 * INVARIANT: extractArtifacts must find all PR URLs, issue URLs, closed issues,
 * and case names in text without false positives. checkStopSignal must detect
 * the OVERNIGHT_STOP marker and extract the reason.
 *
 * INVARIANT: Post-run hygiene functions must call gh CLI with correct repo/number
 * arguments, and must not throw on failure (advisory-only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractArtifacts,
  checkStopSignal,
  formatToolUse,
  processStreamMessage,
  labelArtifacts,
  queueAutoMerge,
  ensureBatchProgressIssue,
  updateBatchProgressIssue,
  closeBatchProgressIssue,
  buildPrompt,
  checkMergeStatus,
  type RunResult,
  type BatchState,
} from './overnight-dent-run.js';

function emptyResult(): RunResult {
  return {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
  };
}

describe('extractArtifacts', () => {
  it('extracts PR URLs', () => {
    const r = emptyResult();
    extractArtifacts(
      'Created https://github.com/Garsson-io/nanoclaw/pull/234 for the fix',
      r,
    );
    expect(r.prs).toEqual(['https://github.com/Garsson-io/nanoclaw/pull/234']);
  });

  it('extracts issue URLs', () => {
    const r = emptyResult();
    extractArtifacts(
      'Filed https://github.com/Garsson-io/kaizen/issues/267',
      r,
    );
    expect(r.issuesFiled).toEqual([
      'https://github.com/Garsson-io/kaizen/issues/267',
    ]);
  });

  it('extracts closed issue references', () => {
    const r = emptyResult();
    extractArtifacts('Closes #251, fixes #253, Resolves #258', r);
    expect(r.issuesClosed).toEqual(['#251', '#253', '#258']);
  });

  it('extracts case names', () => {
    const r = emptyResult();
    extractArtifacts('case: 260315-1430-fix-auth', r);
    expect(r.cases).toEqual(['260315-1430-fix-auth']);
  });

  it('deduplicates artifacts', () => {
    const r = emptyResult();
    extractArtifacts('PR: https://github.com/Garsson-io/nanoclaw/pull/234', r);
    extractArtifacts(
      'Same PR: https://github.com/Garsson-io/nanoclaw/pull/234',
      r,
    );
    expect(r.prs).toHaveLength(1);
  });

  it('extracts kaizen issue references from PR titles (kaizen #299)', () => {
    const r = emptyResult();
    extractArtifacts(
      'fix: eliminate waived disposition (kaizen #198) (#258)',
      r,
    );
    expect(r.issuesClosed).toContain('#198');
  });

  it('extracts multiple kaizen references from a single line', () => {
    const r = emptyResult();
    extractArtifacts(
      'feat: waiver quality enforcement (kaizen #280, #258, #198) (#235)',
      r,
    );
    // "kaizen #280" is caught; #258 and #198 without "kaizen" prefix are not
    // (they are plain PR/issue numbers, not kaizen references)
    expect(r.issuesClosed).toContain('#280');
  });

  it('extracts kaizen references case-insensitively', () => {
    const r = emptyResult();
    extractArtifacts('Kaizen #204 addressed in this PR', r);
    expect(r.issuesClosed).toContain('#204');
  });

  it('deduplicates kaizen refs with explicit close refs', () => {
    const r = emptyResult();
    extractArtifacts('closes #204, also mentioned as kaizen #204', r);
    expect(r.issuesClosed).toEqual(['#204']);
  });

  it('handles text with no artifacts', () => {
    const r = emptyResult();
    extractArtifacts('Just some regular text with no URLs', r);
    expect(r.prs).toEqual([]);
    expect(r.issuesFiled).toEqual([]);
    expect(r.issuesClosed).toEqual([]);
    expect(r.cases).toEqual([]);
  });
});

describe('checkStopSignal', () => {
  it('detects OVERNIGHT_STOP marker', () => {
    const r = emptyResult();
    checkStopSignal(
      'OVERNIGHT_STOP: backlog exhausted — no more matching issues',
      r,
    );
    expect(r.stopRequested).toBe(true);
    expect(r.stopReason).toBe('backlog exhausted — no more matching issues');
  });

  it('ignores text without the marker', () => {
    const r = emptyResult();
    checkStopSignal('Run completed successfully', r);
    expect(r.stopRequested).toBe(false);
  });

  it('handles marker with extra whitespace', () => {
    const r = emptyResult();
    checkStopSignal('OVERNIGHT_STOP:   all issues claimed  ', r);
    expect(r.stopRequested).toBe(true);
    expect(r.stopReason).toBe('all issues claimed');
  });
});

describe('formatToolUse', () => {
  it('formats Read tool', () => {
    expect(formatToolUse('Read', { file_path: '/src/index.ts' })).toBe(
      'Read /src/index.ts',
    );
  });

  it('formats Bash tool', () => {
    expect(formatToolUse('Bash', { command: 'npm test' })).toBe('$ npm test');
  });

  it('formats Skill tool', () => {
    expect(formatToolUse('Skill', { skill_name: 'make-a-dent' })).toBe(
      'Skill /make-a-dent',
    );
  });

  it('formats unknown tools by name', () => {
    expect(formatToolUse('WebSearch', {})).toBe('WebSearch');
  });

  it('truncates long paths', () => {
    const longPath = '/a'.repeat(100);
    const result = formatToolUse('Read', { file_path: longPath });
    expect(result.length).toBeLessThanOrEqual(65); // "Read " + 60 chars
  });
});

describe('processStreamMessage', () => {
  it('counts tool calls from assistant messages', () => {
    const r = emptyResult();
    processStreamMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/test' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      },
      r,
      Date.now(),
    );
    expect(r.toolCalls).toBe(2);
  });

  it('extracts cost from result message', () => {
    const r = emptyResult();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 2.14,
        result: 'Done!',
      },
      r,
      Date.now(),
    );
    expect(r.cost).toBe(2.14);
  });

  it('detects stop signal in result message', () => {
    const r = emptyResult();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 1.0,
        result: 'OVERNIGHT_STOP: no more work',
      },
      r,
      Date.now(),
    );
    expect(r.stopRequested).toBe(true);
    expect(r.stopReason).toBe('no more work');
  });

  it('extracts artifacts from assistant text blocks', () => {
    const r = emptyResult();
    processStreamMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Created https://github.com/Garsson-io/nanoclaw/pull/99',
            },
          ],
        },
      },
      r,
      Date.now(),
    );
    expect(r.prs).toEqual(['https://github.com/Garsson-io/nanoclaw/pull/99']);
  });
});

// ── Post-run hygiene tests ────────────────────────────────────────────────

// Mock child_process.execSync for hygiene functions
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(''),
  };
});

import { execSync } from 'child_process';
const mockExecSync = vi.mocked(execSync);

function resultWithPRs(...prs: string[]): RunResult {
  return {
    ...emptyResult(),
    prs,
  };
}

function resultWithIssues(...issues: string[]): RunResult {
  return {
    ...emptyResult(),
    issuesFiled: issues,
  };
}

function sampleState(overrides: Partial<BatchState> = {}): BatchState {
  return {
    batch_id: 'batch-260321-0210-4b50',
    batch_start: Math.floor(Date.now() / 1000) - 3600,
    guidance: 'focus on hooks reliability',
    max_runs: 5,
    cooldown: 30,
    budget: '5.00',
    max_failures: 3,
    run: 2,
    prs: [],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    consecutive_failures: 0,
    current_cooldown: 30,
    stop_reason: '',
    last_issue: '',
    last_pr: '',
    last_case: '',
    last_branch: '',
    last_worktree: '',
    ...overrides,
  };
}

describe('labelArtifacts', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue(Buffer.from(''));
  });

  it('labels PRs with overnight-dent in the correct repo', () => {
    const r = resultWithPRs('https://github.com/Garsson-io/nanoclaw/pull/234');
    labelArtifacts(r);

    expect(mockExecSync).toHaveBeenCalledWith(
      'gh pr edit 234 --repo Garsson-io/nanoclaw --add-label overnight-dent',
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('labels issues with overnight-dent in the correct repo', () => {
    const r = resultWithIssues(
      'https://github.com/Garsson-io/kaizen/issues/267',
    );
    labelArtifacts(r);

    expect(mockExecSync).toHaveBeenCalledWith(
      'gh issue edit 267 --repo Garsson-io/kaizen --add-label overnight-dent',
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('handles multiple PRs and issues', () => {
    const r: RunResult = {
      ...emptyResult(),
      prs: [
        'https://github.com/Garsson-io/nanoclaw/pull/1',
        'https://github.com/Garsson-io/nanoclaw/pull/2',
      ],
      issuesFiled: ['https://github.com/Garsson-io/kaizen/issues/10'],
    };
    labelArtifacts(r);

    // 2 PR labels + 1 issue label = 3 calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
  });

  it('does not throw on gh CLI failure', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('gh: not found');
    });

    const r = resultWithPRs('https://github.com/Garsson-io/nanoclaw/pull/234');
    expect(() => labelArtifacts(r)).not.toThrow();
  });

  it('skips labeling when no artifacts', () => {
    labelArtifacts(emptyResult());
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('queueAutoMerge', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue(Buffer.from(''));
  });

  it('queues auto-merge with correct flags', () => {
    const r = resultWithPRs('https://github.com/Garsson-io/nanoclaw/pull/99');
    queueAutoMerge(r);

    expect(mockExecSync).toHaveBeenCalledWith(
      'gh pr merge 99 --repo Garsson-io/nanoclaw --squash --delete-branch --auto',
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('does not throw on failure', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('already queued');
    });

    const r = resultWithPRs('https://github.com/Garsson-io/nanoclaw/pull/99');
    expect(() => queueAutoMerge(r)).not.toThrow();
  });
});

describe('updateBatchProgressIssue', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue(Buffer.from(''));
  });

  it('posts a comment with run details', () => {
    const r: RunResult = {
      ...emptyResult(),
      prs: ['https://github.com/Garsson-io/nanoclaw/pull/55'],
      cost: 3.42,
      toolCalls: 87,
    };
    updateBatchProgressIssue(
      'https://github.com/Garsson-io/kaizen/issues/500',
      3,
      0,
      420,
      r,
    );

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const call = mockExecSync.mock.calls[0]![0] as string;
    expect(call).toContain('gh issue comment 500 --repo Garsson-io/kaizen');
    expect(call).toContain('Run #3');
    expect(call).toContain('$3.42');
  });

  it('does nothing when no progress issue', () => {
    updateBatchProgressIssue('', 1, 0, 100, emptyResult());
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('closeBatchProgressIssue', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue(Buffer.from(''));
  });

  it('posts summary comment and closes the issue', () => {
    const state = sampleState({
      run: 5,
      prs: ['https://github.com/Garsson-io/nanoclaw/pull/1'],
      stop_reason: 'max runs reached',
    });

    closeBatchProgressIssue(
      'https://github.com/Garsson-io/kaizen/issues/500',
      state,
    );

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    const commentCall = mockExecSync.mock.calls[0]![0] as string;
    expect(commentCall).toContain('gh issue comment 500');
    expect(commentCall).toContain('Batch Complete');

    const closeCall = mockExecSync.mock.calls[1]![0] as string;
    expect(closeCall).toContain('gh issue close 500');
  });

  it('does nothing when no progress issue', () => {
    closeBatchProgressIssue('', sampleState());
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ── Test-task & experiment mode tests (kaizen #322) ─────────────────────

describe('buildPrompt', () => {
  // INVARIANT: buildPrompt with test_task=true produces a synthetic prompt
  // that does NOT invoke /make-a-dent, and instead creates a trivial PR lifecycle.

  it('uses /make-a-dent for normal runs', () => {
    const state = sampleState();
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('/make-a-dent');
  });

  it('uses synthetic task when test_task is true', () => {
    const state = sampleState({ test_task: true });
    const prompt = buildPrompt(state, 1);
    expect(prompt).not.toContain('/make-a-dent');
    expect(prompt).toContain('test-probe');
  });

  it('synthetic task prompt includes full PR lifecycle (create + merge)', () => {
    const state = sampleState({ test_task: true });
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('gh pr merge');
  });

  it('includes run tag in both modes', () => {
    const normalPrompt = buildPrompt(sampleState(), 3);
    const testPrompt = buildPrompt(sampleState({ test_task: true }), 3);
    expect(normalPrompt).toContain('batch-260321-0210-4b50/run-3');
    expect(testPrompt).toContain('batch-260321-0210-4b50/run-3');
  });

  it('includes merge policy in both modes', () => {
    const normalPrompt = buildPrompt(sampleState(), 1);
    const testPrompt = buildPrompt(sampleState({ test_task: true }), 1);
    expect(normalPrompt).toContain('--auto');
    expect(testPrompt).toContain('--auto');
  });

  it('includes previously created PRs to avoid overlap', () => {
    const state = sampleState({
      prs: ['https://github.com/Garsson-io/nanoclaw/pull/100'],
    });
    const prompt = buildPrompt(state, 2);
    expect(prompt).toContain('pull/100');
  });
});

describe('checkMergeStatus', () => {
  // INVARIANT: checkMergeStatus returns the merge state of a PR
  // by calling gh pr view and parsing the result.

  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('');
  });

  it('returns "merged" when PR state is MERGED', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ state: 'MERGED', mergeStateStatus: 'CLEAN' }),
    );
    const result = checkMergeStatus(
      'https://github.com/Garsson-io/nanoclaw/pull/99',
    );
    expect(result).toBe('merged');
  });

  it('returns "auto_queued" when autoMergeRequest is set', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'BEHIND',
        autoMergeRequest: { mergeMethod: 'SQUASH' },
      }),
    );
    const result = checkMergeStatus(
      'https://github.com/Garsson-io/nanoclaw/pull/99',
    );
    expect(result).toBe('auto_queued');
  });

  it('returns "open" when PR is open with no auto-merge', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'BEHIND',
        autoMergeRequest: null,
      }),
    );
    const result = checkMergeStatus(
      'https://github.com/Garsson-io/nanoclaw/pull/99',
    );
    expect(result).toBe('open');
  });

  it('returns "unknown" on gh CLI failure', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('gh: not found');
    });
    const result = checkMergeStatus(
      'https://github.com/Garsson-io/nanoclaw/pull/99',
    );
    expect(result).toBe('unknown');
  });
});

describe('BatchState test_task and experiment fields', () => {
  // INVARIANT: BatchState accepts test_task and experiment optional fields
  // without breaking existing functionality.

  it('sampleState accepts test_task field', () => {
    const state = sampleState({ test_task: true });
    expect(state.test_task).toBe(true);
  });

  it('sampleState defaults test_task to undefined', () => {
    const state = sampleState();
    expect(state.test_task).toBeUndefined();
  });

  it('sampleState accepts experiment field', () => {
    const state = sampleState({ experiment: true });
    expect(state.experiment).toBe(true);
  });
});
