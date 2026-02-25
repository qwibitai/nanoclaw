import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  insertWorkerRun,
  completeWorkerRun,
  getWorkerRun,
  getWorkerRuns,
  updateWorkerRunStatus,
  updateWorkerRunCompletion,
} from './db.js';
import {
  parseDispatchPayload,
  requiresBrowserEvidence,
  validateDispatchPayload,
  parseCompletionContract,
  validateCompletionContract,
} from './dispatch-validator.js';

describe('insertWorkerRun returns new/retry/duplicate', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it("returns 'new' for unseen run_id", () => {
    expect(insertWorkerRun('run-001', 'jarvis-worker-1')).toBe('new');
  });

  it("returns 'duplicate' for run_id that is running", () => {
    insertWorkerRun('run-002', 'jarvis-worker-1');
    updateWorkerRunStatus('run-002', 'running');
    expect(insertWorkerRun('run-002', 'jarvis-worker-1')).toBe('duplicate');
  });

  it("returns 'duplicate' for run_id that is review_requested", () => {
    insertWorkerRun('run-003', 'jarvis-worker-1');
    updateWorkerRunStatus('run-003', 'review_requested');
    expect(insertWorkerRun('run-003', 'jarvis-worker-1')).toBe('duplicate');
  });

  it("returns 'duplicate' for run_id that is done", () => {
    insertWorkerRun('run-004', 'jarvis-worker-1');
    updateWorkerRunStatus('run-004', 'done');
    expect(insertWorkerRun('run-004', 'jarvis-worker-1')).toBe('duplicate');
  });

  it("returns 'retry' for run_id with status 'failed'", () => {
    insertWorkerRun('run-005', 'jarvis-worker-1');
    updateWorkerRunStatus('run-005', 'failed');
    expect(insertWorkerRun('run-005', 'jarvis-worker-1')).toBe('retry');
  });

  it("returns 'retry' for run_id with status 'failed_contract'", () => {
    insertWorkerRun('run-006', 'jarvis-worker-1');
    updateWorkerRunStatus('run-006', 'failed_contract');
    expect(insertWorkerRun('run-006', 'jarvis-worker-1')).toBe('retry');
  });

  it('increments retry_count on retry', () => {
    insertWorkerRun('run-007', 'jarvis-worker-1');
    updateWorkerRunStatus('run-007', 'failed');
    insertWorkerRun('run-007', 'jarvis-worker-1');
    const row = getWorkerRun('run-007');
    expect(row?.retry_count).toBe(1);
  });

  it('increments retry_count on second retry', () => {
    insertWorkerRun('run-008', 'jarvis-worker-1');
    updateWorkerRunStatus('run-008', 'failed');
    insertWorkerRun('run-008', 'jarvis-worker-1');
    updateWorkerRunStatus('run-008', 'failed_contract');
    insertWorkerRun('run-008', 'jarvis-worker-1');
    const row = getWorkerRun('run-008');
    expect(row?.retry_count).toBe(2);
  });

  it('run_id is globally unique (same id on different group = duplicate)', () => {
    insertWorkerRun('run-009', 'jarvis-worker-1');
    expect(insertWorkerRun('run-009', 'jarvis-worker-2')).toBe('duplicate');
  });

  it("new run starts with status 'queued'", () => {
    insertWorkerRun('run-010', 'jarvis-worker-1');
    expect(getWorkerRun('run-010')?.status).toBe('queued');
  });

  it("retry resets status to 'queued'", () => {
    insertWorkerRun('run-011', 'jarvis-worker-1');
    updateWorkerRunStatus('run-011', 'failed');
    insertWorkerRun('run-011', 'jarvis-worker-1');
    expect(getWorkerRun('run-011')?.status).toBe('queued');
  });
});

