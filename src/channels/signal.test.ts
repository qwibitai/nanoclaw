import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';
import { SignalChannel, SignalChannelOpts } from './signal.js';
import { RegisteredGroup } from '../types.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    ...overrides,
  };
}

// --- MockWebSocket ---

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState: number;
  url: string;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    // Simulate async open
    Promise.resolve().then(() => {
      if (this.onopen) this.onopen();
    });
  }

  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }
}

let mockWsInstance: MockWebSocket | null = null;

function installWsMock() {
  mockWsInstance = null;
  (globalThis as Record<string, unknown>).WebSocket = class extends (
    MockWebSocket
  ) {
    constructor(url: string) {
      super(url);
      mockWsInstance = this;
    }
  };
  // Expose static constants on the mock constructor
  (globalThis.WebSocket as unknown as typeof MockWebSocket).OPEN =
    MockWebSocket.OPEN;
  (globalThis.WebSocket as unknown as typeof MockWebSocket).CLOSED =
    MockWebSocket.CLOSED;
}

// --- Envelope factories ---

function make1to1Envelope(overrides?: Record<string, unknown>) {
  return {
    envelope: {
      source: '+15559876543',
      sourceNumber: '+15559876543',
      sourceUuid: 'uuid-alice',
      sourceName: 'Alice',
      sourceDevice: 1,
      timestamp: 1700000000000,
      dataMessage: {
        timestamp: 1700000000000,
        message: 'Hello from Signal',
        expiresInSeconds: 0,
        viewOnce: false,
      },
      ...overrides,
    },
    account: '+15551234567',
  };
}

function makeGroupEnvelope(overrides?: Record<string, unknown>) {
  return {
    envelope: {
      source: '+15559876543',
      sourceNumber: '+15559876543',
      sourceUuid: 'uuid-alice',
      sourceName: 'Alice',
      sourceDevice: 1,
      timestamp: 1700000000000,
      dataMessage: {
        timestamp: 1700000000000,
        message: 'Hello from group',
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: {
          groupId: 'dGVzdGdyb3VwMTIz',
          type: 'DELIVER',
        },
      },
      ...overrides,
    },
    account: '+15551234567',
  };
}

function createInboundTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  const groups: Record<string, RegisteredGroup> = {
    'sig:+15559876543': {
      name: 'Alice',
      folder: 'alice',
      trigger: '@Andy',
      added_at: '2024-01-01',
    },
    'sig:group:dGVzdGdyb3VwMTIz': {
      name: 'Test Group',
      folder: 'testgroup',
      trigger: '@Andy',
      added_at: '2024-01-01',
    },
  };
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => groups),
    ...overrides,
  };
}

// --- Tests ---

describe('SignalChannel factory registration', () => {
  it('calls registerChannel("signal", ...) on import', () => {
    expect(registerChannel).toHaveBeenCalledWith(
      'signal',
      expect.any(Function),
    );
  });

  it('factory returns null when SIGNAL_API_URL is missing', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      SIGNAL_PHONE_NUMBER: '+15550001234',
    });

    const [, factory] = vi
      .mocked(registerChannel)
      .mock.calls.find(([name]) => name === 'signal')!;

    const result = factory(createTestOpts());
    expect(result).toBeNull();
  });

  it('factory returns null when SIGNAL_PHONE_NUMBER is missing', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      SIGNAL_API_URL: 'http://localhost:8080',
    });

    const [, factory] = vi
      .mocked(registerChannel)
      .mock.calls.find(([name]) => name === 'signal')!;

    const result = factory(createTestOpts());
    expect(result).toBeNull();
  });
});

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.name).toBe('signal');
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns sig: prefixed JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.ownsJid('sig:+15550009999')).toBe(true);
    });

    it('owns sig:group: prefixed JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.ownsJid('sig:group:abc123')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15550001234',
        createTestOpts(),
      );
      expect(channel.isConnected()).toBe(false);
    });
  });
});

