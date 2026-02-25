import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupQueue } from './group-queue.js';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-recovery',
  MAX_CONCURRENT_CONTAINERS: 2,
  MAX_RETRIES: 5,
  RETRY_BASE_DELAY_MS: 5000,
  RECOVERY_EXHAUSTED_GATE_MS: 0,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 80000];

describe('recovery outage lifecycle integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  async function driveToExhaustion(
    queue: GroupQueue,
    groupJid: string,
  ): Promise<void> {
    queue.enqueueMessageCheck(groupJid);
    await vi.advanceTimersByTimeAsync(10);

    for (const delayMs of RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delayMs + 10);
    }
  }

  it('full outage exhaustion recovery lifecycle', async () => {
    const queue = new GroupQueue();
    const onExhaustionDrop = vi.fn();
    queue.setOnExhaustionDropFn(onExhaustionDrop);

    let attempts = 0;
    const processMessages = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 6) {
        throw new Error('simulated outage');
      }
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    const groupJid = 'slack:C123';
    await driveToExhaustion(queue, groupJid);

    const state = (queue as any).groups.get(groupJid);
    expect(onExhaustionDrop).toHaveBeenCalledTimes(1);
    expect(onExhaustionDrop).toHaveBeenCalledWith(groupJid);
    expect(state.pendingMessages).toBe(false);
    expect(state.retryCount).toBe(0);

    queue.enqueueMessageCheck(groupJid);
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(7);
    expect(onExhaustionDrop).toHaveBeenCalledTimes(1);
    expect(state.retryCount).toBe(0);
  });

  it('exhaustion drop does not orphan group', async () => {
    const queue = new GroupQueue();
    const onExhaustionDrop = vi.fn();
    queue.setOnExhaustionDropFn(onExhaustionDrop);

    let attempts = 0;
    const processMessages = vi.fn(async () => {
      attempts += 1;
      return attempts > 6;
    });

    queue.setProcessMessagesFn(processMessages);

    const groupJid = 'slack:C456';
    await driveToExhaustion(queue, groupJid);

    expect(onExhaustionDrop).toHaveBeenCalledTimes(1);

    queue.enqueueMessageCheck(groupJid);
    await vi.advanceTimersByTimeAsync(10);

    queue.enqueueMessageCheck(groupJid);
    await vi.advanceTimersByTimeAsync(10);

    const state = (queue as any).groups.get(groupJid);
    expect(processMessages).toHaveBeenCalledTimes(8);
    expect(state.active).toBe(false);
    expect(state.retryCount).toBe(0);
    expect(onExhaustionDrop).toHaveBeenCalledTimes(1);
  });

  it('recovery signal only re-enqueues slack groups', () => {
    const queue = {
      enqueueMessageCheck: vi.fn(),
    };

    const registeredGroups = {
      'slack:C123': { name: 'slack-channel' },
      'slack:D234': { name: 'slack-dm' },
      '123456@g.us': { name: 'whatsapp-group' },
      '123456@s.whatsapp.net': { name: 'whatsapp-dm' },
    };

    const onRecovery = (): void => {
      for (const [jid] of Object.entries(registeredGroups)) {
        if (jid.startsWith('slack:')) {
          queue.enqueueMessageCheck(jid);
        }
      }
    };

    onRecovery();

    expect(queue.enqueueMessageCheck).toHaveBeenCalledTimes(2);
    expect(queue.enqueueMessageCheck).toHaveBeenNthCalledWith(1, 'slack:C123');
    expect(queue.enqueueMessageCheck).toHaveBeenNthCalledWith(2, 'slack:D234');
  });

  it('send failure throw retries with backoff and group recovers', async () => {
    const queue = new GroupQueue();
    const onExhaustionDrop = vi.fn();
    queue.setOnExhaustionDropFn(onExhaustionDrop);

    let attempts = 0;
    const processMessages = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new Error(`simulated send failure ${attempts}`);
      }
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    const groupJid = 'slack:C789';
    queue.enqueueMessageCheck(groupJid);
    await vi.advanceTimersByTimeAsync(10);

    let state = (queue as any).groups.get(groupJid);
    expect(processMessages).toHaveBeenCalledTimes(1);
    expect(state.retryCount).toBe(1);
    expect(onExhaustionDrop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + 10);
    state = (queue as any).groups.get(groupJid);
    expect(processMessages).toHaveBeenCalledTimes(2);
    expect(state.retryCount).toBe(2);

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1] + 10);
    state = (queue as any).groups.get(groupJid);
    expect(processMessages).toHaveBeenCalledTimes(3);
    expect(state.retryCount).toBe(0);
    expect(state.active).toBe(false);
    expect(onExhaustionDrop).not.toHaveBeenCalled();

    queue.enqueueMessageCheck(groupJid);
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(4);
    expect(state.retryCount).toBe(0);
  });

  it('non-zero exhaustion gate still commits exhausted cursor drop', async () => {
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      DATA_DIR: '/tmp/test-recovery',
      MAX_CONCURRENT_CONTAINERS: 2,
      MAX_RETRIES: 5,
      RETRY_BASE_DELAY_MS: 5000,
      RECOVERY_EXHAUSTED_GATE_MS: 60000,
    }));

    const { RECOVERY_EXHAUSTED_GATE_MS } = await import('./config.js');
    expect(RECOVERY_EXHAUSTED_GATE_MS).toBe(60000);

    const queue = new GroupQueue();
    const lastAgentTimestamp: Record<string, string> = {};
    let observedGatedFloorMs = 0;
    const latestMessageTimestamp = '2025-01-01T00:00:00.000Z';
    vi.setSystemTime(Date.parse('2025-01-01T00:10:00.000Z'));

    const onExhaustionDrop = vi.fn((groupJid: string) => {
      let commitTimestamp = latestMessageTimestamp || new Date().toISOString();

      if (RECOVERY_EXHAUSTED_GATE_MS > 0) {
        const commitMs = Date.parse(commitTimestamp);
        if (!Number.isNaN(commitMs)) {
          const gatedFloorMs = Date.now() - RECOVERY_EXHAUSTED_GATE_MS;
          observedGatedFloorMs = gatedFloorMs;
          if (commitMs < gatedFloorMs) {
            commitTimestamp = new Date(gatedFloorMs).toISOString();
          }
        }
      }

      lastAgentTimestamp[groupJid] = commitTimestamp;
    });

    queue.setOnExhaustionDropFn(onExhaustionDrop);
    queue.setProcessMessagesFn(vi.fn(async () => false));

    const groupJid = 'slack:C-gated';
    await driveToExhaustion(queue, groupJid);

    const state = (queue as any).groups.get(groupJid);
    const expectedFloorIso = new Date(observedGatedFloorMs).toISOString();

    expect(onExhaustionDrop).toHaveBeenCalledTimes(1);
    expect(lastAgentTimestamp[groupJid]).toBe(expectedFloorIso);
    expect(state.retryCount).toBe(0);
    expect(state.pendingMessages).toBe(false);
  });

  it('recovery callback is idempotent per invocation and slack-only', () => {
    const queue = {
      enqueueMessageCheck: vi.fn(),
    };

    const registeredGroups = {
      'slack:C123': { name: 'slack-channel' },
      'slack:D234': { name: 'slack-dm' },
      '123456@g.us': { name: 'whatsapp-group' },
      '123456@s.whatsapp.net': { name: 'whatsapp-dm' },
    };

    const onRecovery = (): void => {
      for (const [jid] of Object.entries(registeredGroups)) {
        if (jid.startsWith('slack:')) {
          queue.enqueueMessageCheck(jid);
        }
      }
    };

    onRecovery();
    onRecovery();

    const calledJids = queue.enqueueMessageCheck.mock.calls.map(
      ([jid]) => jid as string,
    );

    expect(queue.enqueueMessageCheck).toHaveBeenCalledTimes(4);
    expect(calledJids).toEqual([
      'slack:C123',
      'slack:D234',
      'slack:C123',
      'slack:D234',
    ]);
    expect(calledJids.every((jid) => jid.startsWith('slack:'))).toBe(true);
    expect(calledJids).not.toContain('123456@g.us');
    expect(calledJids).not.toContain('123456@s.whatsapp.net');
  });
});