describe('updateWorkerRunCompletion stores contract fields', () => {
  beforeEach(() => {
    _initTestDatabase();
    insertWorkerRun('run-cmp', 'jarvis-worker-1');
  });

  it('stores all contract fields', () => {
    updateWorkerRunCompletion('run-cmp', {
      branch_name: 'jarvis-feature',
      pr_url: 'https://github.com/org/repo/pull/42',
      commit_sha: 'abc123',
      files_changed: ['src/a.ts', 'src/b.ts'],
      test_summary: 'all 5 tests pass',
      risk_summary: 'low',
    });
    const row = getWorkerRun('run-cmp');
    expect(row?.branch_name).toBe('jarvis-feature');
    expect(row?.pr_url).toBe('https://github.com/org/repo/pull/42');
    expect(row?.commit_sha).toBe('abc123');
    expect(row?.files_changed).toBe('["src/a.ts","src/b.ts"]');
    expect(row?.test_summary).toBe('all 5 tests pass');
    expect(row?.risk_summary).toBe('low');
  });

  it('stores null for omitted fields', () => {
    updateWorkerRunCompletion('run-cmp', { branch_name: 'feat' });
    const row = getWorkerRun('run-cmp');
    expect(row?.pr_url).toBeNull();
  });
});

describe('completeWorkerRun (legacy helper)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('sets status to done', () => {
    insertWorkerRun('run-leg1', 'jarvis-worker-1');
    completeWorkerRun('run-leg1', 'done', 'Task done');
    expect(getWorkerRun('run-leg1')?.status).toBe('done');
    expect(getWorkerRun('run-leg1')?.result_summary).toBe('Task done');
  });

  it('sets status to failed', () => {
    insertWorkerRun('run-leg2', 'jarvis-worker-1');
    completeWorkerRun('run-leg2', 'failed');
    expect(getWorkerRun('run-leg2')?.status).toBe('failed');
  });

  it('stores error_details when provided', () => {
    insertWorkerRun('run-leg3', 'jarvis-worker-1');
    completeWorkerRun('run-leg3', 'failed_contract', 'missing fields', '{"missing":["commit_sha"]}');
    const row = getWorkerRun('run-leg3');
    expect(row?.result_summary).toBe('missing fields');
    expect(row?.error_details).toBe('{"missing":["commit_sha"]}');
  });
});

describe('getWorkerRun', () => {
  beforeEach(() => _initTestDatabase());

  it('returns undefined for unknown run_id', () => {
    expect(getWorkerRun('nonexistent')).toBeUndefined();
  });
});

