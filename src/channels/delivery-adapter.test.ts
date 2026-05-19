/**
 * Unit tests for the delivery-adapter bridge.
 *
 * Verifies:
 *   - deliver() throws MissingChannelAdapterError when no adapter is
 *     registered (instead of silently returning undefined and letting
 *     the caller markDelivered with platform_message_id=NULL).
 *   - deliver() forwards to the resolved adapter and returns its
 *     platform message id on the happy path.
 *   - deliver() parses the JSON content string before handing it to the
 *     adapter (preserves the existing contract).
 *   - deliver() propagates real adapter errors as-is (so the retry loop
 *     in delivery.ts handles them the way it always has).
 *   - setTyping() is tolerant of missing adapters (no throw, no-op).
 */
import { describe, expect, it, vi } from 'vitest';

import { createDeliveryAdapter, MissingChannelAdapterError } from './delivery-adapter.js';
import type { ChannelAdapter, OutboundFile } from './adapter.js';

function makeStubAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: 'stub',
    channelType: 'stub',
    supportsThreads: false,
    deliver: vi.fn().mockResolvedValue('stub-platform-id'),
    ...overrides,
  } as ChannelAdapter;
}

describe('createDeliveryAdapter — deliver()', () => {
  it('throws MissingChannelAdapterError when no adapter is registered', async () => {
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => null });

    let caught: unknown;
    try {
      await bridge.deliver('telegram', 'telegram:123', null, 'chat', '{"text":"hi"}');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingChannelAdapterError);
    expect((caught as MissingChannelAdapterError).channelType).toBe('telegram');
    expect((caught as Error).message).toMatch(/No adapter registered/i);
    expect((caught as Error).message).toMatch(/telegram/);
  });

  it('also throws when the registry returns undefined', async () => {
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => undefined });
    await expect(bridge.deliver('telegram', 'telegram:123', null, 'chat', '{"text":"hi"}')).rejects.toBeInstanceOf(
      MissingChannelAdapterError,
    );
  });

  it('forwards to the resolved adapter and returns its platform message id', async () => {
    const adapter = makeStubAdapter({
      deliver: vi.fn().mockResolvedValue('1805102895:42'),
    });
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => adapter });

    const result = await bridge.deliver('telegram', 'telegram:123', 'thread-1', 'chat', '{"text":"hello"}');

    expect(result).toBe('1805102895:42');
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver).toHaveBeenCalledWith('telegram:123', 'thread-1', {
      kind: 'chat',
      content: { text: 'hello' },
      files: undefined,
    });
  });

  it('passes file attachments through to the adapter unchanged', async () => {
    const adapter = makeStubAdapter();
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => adapter });
    const files: OutboundFile[] = [{ filename: 'a.png', data: Buffer.from('x') }];

    await bridge.deliver('telegram', 'telegram:123', null, 'chat', '{"text":"with file"}', files);

    expect(adapter.deliver).toHaveBeenCalledWith('telegram:123', null, {
      kind: 'chat',
      content: { text: 'with file' },
      files,
    });
  });

  it('parses the JSON content string before handing it to the adapter', async () => {
    const adapter = makeStubAdapter();
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => adapter });

    await bridge.deliver('telegram', 'telegram:123', null, 'chat', '{"nested":{"a":1},"arr":[2,3]}');

    const call = (adapter.deliver as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2].content).toEqual({ nested: { a: 1 }, arr: [2, 3] });
  });

  it('propagates real adapter errors as-is (so delivery.ts retry path runs)', async () => {
    const realErr = new Error('Telegram API getMe failed (status 401)');
    const adapter = makeStubAdapter({
      deliver: vi.fn().mockRejectedValue(realErr),
    });
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => adapter });

    await expect(bridge.deliver('telegram', 'telegram:123', null, 'chat', '{"text":"hi"}')).rejects.toBe(realErr);
  });

  it('resolves the adapter via the channelType argument, not a static reference', async () => {
    // Two adapters, one per channelType. The bridge should pick by argument,
    // not by closure capture — tests the DI seam.
    const tg = makeStubAdapter({ name: 'tg', channelType: 'telegram' });
    const slk = makeStubAdapter({ name: 'slk', channelType: 'slack' });
    const registry: Record<string, ChannelAdapter> = { telegram: tg, slack: slk };
    const bridge = createDeliveryAdapter({
      getChannelAdapter: (ct) => registry[ct] ?? null,
    });

    await bridge.deliver('slack', 'slack:C123', null, 'chat', '{"text":"hi"}');

    expect(slk.deliver).toHaveBeenCalledTimes(1);
    expect(tg.deliver).not.toHaveBeenCalled();
  });
});

describe('createDeliveryAdapter — setTyping()', () => {
  it('does not throw when no adapter is registered (typing is advisory)', async () => {
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => null });
    await expect(bridge.setTyping!('telegram', 'telegram:123', null)).resolves.toBeUndefined();
  });

  it('forwards to adapter.setTyping when present', async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const adapter = makeStubAdapter({ setTyping });
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => adapter });

    await bridge.setTyping!('telegram', 'telegram:123', 'thread-1');

    expect(setTyping).toHaveBeenCalledWith('telegram:123', 'thread-1');
  });

  it('is a no-op when adapter exists but does not implement setTyping', async () => {
    const adapter = makeStubAdapter({ setTyping: undefined });
    const bridge = createDeliveryAdapter({ getChannelAdapter: () => adapter });
    await expect(bridge.setTyping!('telegram', 'telegram:123', null)).resolves.toBeUndefined();
  });
});

describe('MissingChannelAdapterError', () => {
  it('carries the channelType and a useful message', () => {
    const err = new MissingChannelAdapterError('telegram');
    expect(err.channelType).toBe('telegram');
    expect(err.message).toContain('telegram');
    expect(err.name).toBe('MissingChannelAdapterError');
    expect(err).toBeInstanceOf(Error);
  });
});
