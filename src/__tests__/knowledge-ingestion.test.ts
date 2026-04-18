import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockStoreFactWithVector = vi.fn().mockResolvedValue(1);

vi.mock('../memory/knowledge-store.js', () => ({
  storeFactWithVector: (...args: unknown[]) => mockStoreFactWithVector(...args),
}));

import { captureTaskOutcome } from '../knowledge-ingestion.js';

describe('captureTaskOutcome', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores a fact from a successful task', async () => {
    await captureTaskOutcome({
      groupId: 'telegram_main',
      prompt: 'Check the PR status for nanoclaw',
      status: 'success',
      durationMs: 5000,
    });

    expect(mockStoreFactWithVector).toHaveBeenCalledOnce();
    const arg = mockStoreFactWithVector.mock.calls[0][0];
    expect(arg.text).toContain('Check the PR status');
    expect(arg.domain).toBe('task_outcome');
    expect(arg.groupId).toBe('telegram_main');
    expect(arg.source).toBe('auto_capture');
  });

  it('skips failed tasks', async () => {
    await captureTaskOutcome({
      groupId: 'g1',
      prompt: 'do something',
      status: 'error',
      durationMs: 1000,
    });

    expect(mockStoreFactWithVector).not.toHaveBeenCalled();
  });

  it('truncates very long prompts', async () => {
    await captureTaskOutcome({
      groupId: 'g1',
      prompt: 'x'.repeat(1000),
      status: 'success',
      durationMs: 2000,
    });

    const arg = mockStoreFactWithVector.mock.calls[0][0];
    expect(arg.text.length).toBeLessThanOrEqual(300);
  });

  it('skips very short prompts', async () => {
    await captureTaskOutcome({
      groupId: 'g1',
      prompt: 'hi',
      status: 'success',
      durationMs: 500,
    });

    expect(mockStoreFactWithVector).not.toHaveBeenCalled();
  });

  it('does not throw when storeFactWithVector fails', async () => {
    mockStoreFactWithVector.mockRejectedValueOnce(new Error('Qdrant down'));

    await expect(
      captureTaskOutcome({
        groupId: 'g1',
        prompt: 'Check something important',
        status: 'success',
        durationMs: 3000,
      }),
    ).resolves.not.toThrow();
  });
});
