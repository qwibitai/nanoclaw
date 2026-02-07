import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from '../src/message-bus.js';
import type { InboundMessage, OutboundMessage } from '../src/channels/base.js';

// Mock the logger so tests don't produce output or require pino-pretty
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

/** Create a minimal valid InboundMessage for testing. */
function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    channel: 'test-channel',
    chatId: 'chat-1',
    senderId: 'user-1',
    senderName: 'Test User',
    content: 'hello world',
    timestamp: new Date().toISOString(),
    isFromMe: false,
    ...overrides,
  };
}

/** Create a minimal valid OutboundMessage for testing. */
function makeOutbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: 'test-channel',
    chatId: 'chat-1',
    content: 'reply text',
    ...overrides,
  };
}

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  // ── Inbound ────────────────────────────────────────────────────────────

  describe('publishInbound', () => {
    it('delivers a message to a registered inbound handler', () => {
      const handler = vi.fn();
      bus.onInbound(handler);

      const msg = makeInbound();
      bus.publishInbound(msg);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(msg);
    });

    it('delivers a message to multiple registered inbound handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();
      bus.onInbound(handler1);
      bus.onInbound(handler2);
      bus.onInbound(handler3);

      const msg = makeInbound();
      bus.publishInbound(msg);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledWith(msg);
      expect(handler2).toHaveBeenCalledWith(msg);
      expect(handler3).toHaveBeenCalledWith(msg);
    });

    it('does not throw when there are no registered handlers', () => {
      const msg = makeInbound();
      expect(() => bus.publishInbound(msg)).not.toThrow();
    });

    it('isolates handler errors so other handlers still run', () => {
      const handler1 = vi.fn();
      const throwingHandler = vi.fn(() => {
        throw new Error('handler blew up');
      });
      const handler3 = vi.fn();

      bus.onInbound(handler1);
      bus.onInbound(throwingHandler);
      bus.onInbound(handler3);

      const msg = makeInbound();
      expect(() => bus.publishInbound(msg)).not.toThrow();

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(throwingHandler).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('passes the exact message object to each handler', () => {
      const handler = vi.fn();
      bus.onInbound(handler);

      const msg = makeInbound({ content: 'specific content', channel: 'whatsapp' });
      bus.publishInbound(msg);

      const received = handler.mock.calls[0][0] as InboundMessage;
      expect(received.content).toBe('specific content');
      expect(received.channel).toBe('whatsapp');
    });
  });

  // ── Outbound ───────────────────────────────────────────────────────────

  describe('publishOutbound', () => {
    it('delivers a message to a registered outbound handler', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.onOutbound(handler);

      const msg = makeOutbound();
      await bus.publishOutbound(msg);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(msg);
    });

    it('delivers a message to multiple registered outbound handlers', async () => {
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const handler2 = vi.fn().mockResolvedValue(undefined);
      const handler3 = vi.fn().mockResolvedValue(undefined);
      bus.onOutbound(handler1);
      bus.onOutbound(handler2);
      bus.onOutbound(handler3);

      const msg = makeOutbound();
      await bus.publishOutbound(msg);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledWith(msg);
      expect(handler2).toHaveBeenCalledWith(msg);
      expect(handler3).toHaveBeenCalledWith(msg);
    });

    it('does not throw when there are no registered handlers', async () => {
      const msg = makeOutbound();
      await expect(bus.publishOutbound(msg)).resolves.toBeUndefined();
    });

    it('isolates handler errors so other handlers still run', async () => {
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const throwingHandler = vi.fn().mockRejectedValue(new Error('send failed'));
      const handler3 = vi.fn().mockResolvedValue(undefined);

      bus.onOutbound(handler1);
      bus.onOutbound(throwingHandler);
      bus.onOutbound(handler3);

      const msg = makeOutbound();
      await expect(bus.publishOutbound(msg)).resolves.toBeUndefined();

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(throwingHandler).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('isolates synchronous throw from an outbound handler', async () => {
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const throwingHandler = vi.fn(() => {
        throw new Error('sync explosion');
      });
      const handler3 = vi.fn().mockResolvedValue(undefined);

      bus.onOutbound(handler1);
      bus.onOutbound(throwingHandler);
      bus.onOutbound(handler3);

      const msg = makeOutbound();
      await expect(bus.publishOutbound(msg)).resolves.toBeUndefined();

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(throwingHandler).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('awaits each handler sequentially', async () => {
      const callOrder: number[] = [];

      const handler1 = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(1);
      });
      const handler2 = vi.fn(async () => {
        callOrder.push(2);
      });

      bus.onOutbound(handler1);
      bus.onOutbound(handler2);

      await bus.publishOutbound(makeOutbound());

      expect(callOrder).toEqual([1, 2]);
    });

    it('passes the exact message object to each handler', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.onOutbound(handler);

      const msg = makeOutbound({ content: 'specific reply', channel: 'telegram' });
      await bus.publishOutbound(msg);

      const received = handler.mock.calls[0][0] as OutboundMessage;
      expect(received.content).toBe('specific reply');
      expect(received.channel).toBe('telegram');
    });
  });

  // ── Cross-cutting concerns ─────────────────────────────────────────────

  describe('handler registration', () => {
    it('keeps inbound and outbound handlers independent', async () => {
      const inHandler = vi.fn();
      const outHandler = vi.fn().mockResolvedValue(undefined);

      bus.onInbound(inHandler);
      bus.onOutbound(outHandler);

      bus.publishInbound(makeInbound());
      await bus.publishOutbound(makeOutbound());

      expect(inHandler).toHaveBeenCalledTimes(1);
      expect(outHandler).toHaveBeenCalledTimes(1);
    });

    it('does not call outbound handlers on inbound publish', () => {
      const outHandler = vi.fn().mockResolvedValue(undefined);
      bus.onOutbound(outHandler);

      bus.publishInbound(makeInbound());

      expect(outHandler).not.toHaveBeenCalled();
    });

    it('does not call inbound handlers on outbound publish', async () => {
      const inHandler = vi.fn();
      bus.onInbound(inHandler);

      await bus.publishOutbound(makeOutbound());

      expect(inHandler).not.toHaveBeenCalled();
    });
  });
});
