import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger before importing EventBus
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { EventBus } from './event-bus.js';
import type { MessageInboundEvent, SystemErrorEvent, SystemStartupEvent } from './events.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('emits and receives typed events', () => {
    const handler = vi.fn();
    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    bus.on('message.inbound', handler);
    bus.emit('message.inbound', event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not crash when a handler throws', () => {
    bus.on('message.inbound', () => {
      throw new Error('handler exploded');
    });

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    // Should not throw
    expect(() => bus.emit('message.inbound', event)).not.toThrow();
  });

  it('emits system.error when handler throws', () => {
    const errorHandler = vi.fn();
    bus.on('system.error', errorHandler);

    bus.on('message.inbound', () => {
      throw new Error('boom');
    });

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    bus.emit('message.inbound', event);

    expect(errorHandler).toHaveBeenCalledOnce();
    const errorEvent = errorHandler.mock.calls[0][0] as SystemErrorEvent;
    expect(errorEvent.type).toBe('system.error');
    expect(errorEvent.source).toBe('event-bus');
    expect(errorEvent.payload.error).toBe('boom');
    expect(errorEvent.payload.originalEvent).toBe('message.inbound');
  });

  it('does not recurse when system.error handler throws', () => {
    bus.on('system.error', () => {
      throw new Error('error handler also exploded');
    });

    bus.on('message.inbound', () => {
      throw new Error('original error');
    });

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    // Should not throw or recurse infinitely
    expect(() => bus.emit('message.inbound', event)).not.toThrow();
  });

  it('supports multiple handlers for same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('message.inbound', handler1);
    bus.on('message.inbound', handler2);

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    bus.emit('message.inbound', event);

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it('supports unsubscribing', () => {
    const handler = vi.fn();
    const unsub = bus.on('message.inbound', handler);

    unsub();

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    bus.emit('message.inbound', event);

    expect(handler).not.toHaveBeenCalled();
  });

  it('onAny receives all events', () => {
    const anyHandler = vi.fn();
    bus.onAny(anyHandler);

    const inboundEvent: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    const startupEvent: SystemStartupEvent = {
      type: 'system.startup',
      source: 'orchestrator',
      timestamp: Date.now(),
      payload: { channels: ['whatsapp'], groupCount: 3 },
    };

    bus.emit('message.inbound', inboundEvent);
    bus.emit('system.startup', startupEvent);

    expect(anyHandler).toHaveBeenCalledTimes(2);
    expect(anyHandler).toHaveBeenCalledWith(inboundEvent);
    expect(anyHandler).toHaveBeenCalledWith(startupEvent);
  });

  it('onAny supports unsubscribing', () => {
    const anyHandler = vi.fn();
    const unsub = bus.onAny(anyHandler);

    unsub();

    const event: MessageInboundEvent = {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'test@jid', channel: 'whatsapp', messageCount: 1 },
    };

    bus.emit('message.inbound', event);

    expect(anyHandler).not.toHaveBeenCalled();
  });
});
