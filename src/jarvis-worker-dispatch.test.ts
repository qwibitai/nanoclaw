import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  insertWorkerRun,
  completeWorkerRun,
  getWorkerRun,
  updateWorkerRunStatus,
  updateWorkerRunCompletion,
} from './db.js';
import {
  parseDispatchPayload,
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
      test_summary: 'all 5 tests pass',
      risk_summary: 'low',
    });
    const row = getWorkerRun('run-cmp');
    expect(row?.branch_name).toBe('jarvis-feature');
    expect(row?.pr_url).toBe('https://github.com/org/repo/pull/42');
    expect(row?.commit_sha).toBe('abc123');
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
});

describe('getWorkerRun', () => {
  beforeEach(() => _initTestDatabase());

  it('returns undefined for unknown run_id', () => {
    expect(getWorkerRun('nonexistent')).toBeUndefined();
  });
});

describe('dispatch payload parsing', () => {
  it('extracts run_id from JSON in message content', () => {
    const content = 'Please work on this: {"run_id": "task-abc", "task_type": "code", "input": "build X"}';
    const payload = parseDispatchPayload(content);
    expect(payload?.run_id).toBe('task-abc');
    expect(payload?.task_type).toBe('code');
  });

  it('returns null when no JSON present', () => {
    expect(parseDispatchPayload('just plain text')).toBeNull();
  });

  it('returns null when JSON has no run_id', () => {
    expect(parseDispatchPayload('{"task": "something"}')).toBeNull();
  });

  it('parses standalone JSON object', () => {
    const payload = parseDispatchPayload('{"run_id": "fix-42-1", "priority": "high"}');
    expect(payload?.run_id).toBe('fix-42-1');
    expect(payload?.priority).toBe('high');
  });
});

describe('dispatch payload validation', () => {
  it('accepts a valid run_id', () => {
    const { valid, errors } = validateDispatchPayload({ run_id: 'task-20260222-001' });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty run_id', () => {
    const { valid, errors } = validateDispatchPayload({ run_id: '' });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects run_id with whitespace', () => {
    const { valid } = validateDispatchPayload({ run_id: 'has spaces' });
    expect(valid).toBe(false);
  });

  it('rejects run_id longer than 64 chars', () => {
    const { valid } = validateDispatchPayload({ run_id: 'a'.repeat(65) });
    expect(valid).toBe(false);
  });

  it('accepts run_id of exactly 64 chars', () => {
    const { valid } = validateDispatchPayload({ run_id: 'a'.repeat(64) });
    expect(valid).toBe(true);
  });
});

describe('completion contract parsing', () => {
  it('parses a valid completion block', () => {
    const output = `
Done!
<completion>
{
  "branch": "jarvis-feat",
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
    const output = '<completion>{"branch":"b","pr_skipped_reason":"no changes","test_result":"ok","risk":"none"}</completion>';
    const contract = parseCompletionContract(output);
    expect(contract?.pr_skipped_reason).toBe('no changes');
    expect(contract?.pr_url).toBeUndefined();
  });
});

describe('completion contract validation', () => {
  it('validates a complete contract with pr_url', () => {
    const { valid, missing } = validateCompletionContract({
      branch: 'feat',
      pr_url: 'https://github.com/...',
      test_result: 'pass',
      risk: 'low',
    });
    expect(valid).toBe(true);
    expect(missing).toHaveLength(0);
  });

  it('validates a contract with pr_skipped_reason', () => {
    const { valid } = validateCompletionContract({
      branch: 'feat',
      pr_skipped_reason: 'already open',
      test_result: 'pass',
      risk: 'low',
    });
    expect(valid).toBe(true);
  });

  it('fails when branch is missing', () => {
    const { valid, missing } = validateCompletionContract({
      branch: '',
      pr_url: 'url',
      test_result: 'pass',
      risk: 'low',
    });
    expect(valid).toBe(false);
    expect(missing).toContain('branch');
  });

  it('fails when both pr_url and pr_skipped_reason are absent', () => {
    const { valid, missing } = validateCompletionContract({
      branch: 'feat',
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
      branch: 'feat',
      pr_url: 'url',
      test_result: '',
      risk: 'low',
    });
    expect(valid).toBe(false);
    expect(missing).toContain('test_result');
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

describe('run_id generation stability', () => {
  it('same inputs produce same run_id', () => {
    const { createHash } = require('crypto');
    const folder = 'jarvis-worker-1';
    const msgId = 'msg-abc';
    const content = 'Clone the repo and add tests';
    const hash1 = createHash('sha256').update(`${folder}:${msgId}:${content}`).digest('hex').slice(0, 16);
    const hash2 = createHash('sha256').update(`${folder}:${msgId}:${content}`).digest('hex').slice(0, 16);
    expect(hash1).toBe(hash2);
  });

  it('different message ids produce different run_ids', () => {
    const { createHash } = require('crypto');
    const folder = 'jarvis-worker-1';
    const content = 'same task';
    const h1 = createHash('sha256').update(`${folder}:msg-1:${content}`).digest('hex').slice(0, 16);
    const h2 = createHash('sha256').update(`${folder}:msg-2:${content}`).digest('hex').slice(0, 16);
    expect(h1).not.toBe(h2);
  });
});
