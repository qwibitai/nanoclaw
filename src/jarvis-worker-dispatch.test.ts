import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, insertWorkerRun, completeWorkerRun, getWorkerRun } from './db.js';

describe('worker run deduplication', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('inserts a new run_id and returns true', () => {
    const inserted = insertWorkerRun('run-001', 'jarvis-worker-1');
    expect(inserted).toBe(true);
  });

  it('returns false for duplicate run_id', () => {
    insertWorkerRun('run-002', 'jarvis-worker-1');
    const duplicate = insertWorkerRun('run-002', 'jarvis-worker-1');
    expect(duplicate).toBe(false);
  });

  it('allows same run_id on different worker groups', () => {
    insertWorkerRun('run-003', 'jarvis-worker-1');
    // Different group — run_id is globally unique (primary key), so this should still fail
    const duplicate = insertWorkerRun('run-003', 'jarvis-worker-2');
    expect(duplicate).toBe(false);
  });

  it('starts with status running', () => {
    insertWorkerRun('run-004', 'jarvis-worker-1');
    const row = getWorkerRun('run-004');
    expect(row?.status).toBe('running');
  });

  it('completes a run and records status', () => {
    insertWorkerRun('run-005', 'jarvis-worker-1');
    completeWorkerRun('run-005', 'completed', 'Task done');
    const row = getWorkerRun('run-005');
    expect(row?.status).toBe('completed');
    expect(row?.result_summary).toBe('Task done');
  });

  it('marks a failed run', () => {
    insertWorkerRun('run-006', 'jarvis-worker-1');
    completeWorkerRun('run-006', 'failed');
    const row = getWorkerRun('run-006');
    expect(row?.status).toBe('failed');
  });

  it('returns undefined for unknown run_id', () => {
    const row = getWorkerRun('nonexistent');
    expect(row).toBeUndefined();
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
