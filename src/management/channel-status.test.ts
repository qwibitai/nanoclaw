import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChannelStatusReporter } from './channel-status.js';

describe('ChannelStatusReporter', () => {
  it('should report status of all registered channels', () => {
    const mockChannels = new Map([
      ['telegram', { isConnected: () => true }],
      ['discord', { isConnected: () => false }],
    ]);

    const reporter = new ChannelStatusReporter(mockChannels as any);
    const status = reporter.getStatus();

    expect(status.channels).toHaveLength(2);
    expect(status.channels).toContainEqual({
      id: 'telegram',
      connected: true,
      error: undefined,
    });
    expect(status.channels).toContainEqual({
      id: 'discord',
      connected: false,
      error: undefined,
    });
  });

  it('should emit periodic status events', async () => {
    const mockChannels = new Map([['telegram', { isConnected: () => true }]]);
    const emitFn = vi.fn();

    const reporter = new ChannelStatusReporter(mockChannels as any, {
      intervalMs: 50,
      emit: emitFn,
    });

    reporter.start();
    await new Promise((r) => setTimeout(r, 120));
    reporter.stop();

    expect(emitFn).toHaveBeenCalledWith(
      'channels.status',
      expect.objectContaining({
        channels: expect.arrayContaining([
          expect.objectContaining({ id: 'telegram', connected: true }),
        ]),
      }),
    );
    expect(emitFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
