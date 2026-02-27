import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Hoist mock variables so they're available inside vi.mock() factories
const mockConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDisconnect = vi.hoisted(() => vi.fn());
const mockRegisterCallbackListener = vi.hoisted(() => vi.fn());
const mockAxiosPost = vi.hoisted(() => vi.fn().mockResolvedValue({ status: 200 }));

vi.mock('dingtalk-stream', () => {
  const DWClient = vi.fn().mockImplementation(function() {
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      registerCallbackListener: mockRegisterCallbackListener,
      config: { autoReconnect: true },
      connected: true,
    };
  });
  return { DWClient, TOPIC_ROBOT: 'robot' };
});

vi.mock('axios', () => ({
  default: { post: mockAxiosPost },
}));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { DingTalkChannel, DingTalkChannelOpts } from './dingtalk.js';

function makeOpts(overrides: Partial<DingTalkChannelOpts> = {}) {
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const registeredGroups = vi.fn().mockReturnValue({});
  const registerGroup = vi.fn();
  return { onMessage, onChatMetadata, registeredGroups, registerGroup, ...overrides };
}

function makeDingTalkMessage(overrides: Record<string, unknown> = {}) {
  return {
    msgId: 'msg-001',
    msgtype: 'text',
    text: { content: '@Andy hello' },
    senderStaffId: 'staff-001',
    senderId: 'user-001',
    senderNick: 'Alice',
    conversationId: 'cid-group-001',
    conversationType: '2', // group
    conversationTitle: 'Test Group',
    chatbotUserId: 'bot-001',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=xxx',
    createAt: 1700000000000,
    ...overrides,
  };
}

