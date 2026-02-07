import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BaseChannel,
  ChannelConfig,
  InboundMessage,
} from '../src/channels/base.js';
import { ChannelManager } from '../src/channels/manager.js';
import { MessageBus } from '../src/message-bus.js';

// ---------- Concrete test channel extending BaseChannel ----------

class TestChannel extends BaseChannel {
  public started = false;
  public stopped = false;
  public sentMessages: Array<{ chatId: string; text: string }> = [];

  constructor(config: ChannelConfig) {
    super('test', config);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
  }

  /** Expose emitMessage so tests can invoke it directly */
  public testEmitMessage(msg: InboundMessage): void {
    this.emitMessage(msg);
  }
}

// ---------- Helper to create an InboundMessage ----------

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    channel: 'test',
    chatId: 'chat-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'hello',
    timestamp: new Date().toISOString(),
    isFromMe: false,
    ...overrides,
  };
}

// ---------- BaseChannel tests ----------

describe('BaseChannel', () => {
  describe('isAllowed()', () => {
    it('allows all senders when allowedUsers is empty', () => {
      const channel = new TestChannel({ enabled: true, allowedUsers: [] });

      expect(channel.isAllowed('anyone')).toBe(true);
      expect(channel.isAllowed('random-id')).toBe(true);
      expect(channel.isAllowed('')).toBe(true);
    });

    it('allows only listed senders when allowedUsers is non-empty', () => {
      const channel = new TestChannel({
        enabled: true,
        allowedUsers: ['user-a', 'user-b'],
      });

      expect(channel.isAllowed('user-a')).toBe(true);
      expect(channel.isAllowed('user-b')).toBe(true);
      expect(channel.isAllowed('user-c')).toBe(false);
      expect(channel.isAllowed('')).toBe(false);
    });
  });

  describe('emitMessage()', () => {
    it('emits a message event for an allowed sender', () => {
      const channel = new TestChannel({ enabled: true, allowedUsers: [] });
      const handler = vi.fn();
      channel.on('message', handler);

      const msg = makeMessage({ senderId: 'allowed-user' });
      channel.testEmitMessage(msg);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(msg);
    });

    it('silently drops messages from disallowed senders', () => {
      const channel = new TestChannel({
        enabled: true,
        allowedUsers: ['user-a'],
      });
      const handler = vi.fn();
      channel.on('message', handler);

      const msg = makeMessage({ senderId: 'user-b' });
      channel.testEmitMessage(msg);

      expect(handler).not.toHaveBeenCalled();
    });

    it('emits when sender is in the allowedUsers list', () => {
      const channel = new TestChannel({
        enabled: true,
        allowedUsers: ['user-x'],
      });
      const handler = vi.fn();
      channel.on('message', handler);

      const msg = makeMessage({ senderId: 'user-x' });
      channel.testEmitMessage(msg);

      expect(handler).toHaveBeenCalledOnce();
    });
  });
});

// ---------- ChannelManager tests ----------

describe('ChannelManager', () => {
  let bus: MessageBus;
  let manager: ChannelManager;

  beforeEach(() => {
    // Create a real MessageBus but spy on its methods
    bus = new MessageBus();
    vi.spyOn(bus, 'onOutbound');
    vi.spyOn(bus, 'publishInbound');
    manager = new ChannelManager(bus);
  });

  it('registers a channel via addChannel', () => {
    const channel = new TestChannel({ enabled: true, allowedUsers: [] });
    manager.addChannel(channel);

    const retrieved = manager.getChannel('test');
    expect(retrieved).toBe(channel);
  });

  it('retrieves a channel by type with getChannel', () => {
    const channel1 = new TestChannel({ enabled: true, allowedUsers: [] });
    // Create a second channel type by subclassing with a different type
    const channel2 = new (class extends TestChannel {
      constructor() {
        super({ enabled: true, allowedUsers: [] });
        (this as any).channelType = 'test2';
      }
    })();
    // Need to set channelType since it's readonly - use Object.defineProperty
    Object.defineProperty(channel2, 'channelType', { value: 'test2' });

    manager.addChannel(channel1);
    manager.addChannel(channel2);

    expect(manager.getChannel('test')).toBe(channel1);
    expect(manager.getChannel('test2')).toBe(channel2);
  });

  it('returns undefined for an unregistered channel type', () => {
    expect(manager.getChannel('nonexistent')).toBeUndefined();
  });

  it('forwards inbound channel messages to the message bus', () => {
    const channel = new TestChannel({ enabled: true, allowedUsers: [] });
    manager.addChannel(channel);

    const msg = makeMessage();
    channel.testEmitMessage(msg);

    expect(bus.publishInbound).toHaveBeenCalledOnce();
    expect(bus.publishInbound).toHaveBeenCalledWith(msg);
  });

  it('subscribes to outbound messages on the bus', () => {
    // The constructor should have called bus.onOutbound
    expect(bus.onOutbound).toHaveBeenCalledOnce();
  });
});