describe('getWorkerRuns', () => {
  beforeEach(() => _initTestDatabase());

  it('filters by group folder prefix and status', () => {
    insertWorkerRun('run-a', 'jarvis-worker-1');
    insertWorkerRun('run-b', 'jarvis-worker-2');
    insertWorkerRun('run-c', 'main');
    updateWorkerRunStatus('run-a', 'running');
    updateWorkerRunStatus('run-b', 'failed_contract');
    updateWorkerRunStatus('run-c', 'running');

    const rows = getWorkerRuns({
      groupFolderLike: 'jarvis-worker-%',
      statuses: ['running'],
      limit: 10,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe('run-a');
    expect(rows[0].group_folder).toBe('jarvis-worker-1');
    expect(rows[0].status).toBe('running');
  });
});

describe('dispatch payload parsing', () => {
  it('extracts run_id from JSON in message content', () => {
    const content = 'Please work on this: {"run_id":"task-abc","task_type":"implement","input":"build X","repo":"openclaw-gurusharan/nanoclaw","branch":"jarvis-build-x","acceptance_tests":["npm run build"],"output_contract":{"required_fields":["run_id","branch","commit_sha","files_changed","test_result","risk","pr_url"]}}';
    const payload = parseDispatchPayload(content);
    expect(payload?.run_id).toBe('task-abc');
    expect(payload?.task_type).toBe('implement');
  });

  it('returns null when no JSON present', () => {
    expect(parseDispatchPayload('just plain text')).toBeNull();
  });

  it('returns null when JSON has no run_id', () => {
    expect(parseDispatchPayload('{"task": "something"}')).toBeNull();
  });

  it('parses standalone JSON object', () => {
    const payload = parseDispatchPayload('{"run_id":"fix-42-1","task_type":"fix","input":"fix bug","repo":"openclaw-gurusharan/nanoclaw","branch":"jarvis-fix-42","acceptance_tests":["npm test"],"output_contract":{"required_fields":["run_id","branch","commit_sha","files_changed","test_result","risk","pr_skipped_reason"]},"priority":"high"}');
    expect(payload?.run_id).toBe('fix-42-1');
    expect(payload?.priority).toBe('high');
  });
});

describe('dispatch payload validation', () => {
  const validPayload = {
    run_id: 'task-20260222-001',
    task_type: 'implement' as const,
    input: 'Implement feature X',
    repo: 'openclaw-gurusharan/nanoclaw',
    branch: 'jarvis-feature-x',
    acceptance_tests: ['npm run build', 'npm test'],
    output_contract: {
      required_fields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url'],
    },
  };

  it('accepts a valid payload', () => {
    const { valid, errors } = validateDispatchPayload(validPayload);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty run_id', () => {
    const { valid, errors } = validateDispatchPayload({ ...validPayload, run_id: '' });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects run_id with whitespace', () => {
    const { valid } = validateDispatchPayload({ ...validPayload, run_id: 'has spaces' });
    expect(valid).toBe(false);
  });

  it('rejects run_id longer than 64 chars', () => {
    const { valid } = validateDispatchPayload({ ...validPayload, run_id: 'a'.repeat(65) });
    expect(valid).toBe(false);
  });

  it('accepts run_id of exactly 64 chars', () => {
    const { valid } = validateDispatchPayload({ ...validPayload, run_id: 'a'.repeat(64) });
    expect(valid).toBe(true);
  });

  it('rejects repo not in owner/repo format', () => {
    const { valid, errors } = validateDispatchPayload({ ...validPayload, repo: 'bad-format' });
    expect(valid).toBe(false);
    expect(errors).toContain('repo must be in owner/repo format');
  });

  it('rejects non-jarvis branch names', () => {
    const { valid, errors } = validateDispatchPayload({ ...validPayload, branch: 'feature-x' });
    expect(valid).toBe(false);
    expect(errors).toContain('branch must match jarvis-<feature>');
  });

  it('rejects payload when output contract misses required fields', () => {
    const { valid, errors } = validateDispatchPayload({
      ...validPayload,
      output_contract: { required_fields: ['run_id', 'branch'] },
    });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('output_contract.required_fields missing commit_sha'))).toBe(true);
  });

  it('requires browser_evidence field for explicit UI-impacting dispatch', () => {
    const { valid, errors } = validateDispatchPayload({
      ...validPayload,
      ui_impacting: true,
      output_contract: {
        required_fields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url'],
      },
    });
    expect(valid).toBe(false);
    expect(
      errors.includes('output_contract.required_fields must include browser_evidence for UI-impacting tasks'),
    ).toBe(true);
  });

  it('accepts UI-impacting dispatch when browser_evidence is required in contract', () => {
    const { valid, errors } = validateDispatchPayload({
      ...validPayload,
      ui_impacting: true,
      output_contract: {
        required_fields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url', 'browser_evidence'],
      },
    });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('detects browser evidence requirement from UI hints when flag is omitted', () => {
    const payload = {
      ...validPayload,
      input: 'Fix dashboard sidebar UI spacing',
      acceptance_tests: ['run chrome-devtools checks on http://127.0.0.1:3000/dashboard'],
      output_contract: {
        required_fields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url', 'browser_evidence'],
      },
    };
    expect(requiresBrowserEvidence(payload)).toBe(true);
  });

  it('rejects dispatch input that requests screenshot capture/analysis', () => {
    const { valid, errors } = validateDispatchPayload({
      ...validPayload,
      input: 'Run browser tests and take a screenshot of dashboard for confirmation',
      output_contract: {
        required_fields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url', 'browser_evidence'],
      },
    });
    expect(valid).toBe(false);
    expect(errors).toContain('input must not request screenshot capture/analysis; use text-based browser evidence');
  });

  it('rejects acceptance tests that include screenshot commands', () => {
    const { valid, errors } = validateDispatchPayload({
      ...validPayload,
      input: 'Validate dashboard via evaluate_script assertions',
      acceptance_tests: ['mcp chrome-devtools take_screenshot /dashboard'],
      output_contract: {
        required_fields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url', 'browser_evidence'],
      },
    });
    expect(valid).toBe(false);
    expect(errors).toContain('acceptance_tests must not include screenshot commands; use text-based checks');
  });
});

describe('completion contract parsing', () => {
  it('parses a valid completion block', () => {
    const output = `
Done!
<completion>
{
  "run_id": "task-20260222-001",
  "branch": "jarvis-feat",
  "files_changed": ["src/a.ts"],
  "pr_url": "https://github.com/org/repo/pull/1",
  "commit_sha": "deadbeef",
  "test_result": "5/5 pass",
  "risk": "low"
}
</completion>
    `;
    const contract = parseCompletionContract(output);
    expect(contract?.branch).toBe('jarvis-feat');
    expect(contract?.test_result).toBe('5/5 pass');
    expect(contract?.risk).toBe('low');
  });

  it('returns null when no completion block', () => {
    expect(parseCompletionContract('no block here')).toBeNull();
  });

  it('returns null for invalid JSON in block', () => {
    expect(parseCompletionContract('<completion>not json</completion>')).toBeNull();
  });

  it('parses contract with pr_skipped_reason instead of pr_url', () => {
    const output = '<completion>{"run_id":"task-1","branch":"jarvis-b","commit_sha":"abc1234","files_changed":["README.md"],"pr_skipped_reason":"no changes","test_result":"ok","risk":"none"}</completion>';
    const contract = parseCompletionContract(output);
    expect(contract?.pr_skipped_reason).toBe('no changes');
    expect(contract?.pr_url).toBeUndefined();
  });
});

describe('completion contract validation', () => {
  it('validates a complete contract with pr_url', () => {
    const { valid, missing } = validateCompletionContract({
      run_id: 'task-1',
      branch: 'jarvis-feat',
      commit_sha: 'abc1234',
      files_changed: ['src/a.ts'],
      pr_url: 'https://github.com/...',
      test_result: 'pass',
      risk: 'low',
    });
    expect(valid).toBe(true);
    expect(missing).toHaveLength(0);
  });

  it('validates a contract with pr_skipped_reason', () => {
    const { valid } = validateCompletionContract({
      run_id: 'task-1',
      branch: 'jarvis-feat',
      commit_sha: 'abc1234',
      files_changed: ['README.md'],
      pr_skipped_reason: 'already open',
      test_result: 'pass',
      risk: 'low',
    });
    expect(valid).toBe(true);
  });

  it('fails when branch is missing', () => {
    const { valid, missing } = validateCompletionContract({
      run_id: 'task-1',
      branch: '',
      commit_sha: 'abc1234',
      files_changed: ['src/a.ts'],
      pr_url: 'url',
      test_result: 'pass',
      risk: 'low',
    });
    expect(valid).toBe(false);
    expect(missing).toContain('branch');
  });

  it('fails when both pr_url and pr_skipped_reason are absent', () => {
    const { valid, missing } = validateCompletionContract({
      run_id: 'task-1',
      branch: 'jarvis-feat',
      commit_sha: 'abc1234',
      files_changed: ['src/a.ts'],
      test_result: 'pass',
      risk: 'low',
    });
    expect(valid).toBe(false);
    expect(missing).toContain('pr_url or pr_skipped_reason');
  });

  it('fails when contract is null', () => {
    const { valid, missing } = validateCompletionContract(null);
    expect(valid).toBe(false);
    expect(missing).toContain('completion block');
  });

  it('fails when test_result is missing', () => {
    const { valid, missing } = validateCompletionContract({
      run_id: 'task-1',
      branch: 'jarvis-feat',
      commit_sha: 'abc1234',
      files_changed: ['src/a.ts'],
      pr_url: 'url',
      test_result: '',
      risk: 'low',
    });
    expect(valid).toBe(false);
    expect(missing).toContain('test_result');
  });

  it('fails when run_id mismatches expected run id', () => {
    const { valid, missing } = validateCompletionContract(
      {
        run_id: 'task-abc',
        branch: 'jarvis-feat',
        commit_sha: 'abc1234',
        files_changed: ['src/a.ts'],
        pr_url: 'url',
        test_result: 'pass',
        risk: 'low',
      },
      { expectedRunId: 'task-xyz' },
    );
    expect(valid).toBe(false);
    expect(missing).toContain('run_id mismatch');
  });

  it('fails when browser evidence is required but missing', () => {
    const { valid, missing } = validateCompletionContract(
      {
        run_id: 'task-1',
        branch: 'jarvis-feat',
        commit_sha: 'abc1234',
        files_changed: ['src/a.ts'],
        pr_url: 'url',
        test_result: 'pass',
        risk: 'low',
      },
      {
        expectedRunId: 'task-1',
        requiredFields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url', 'browser_evidence'],
      },
    );
    expect(valid).toBe(false);
    expect(missing).toContain('browser_evidence');
  });

  it('accepts valid browser evidence when required', () => {
    const { valid, missing } = validateCompletionContract(
      {
        run_id: 'task-1',
        branch: 'jarvis-feat',
        commit_sha: 'abc1234',
        files_changed: ['src/a.ts'],
        pr_url: 'url',
        test_result: 'pass',
        risk: 'low',
        browser_evidence: {
          base_url: 'http://127.0.0.1:3000/dashboard',
          tools_listed: ['chrome-devtools', 'token-efficient'],
          execute_tool_evidence: ['navigate /dashboard -> sidebar visible'],
        },
      },
      {
        expectedRunId: 'task-1',
        requiredFields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url', 'browser_evidence'],
      },
    );
    expect(valid).toBe(true);
    expect(missing).toHaveLength(0);
  });

  it('rejects browser evidence with non-local base_url', () => {
    const { valid, missing } = validateCompletionContract(
      {
        run_id: 'task-1',
        branch: 'jarvis-feat',
        commit_sha: 'abc1234',
        files_changed: ['src/a.ts'],
        pr_url: 'url',
        test_result: 'pass',
        risk: 'low',
        browser_evidence: {
          base_url: 'https://example.com',
          tools_listed: ['chrome-devtools'],
          execute_tool_evidence: ['checked /dashboard'],
        },
      },
      {
        expectedRunId: 'task-1',
        requiredFields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url', 'browser_evidence'],
      },
    );
    expect(valid).toBe(false);
    expect(missing).toContain('browser_evidence.base_url');
  });

  it('rejects browser evidence that references screenshots', () => {
    const { valid, missing } = validateCompletionContract(
      {
        run_id: 'task-1',
        branch: 'jarvis-feat',
        commit_sha: 'abc1234',
        files_changed: ['src/a.ts'],
        pr_url: 'url',
        test_result: 'pass',
        risk: 'low',
        browser_evidence: {
          base_url: 'http://127.0.0.1:3000/dashboard',
          tools_listed: ['chrome-devtools'],
          execute_tool_evidence: ['take_screenshot /dashboard and compare pixels'],
        },
      },
      {
        expectedRunId: 'task-1',
        requiredFields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url', 'browser_evidence'],
      },
    );
    expect(valid).toBe(false);
    expect(missing).toContain('browser_evidence.no_screenshots');
  });
});

describe('usage stats shape', () => {
  it('validates required usage fields', () => {
    const usage = {
      input_tokens: 1200,
      output_tokens: 350,
      duration_ms: 12500,
      peak_rss_mb: 128,
    };
    expect(typeof usage.input_tokens).toBe('number');
    expect(typeof usage.output_tokens).toBe('number');
    expect(typeof usage.duration_ms).toBe('number');
    expect(typeof usage.peak_rss_mb).toBe('number');
    expect(usage.duration_ms).toBeGreaterThanOrEqual(0);
    expect(usage.peak_rss_mb).toBeGreaterThanOrEqual(0);
  });
});

describe('run_id contract invariants', () => {
  it('requires explicit run_id on dispatch payload validation', () => {
    const { valid, errors } = validateDispatchPayload({
      run_id: '',
      task_type: 'implement',
      input: 'x',
      repo: 'openclaw-gurusharan/nanoclaw',
      branch: 'jarvis-x',
      acceptance_tests: ['npm test'],
      output_contract: {
        required_fields: ['run_id', 'branch', 'commit_sha', 'files_changed', 'test_result', 'risk', 'pr_url'],
      },
    });
    expect(valid).toBe(false);
    expect(errors).toContain('run_id must be a non-empty string with no whitespace');
  });
});
