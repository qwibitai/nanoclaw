import fs from 'fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReliableSender } from './delivery.js';

describe('createReliableSender', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries failed sends and eventually succeeds', async () => {
    const sendFn = vi
      .fn<(_: string, __: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce();

    const reliableSend = createReliableSender(sendFn, {
      provider: 'test',
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
      minIntervalMs: 0,
    });

    await reliableSend('telegram://-100123', 'hello');
    expect(sendFn).toHaveBeenCalledTimes(3);
  });

  it('writes dead-letter record after exhausting retries', async () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as never);
    const appendSpy = vi
      .spyOn(fs, 'appendFileSync')
      .mockImplementation(() => undefined);

    const sendFn = vi
      .fn<(_: string, __: string) => Promise<void>>()
      .mockRejectedValue(new Error('permanent failure'));

    const reliableSend = createReliableSender(sendFn, {
      provider: 'test',
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      minIntervalMs: 0,
    });

    await expect(
      reliableSend('slack://C12345678', 'please send'),
    ).rejects.toThrow('Failed to deliver message after 2 attempts');

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(appendSpy).toHaveBeenCalledTimes(1);
  });
});
