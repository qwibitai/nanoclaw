import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { eventBus } from '../event-bus.js';
import { evaluateWatcher, type WatcherConfig } from './browser-watcher.js';

const mockEmit = vi.mocked(eventBus.emit);

const baseConfig: WatcherConfig = {
  id: 'watcher-1',
  url: 'https://example.com',
  selector: '.price',
  groupId: 'group-abc',
  intervalMs: 60_000,
};

beforeEach(() => {
  mockEmit.mockClear();
});

describe('evaluateWatcher', () => {
  it('detects a change when the extracted value differs from the previous value', async () => {
    const extract = vi.fn().mockResolvedValue('$42.00');

    const result = await evaluateWatcher(baseConfig, '$40.00', extract);

    expect(result.changed).toBe(true);
    expect(result.newValue).toBe('$42.00');
    expect(result.previousValue).toBe('$40.00');
    expect(result.error).toBeUndefined();

    expect(mockEmit).toHaveBeenCalledOnce();
    const [eventType, event] = mockEmit.mock.calls[0];
    expect(eventType).toBe('watcher.changed');
    expect(event.payload).toMatchObject({
      watcherId: baseConfig.id,
      url: baseConfig.url,
      selector: baseConfig.selector,
      previousValue: '$40.00',
      newValue: '$42.00',
      groupId: baseConfig.groupId,
    });
  });

  it('reports no change when the extracted value matches the previous value', async () => {
    const extract = vi.fn().mockResolvedValue('$40.00');

    const result = await evaluateWatcher(baseConfig, '$40.00', extract);

    expect(result.changed).toBe(false);
    expect(result.newValue).toBe('$40.00');
    expect(result.previousValue).toBe('$40.00');
    expect(result.error).toBeUndefined();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('handles a null previousValue correctly — treats any extracted value as a change', async () => {
    const extract = vi.fn().mockResolvedValue('first-value');

    const result = await evaluateWatcher(baseConfig, null, extract);

    expect(result.changed).toBe(true);
    expect(result.newValue).toBe('first-value');
    expect(result.previousValue).toBeNull();
    expect(mockEmit).toHaveBeenCalledOnce();
  });

  it('returns changed=false and an error message when extraction throws', async () => {
    const extract = vi.fn().mockRejectedValue(new Error('network timeout'));

    const result = await evaluateWatcher(baseConfig, '$40.00', extract);

    expect(result.changed).toBe(false);
    expect(result.newValue).toBeNull();
    expect(result.previousValue).toBe('$40.00');
    expect(result.error).toBe('network timeout');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('coerces non-Error thrown values to a string in the error field', async () => {
    const extract = vi.fn().mockRejectedValue('plain string error');

    const result = await evaluateWatcher(baseConfig, null, extract);

    expect(result.changed).toBe(false);
    expect(result.error).toBe('plain string error');
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