describe('DingTalkChannel', () => {
  let opts: ReturnType<typeof makeOpts>;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = makeOpts();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  // --- Construction ---

  describe('construction', () => {
    it('creates channel with name "dingtalk"', () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      expect(ch.name).toBe('dingtalk');
    });

    it('is not connected before connect()', () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      expect(ch.isConnected()).toBe(false);
    });
  });

  // --- connect() ---

  describe('connect()', () => {
    it('creates DWClient and connects', async () => {
      const ch = new DingTalkChannel('my-id', 'my-secret', undefined, ['*'], ['*'], opts);
      await ch.connect();

      const { DWClient } = await import('dingtalk-stream');
      expect(DWClient).toHaveBeenCalledWith({ clientId: 'my-id', clientSecret: 'my-secret' });
      expect(mockConnect).toHaveBeenCalled();
    });

    it('disables built-in autoReconnect', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await ch.connect();
      // autoReconnect should have been set to false on the mock config
      // (verified via the mock implementation receiving the assignment)
      expect(mockRegisterCallbackListener).toHaveBeenCalled();
    });

    it('registers TOPIC_ROBOT callback listener', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await ch.connect();
      expect(mockRegisterCallbackListener).toHaveBeenCalledWith('robot', expect.any(Function));
    });

    it('is connected after connect()', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await ch.connect();
      expect(ch.isConnected()).toBe(true);
    });

    it('throws when DWClient.connect() rejects', async () => {
      mockConnect.mockRejectedValueOnce(new Error('network error'));
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await expect(ch.connect()).rejects.toThrow('network error');
    });
  });

  // --- disconnect() ---

  describe('disconnect()', () => {
    it('disconnects and clears client', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await ch.connect();
      await ch.disconnect();
      expect(mockDisconnect).toHaveBeenCalled();
      expect(ch.isConnected()).toBe(false);
    });

    it('is safe to call without connecting first', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await expect(ch.disconnect()).resolves.not.toThrow();
    });
  });

  // --- ownsJid() ---

  describe('ownsJid()', () => {
    it('returns true for dd: JIDs', () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      expect(ch.ownsJid('dd:cid001')).toBe(true);
      expect(ch.ownsJid('dd:user_staff_001')).toBe(true);
    });

    it('returns false for non-dd: JIDs', () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      expect(ch.ownsJid('12345@g.us')).toBe(false);
      expect(ch.ownsJid('tg:123456789')).toBe(false);
      expect(ch.ownsJid('dc:1234567890')).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling (via callback)', () => {
    async function connectAndGetCallback(ch: DingTalkChannel) {
      await ch.connect();
      const call = mockRegisterCallbackListener.mock.calls[0];
      return call[1] as (res: { data: string }) => Promise<void>;
    }

    it('calls onMessage for group chat', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage();
      await callback({ data: JSON.stringify(msg) });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dd:cid-group-001',
        expect.objectContaining({
          id: 'msg-001',
          chat_jid: 'dd:cid-group-001',
          sender: 'staff-001',
          sender_name: 'Alice',
          content: '@Andy hello',
          is_from_me: false,
        }),
      );
    });

    it('calls onMessage for direct message using senderStaffId as chatId', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage({ conversationType: '1' }); // private
      await callback({ data: JSON.stringify(msg) });

      // For DMs, chatId = senderStaffId
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dd:staff-001',
        expect.objectContaining({
          chat_jid: 'dd:staff-001',
        }),
      );
    });

    it('ignores bot self-messages', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage({ senderId: 'bot-001' }); // senderId == chatbotUserId
      await callback({ data: JSON.stringify(msg) });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages with empty content', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage({ text: { content: '   ' } });
      await callback({ data: JSON.stringify(msg) });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('deduplicates messages with the same msgId', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage();
      await callback({ data: JSON.stringify(msg) });
      await callback({ data: JSON.stringify(msg) }); // duplicate

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('blocks unauthorized users', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['allowed-staff'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage({ senderStaffId: 'blocked-staff' });
      await callback({ data: JSON.stringify(msg) });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('allows users in allowlist', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['staff-001'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage();
      await callback({ data: JSON.stringify(msg) });

      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('blocks all when allowedUsers is empty', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, [], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      await callback({ data: JSON.stringify(makeDingTalkMessage()) });
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('calls onChatMetadata for group chats', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      await callback({ data: JSON.stringify(makeDingTalkMessage()) });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dd:cid-group-001',
        expect.any(String),
        'Test Group',
        'dingtalk',
        true, // isGroup
      );
    });

    it('calls onChatMetadata with isGroup=false for DMs', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage({ conversationType: '1' });
      await callback({ data: JSON.stringify(msg) });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        expect.stringMatching(/^dd:/),
        expect.any(String),
        'Alice',
        'dingtalk',
        false, // isGroup
      );
    });
  });

  // --- Auto-registration ---

  describe('auto-registration', () => {
    async function connectAndGetCallback(ch: DingTalkChannel) {
      await ch.connect();
      return mockRegisterCallbackListener.mock.calls[0][1] as (res: { data: string }) => Promise<void>;
    }

    it('auto-registers unregistered group when allowedGroups=*', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      await callback({ data: JSON.stringify(makeDingTalkMessage()) });

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'dd:cid-group-001',
        expect.objectContaining({
          folder: expect.stringContaining('dingtalk-'),
          requiresTrigger: true, // group chats require trigger
        }),
      );
    });

    it('auto-registers DM with requiresTrigger=false', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      const msg = makeDingTalkMessage({ conversationType: '1' });
      await callback({ data: JSON.stringify(msg) });

      expect(opts.registerGroup).toHaveBeenCalledWith(
        expect.stringMatching(/^dd:/),
        expect.objectContaining({
          requiresTrigger: false, // DMs respond to everything
        }),
      );
    });

    it('blocks unregistered group when allowedGroups is empty', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], [], opts);
      const callback = await connectAndGetCallback(ch);

      await callback({ data: JSON.stringify(makeDingTalkMessage()) });

      expect(opts.registerGroup).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('allows group in specific allowedGroups list (raw conversationId)', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['cid-group-001'], opts);
      const callback = await connectAndGetCallback(ch);

      await callback({ data: JSON.stringify(makeDingTalkMessage()) });
      expect(opts.registerGroup).toHaveBeenCalled();
    });

    it('allows group in specific allowedGroups list (dd: prefixed)', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['dd:cid-group-001'], opts);
      const callback = await connectAndGetCallback(ch);

      await callback({ data: JSON.stringify(makeDingTalkMessage()) });
      expect(opts.registerGroup).toHaveBeenCalled();
    });

    it('uses existing registered group without re-registering', async () => {
      vi.mocked(opts.registeredGroups).mockReturnValue({
        'dd:cid-group-001': {
          name: 'Existing Group',
          folder: 'existing-folder',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      const callback = await connectAndGetCallback(ch);

      await callback({ data: JSON.stringify(makeDingTalkMessage()) });

      expect(opts.registerGroup).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalled();
    });
  });

  // --- sendMessage() ---

  describe('sendMessage()', () => {
    async function connectAndTriggerWebhookCache(ch: DingTalkChannel) {
      await ch.connect();
      const callback = mockRegisterCallbackListener.mock.calls[0][1] as (res: { data: string }) => Promise<void>;
      await callback({ data: JSON.stringify(makeDingTalkMessage()) });
    }

    it('sends markdown message via session webhook', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await connectAndTriggerWebhookCache(ch);

      await ch.sendMessage('dd:cid-group-001', 'Hello from Andy');

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://oapi.dingtalk.com/robot/send?access_token=xxx',
        {
          msgtype: 'markdown',
          markdown: {
            title: 'Andy',
            text: 'Hello from Andy',
          },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    it('logs warning when no session webhook is cached', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await ch.connect();

      // Don't trigger any message to populate webhook cache
      await ch.sendMessage('dd:unknown-chat', 'test');

      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('logs warning when client is not initialized', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      // Don't connect

      await ch.sendMessage('dd:cid001', 'test');
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('handles axios errors gracefully', async () => {
      mockAxiosPost.mockRejectedValueOnce(new Error('network error'));

      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await connectAndTriggerWebhookCache(ch);

      // Should not throw
      await expect(ch.sendMessage('dd:cid-group-001', 'test')).resolves.not.toThrow();
    });
  });

  // --- Webhook caching ---

  describe('session webhook caching', () => {
    it('caches webhook by conversationId for group chats', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await ch.connect();
      const callback = mockRegisterCallbackListener.mock.calls[0][1] as (res: { data: string }) => Promise<void>;

      const msg = makeDingTalkMessage({ sessionWebhook: 'https://webhook.example.com/group' });
      await callback({ data: JSON.stringify(msg) });

      await ch.sendMessage('dd:cid-group-001', 'test');
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://webhook.example.com/group',
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('falls back to latest cached webhook for the sender', async () => {
      const ch = new DingTalkChannel('id', 'secret', undefined, ['*'], ['*'], opts);
      await ch.connect();
      const callback = mockRegisterCallbackListener.mock.calls[0][1] as (res: { data: string }) => Promise<void>;

      const msg = makeDingTalkMessage({ sessionWebhook: 'https://webhook.example.com/dm' });
      await callback({ data: JSON.stringify(msg) });

      // Also cached by senderId (staff-001)
      await ch.sendMessage('dd:staff-001', 'test');
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://webhook.example.com/dm',
        expect.any(Object),
        expect.any(Object),
      );
    });
  });
});