// --- Inbound message tests (polling mode) ---

describe('inbound messages', () => {
  const PHONE = '+15551234567';
  const API_URL = 'http://localhost:18080';

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  /** Mock fetch to return the given payloads once, then empty arrays */
  function mockPollResponse(...payloads: unknown[]) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payloads),
    });
  }

  /** Connect + trigger one poll cycle */
  async function connectAndPoll(channel: SignalChannel) {
    await channel.connect();
    // Advance past the poll interval to trigger poll()
    await vi.advanceTimersByTimeAsync(2100);
  }

  it('polls the correct URL', async () => {
    mockPollResponse();
    const channel = new SignalChannel(API_URL, PHONE, createInboundTestOpts());
    await connectAndPoll(channel);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `http://localhost:18080/v1/receive/${PHONE}`,
    );
    await channel.disconnect();
  });

  it('parses 1:1 text message and calls onMessage', async () => {
    const opts = createInboundTestOpts();
    mockPollResponse(make1to1Envelope());
    const channel = new SignalChannel(API_URL, PHONE, opts);
    await connectAndPoll(channel);

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'sig:+15559876543',
      expect.any(String),
      'Alice',
      'signal',
      false,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:+15559876543',
      expect.objectContaining({
        id: `1700000000000-+15559876543`,
        chat_jid: 'sig:+15559876543',
        sender: '+15559876543',
        sender_name: 'Alice',
        content: 'Hello from Signal',
        is_from_me: false,
      }),
    );
    await channel.disconnect();
  });

  it('parses group message and uses sig:group: JID', async () => {
    const opts = createInboundTestOpts();
    mockPollResponse(makeGroupEnvelope());
    const channel = new SignalChannel(API_URL, PHONE, opts);
    await connectAndPoll(channel);

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'sig:group:dGVzdGdyb3VwMTIz',
      expect.any(String),
      undefined,
      'signal',
      true,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:group:dGVzdGdyb3VwMTIz',
      expect.objectContaining({
        chat_jid: 'sig:group:dGVzdGdyb3VwMTIz',
        content: 'Hello from group',
      }),
    );
    await channel.disconnect();
  });

  it('ignores messages from unregistered chats', async () => {
    const opts = createInboundTestOpts();
    const envelope = make1to1Envelope({
      sourceNumber: '+15550000000',
      source: '+15550000000',
    });
    mockPollResponse(envelope);
    const channel = new SignalChannel(API_URL, PHONE, opts);
    await connectAndPoll(channel);

    expect(opts.onChatMetadata).toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('ignores envelopes without dataMessage', async () => {
    const opts = createInboundTestOpts();
    mockPollResponse({
      envelope: {
        source: '+15559876543',
        sourceNumber: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        typingMessage: { action: 'STARTED', timestamp: 1700000000000 },
      },
      account: PHONE,
    });
    const channel = new SignalChannel(API_URL, PHONE, opts);
    await connectAndPoll(channel);

    expect(opts.onChatMetadata).not.toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('ignores dataMessage with null message (e.g., reactions)', async () => {
    const opts = createInboundTestOpts();
    const envelope = make1to1Envelope();
    // @ts-expect-error — intentionally set message to null
    envelope.envelope.dataMessage.message = null;
    mockPollResponse(envelope);
    const channel = new SignalChannel(API_URL, PHONE, opts);
    await connectAndPoll(channel);

    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('marks messages from own number as is_from_me', async () => {
    const opts = createInboundTestOpts({
      registeredGroups: vi.fn(() => ({
        [`sig:${PHONE}`]: {
          name: 'Self',
          folder: 'self',
          trigger: '@Andy',
          added_at: '2024-01-01',
        },
      })),
    });
    const envelope = make1to1Envelope({
      sourceNumber: PHONE,
      source: PHONE,
      sourceName: 'Me',
    });
    mockPollResponse(envelope);
    const channel = new SignalChannel(API_URL, PHONE, opts);
    await connectAndPoll(channel);

    expect(opts.onMessage).toHaveBeenCalledWith(
      `sig:${PHONE}`,
      expect.objectContaining({ is_from_me: true }),
    );
    await channel.disconnect();
  });

  it('stores non-text attachments as placeholders', async () => {
    const opts = createInboundTestOpts();
    const envelope = make1to1Envelope();
    // @ts-expect-error — override message to null, add attachment
    envelope.envelope.dataMessage.message = null;
    // @ts-expect-error — add attachments
    envelope.envelope.dataMessage.attachments = [
      { contentType: 'image/jpeg', filename: 'photo.jpg' },
    ];
    mockPollResponse(envelope);
    const channel = new SignalChannel(API_URL, PHONE, opts);
    await connectAndPoll(channel);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:+15559876543',
      expect.objectContaining({ content: '[Photo]' }),
    );
    await channel.disconnect();
  });

  it('isConnected returns true after connect', async () => {
    mockPollResponse();
    const channel = new SignalChannel(API_URL, PHONE, createInboundTestOpts());
    expect(channel.isConnected()).toBe(false);
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
  });
});

// --- sendMessage tests ---

describe('sendMessage', () => {
  const PHONE = '+15551234567';
  const API_URL = 'http://localhost:18080';

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends 1:1 message via REST API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    globalThis.fetch = mockFetch;

    const channel = new SignalChannel(API_URL, PHONE, createTestOpts());
    await channel.sendMessage('sig:+15559876543', 'Hello');

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:18080/v2/send',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: '+15551234567',
          recipients: ['+15559876543'],
          message: 'Hello',
        }),
      }),
    );
  });

  it('sends group message via REST API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    globalThis.fetch = mockFetch;

    const channel = new SignalChannel(API_URL, PHONE, createTestOpts());
    await channel.sendMessage('sig:group:dGVzdGdyb3VwMTIz', 'Hello group');

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:18080/v2/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          number: '+15551234567',
          recipients: ['dGVzdGdyb3VwMTIz'],
          message: 'Hello group',
        }),
      }),
    );
  });

  it('splits messages over 4096 characters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    globalThis.fetch = mockFetch;

    const channel = new SignalChannel(API_URL, PHONE, createTestOpts());
    const longText = 'a'.repeat(5000);
    await channel.sendMessage('sig:+15559876543', longText);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(firstBody.message).toHaveLength(4096);
    expect(secondBody.message).toHaveLength(904);
  });

  it('sends exactly one message at 4096 characters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    globalThis.fetch = mockFetch;

    const channel = new SignalChannel(API_URL, PHONE, createTestOpts());
    const exactText = 'b'.repeat(4096);
    await channel.sendMessage('sig:+15559876543', exactText);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('handles send failure gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    globalThis.fetch = mockFetch;

    const channel = new SignalChannel(API_URL, PHONE, createTestOpts());
    await expect(
      channel.sendMessage('sig:+15559876543', 'Hello'),
    ).resolves.toBeUndefined();
  });
});

// --- setTyping tests ---

describe('setTyping', () => {
  const PHONE = '+15551234567';
  const API_URL = 'http://localhost:18080';

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends typing indicator for 1:1 chat', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const channel = new SignalChannel(API_URL, PHONE, createTestOpts());
    await channel.setTyping('sig:+15559876543', true);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      `http://localhost:18080/v1/typing-indicator/${PHONE}`,
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: '+15559876543' }),
      }),
    );
  });

  it('does nothing when isTyping is false', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    const channel = new SignalChannel(API_URL, PHONE, createTestOpts());
    await channel.setTyping('sig:+15559876543', false);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles typing failure gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    globalThis.fetch = mockFetch;

    const channel = new SignalChannel(API_URL, PHONE, createTestOpts());
    await expect(
      channel.setTyping('sig:+15559876543', true),
    ).resolves.toBeUndefined();
  });
});
