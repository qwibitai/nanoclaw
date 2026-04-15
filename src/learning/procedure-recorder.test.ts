import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockSaveProcedure = vi.fn();
const mockFindProcedure = vi.fn();

vi.mock('../memory/procedure-store.js', () => ({
  saveProcedure: (...args: unknown[]) => mockSaveProcedure(...args),
  findProcedure: (...args: unknown[]) => mockFindProcedure(...args),
}));

import { startTrace, addTrace, finalizeTrace } from './procedure-recorder.js';

describe('startTrace', () => {
  beforeEach(() => vi.clearAllMocks());
  it('creates a trace buffer entry without errors', () => {
    expect(() => startTrace('g1', 'task-1')).not.toThrow();
  });
});

describe('addTrace', () => {
  beforeEach(() => vi.clearAllMocks());
  it('appends action to trace buffer', () => {
    startTrace('g1', 'task-2');
    expect(() => addTrace('g1', 'task-2', {
      type: 'browser_navigate', timestamp: Date.now(),
      inputSummary: 'https://github.com', result: 'success',
    })).not.toThrow();
  });
  it('silently ignores addTrace when no trace started', () => {
    expect(() => addTrace('g1', 'no-trace-task', {
      type: 'send_message', timestamp: Date.now(),
      inputSummary: 'hello', result: 'success',
    })).not.toThrow();
  });
});

describe('finalizeTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProcedure.mockReturnValue(null);
  });

  it('discards trace on failure', () => {
    startTrace('g1', 'task-fail');
    addTrace('g1', 'task-fail', { type: 'browser_navigate', timestamp: Date.now(), inputSummary: 'x', result: 'success' });
    addTrace('g1', 'task-fail', { type: 'send_message', timestamp: Date.now(), inputSummary: 'y', result: 'success' });
    finalizeTrace('g1', 'task-fail', false);
    expect(mockSaveProcedure).not.toHaveBeenCalled();
  });

  it('saves procedure from IPC trace on success with 2+ actions', () => {
    startTrace('g1', 'task-ok');
    addTrace('g1', 'task-ok', { type: 'github_api', timestamp: Date.now(), inputSummary: 'GET /pulls', result: 'success' });
    addTrace('g1', 'task-ok', { type: 'send_message', timestamp: Date.now(), inputSummary: 'PR is open', result: 'success' });
    finalizeTrace('g1', 'task-ok', true);
    expect(mockSaveProcedure).toHaveBeenCalledOnce();
  });

  it('skips save when fewer than 2 actions', () => {
    startTrace('g1', 'task-single');
    addTrace('g1', 'task-single', { type: 'send_message', timestamp: Date.now(), inputSummary: 'hi', result: 'success' });
    finalizeTrace('g1', 'task-single', true);
    expect(mockSaveProcedure).not.toHaveBeenCalled();
  });

  it('uses agent procedure name/description when provided', () => {
    startTrace('g1', 'task-agent');
    addTrace('g1', 'task-agent', { type: 'github_api', timestamp: Date.now(), inputSummary: 'GET /pulls', result: 'success' });
    addTrace('g1', 'task-agent', { type: 'send_message', timestamp: Date.now(), inputSummary: 'done', result: 'success' });
    finalizeTrace('g1', 'task-agent', true, {
      name: 'check-pr-status',
      trigger: 'check PR status',
      description: 'Check GitHub PR status and summarize',
      steps: [
        { action: 'github_api', details: 'GET /repos/{owner}/{repo}/pulls/{number}' },
        { action: 'format_response', details: 'Summarize PR title, status, reviewers' },
      ],
    });
    const saved = mockSaveProcedure.mock.calls[0][0];
    expect(saved.name).toBe('check-pr-status');
    expect(saved.trigger).toBe('check PR status');
  });

  it('increments success_count when duplicate procedure found', () => {
    mockFindProcedure.mockReturnValue({
      name: 'check-pr-status', trigger: 'check PR status',
      description: 'existing',
      steps: [{ action: 'github_api' }, { action: 'send_message' }],
      success_count: 5, failure_count: 0, auto_execute: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      groupId: 'g1',
    });
    startTrace('g1', 'task-dup');
    addTrace('g1', 'task-dup', { type: 'github_api', timestamp: Date.now(), inputSummary: 'GET /pulls', result: 'success' });
    addTrace('g1', 'task-dup', { type: 'send_message', timestamp: Date.now(), inputSummary: 'done', result: 'success' });
    finalizeTrace('g1', 'task-dup', true, {
      name: 'check-pr-status', trigger: 'check PR status',
      description: 'Check GitHub PR status',
      steps: [
        { action: 'github_api', details: 'GET /pulls' },
        { action: 'send_message', details: 'send result' },
      ],
    });
    const saved = mockSaveProcedure.mock.calls[0][0];
    expect(saved.success_count).toBe(6);
  });
});
