# Signal Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Signal as a messaging channel for NanoClaw using the bbernhard/signal-cli-rest-api Docker container as the protocol bridge, supporting both 1:1 and group chats.

**Architecture:** A `SignalChannel` class implements the `Channel` interface and communicates with a user-managed signal-cli-rest-api Docker container via WebSocket (inbound) and REST (outbound). Self-registers via the existing channel registry. No new npm dependencies — uses native Node.js `WebSocket` and `fetch`.

**Tech Stack:** TypeScript, Node.js native WebSocket (22+), signal-cli-rest-api REST/WS API, vitest for testing.

**Spec:** `docs/superpowers/specs/2026-04-12-signal-channel-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/channels/signal.ts` | SignalChannel class: WebSocket receive, REST send, self-registration |
| `src/channels/signal.test.ts` | Unit tests with mocked WebSocket and fetch |
| `src/channels/index.ts` | Add `import './signal.js'` to barrel file |
| `.env.example` | Add `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` entries |
| `.claude/skills/add-signal/SKILL.md` | Skill file for `/add-signal` setup workflow |

---

### Task 1: Signal Channel — Factory and Registration

**Files:**
- Create: `src/channels/signal.test.ts`
- Create: `src/channels/signal.ts`

- [ ] **Step 1: Write failing tests for factory registration**

Create `src/channels/signal.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

const mockRegisterChannel = vi.fn();
vi.mock('./registry.js', () => ({ registerChannel: mockRegisterChannel }));

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SignalChannel } from './signal.js';

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('factory registration', () => {
    it('calls registerChannel on import', () => {
      expect(mockRegisterChannel).toHaveBeenCalledWith(
        'signal',
        expect.any(Function),
      );
    });

    it('factory returns null when SIGNAL_API_URL is missing', () => {
      const factory = mockRegisterChannel.mock.calls[0][1];
      // No env vars set, readEnvFile returns {}
      const result = factory({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
      });
      expect(result).toBeNull();
    });
  });

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(
        'http://localhost:18080',
        '+15551234567',
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: vi.fn(() => ({})),
        },
      );
      expect(channel.name).toBe('signal');
    });
  });

  describe('ownsJid', () => {
    it('owns sig: prefixed JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:18080',
        '+15551234567',
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: vi.fn(() => ({})),
        },
      );
      expect(channel.ownsJid('sig:+15559876543')).toBe(true);
    });

    it('owns sig:group: prefixed JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:18080',
        '+15551234567',
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: vi.fn(() => ({})),
        },
      );
      expect(channel.ownsJid('sig:group:abc123==')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:18080',
        '+15551234567',
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: vi.fn(() => ({})),
        },
      );
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:18080',
        '+15551234567',
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: vi.fn(() => ({})),
        },
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      const channel = new SignalChannel(
        'http://localhost:18080',
        '+15551234567',
        {
          onMessage: vi.fn(),
          onChatMetadata: vi.fn(),
          registeredGroups: vi.fn(() => ({})),
        },
      );
      expect(channel.isConnected()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: FAIL — `./signal.js` does not exist

- [ ] **Step 3: Write minimal SignalChannel with factory**

Create `src/channels/signal.ts`:

```typescript
import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private apiUrl: string;
  private phoneNumber: string;
  private opts: SignalChannelOpts;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;

  constructor(apiUrl: string, phoneNumber: string, opts: SignalChannelOpts) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.phoneNumber = phoneNumber;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // WebSocket connection implemented in Task 2
    logger.info(
      { phone: this.phoneNumber },
      'Signal channel connected',
    );
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // REST send implemented in Task 3
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sig:');
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('Signal channel disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Typing indicator implemented in Task 4
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_API_URL', 'SIGNAL_PHONE_NUMBER']);
  const apiUrl =
    process.env.SIGNAL_API_URL || envVars.SIGNAL_API_URL || '';
  const phone =
    process.env.SIGNAL_PHONE_NUMBER || envVars.SIGNAL_PHONE_NUMBER || '';

  if (!apiUrl) {
    logger.warn('Signal: SIGNAL_API_URL not set');
    return null;
  }
  if (!phone) {
    logger.warn('Signal: SIGNAL_PHONE_NUMBER not set');
    return null;
  }

  return new SignalChannel(apiUrl, phone, opts);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat(signal): add SignalChannel skeleton with factory and JID ownership"
```

---

### Task 2: WebSocket Inbound Message Handling

**Files:**
- Modify: `src/channels/signal.test.ts`
- Modify: `src/channels/signal.ts`

- [ ] **Step 1: Write failing tests for inbound message parsing**

Add to the `describe('SignalChannel')` block in `src/channels/signal.test.ts`:

```typescript
// --- WebSocket mock ---

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    // Auto-trigger onopen on next tick
    setTimeout(() => this.onopen?.(), 0);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateMessage(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

// Store reference to the created WebSocket instance
let mockWsInstance: MockWebSocket | null = null;

// Patch global WebSocket before tests that need it
function installWsMock() {
  mockWsInstance = null;
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWsInstance = this;
    }
  };
  // Copy static properties
  (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;
  (globalThis as any).WebSocket.CLOSED = MockWebSocket.CLOSED;
}

function createTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'sig:+15559876543': {
        name: 'Signal DM',
        folder: 'signal_dm',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'sig:group:dGVzdGdyb3VwMTIz': {
        name: 'Signal Group',
        folder: 'signal_group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function make1to1Envelope(overrides?: Record<string, any>) {
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
        ...(overrides?.dataMessage || {}),
      },
      ...(overrides?.envelope || {}),
    },
    account: '+15551234567',
    ...(overrides?.top || {}),
  };
}

function makeGroupEnvelope(overrides?: Record<string, any>) {
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
        message: 'Hello group',
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: {
          groupId: 'dGVzdGdyb3VwMTIz',
          type: 'DELIVER',
        },
        ...(overrides?.dataMessage || {}),
      },
      ...(overrides?.envelope || {}),
    },
    account: '+15551234567',
    ...(overrides?.top || {}),
  };
}
```

Then add the test suite below the helpers:

```typescript
describe('inbound messages', () => {
  let originalWebSocket: any;

  beforeEach(() => {
    originalWebSocket = (globalThis as any).WebSocket;
    installWsMock();
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
  });

  it('connects WebSocket to correct URL', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    expect(mockWsInstance).not.toBeNull();
    expect(mockWsInstance!.url).toBe(
      'ws://localhost:18080/v1/receive/+15551234567',
    );
    await channel.disconnect();
  });

  it('parses 1:1 text message and calls onMessage', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    mockWsInstance!.simulateMessage(make1to1Envelope());

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
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    mockWsInstance!.simulateMessage(makeGroupEnvelope());

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
        sender: '+15559876543',
        sender_name: 'Alice',
        content: 'Hello group',
      }),
    );
    await channel.disconnect();
  });

  it('ignores messages from unregistered chats', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    const envelope = make1to1Envelope();
    envelope.envelope.source = '+19999999999';
    envelope.envelope.sourceNumber = '+19999999999';
    mockWsInstance!.simulateMessage(envelope);

    expect(opts.onChatMetadata).toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('ignores envelopes without dataMessage', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    mockWsInstance!.simulateMessage({
      envelope: {
        source: '+15559876543',
        sourceNumber: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        typingMessage: { action: 'STARTED', timestamp: 1700000000000 },
      },
      account: '+15551234567',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('ignores dataMessage with null message (e.g., reactions)', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    const envelope = make1to1Envelope({
      dataMessage: { message: null },
    });
    mockWsInstance!.simulateMessage(envelope);

    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('marks messages from own number as is_from_me', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({
        'sig:group:dGVzdGdyb3VwMTIz': {
          name: 'Signal Group',
          folder: 'signal_group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      })),
    });
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    // syncMessage from own device — source matches our phone number
    const envelope = makeGroupEnvelope();
    envelope.envelope.source = '+15551234567';
    envelope.envelope.sourceNumber = '+15551234567';
    envelope.envelope.sourceName = 'Me';
    mockWsInstance!.simulateMessage(envelope);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:group:dGVzdGdyb3VwMTIz',
      expect.objectContaining({
        is_from_me: true,
      }),
    );
    await channel.disconnect();
  });

  it('stores non-text attachments as placeholders', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    const envelope = make1to1Envelope({
      dataMessage: {
        message: null,
        attachments: [
          { contentType: 'image/jpeg', filename: 'photo.jpg', size: 12345 },
        ],
      },
    });
    mockWsInstance!.simulateMessage(envelope);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:+15559876543',
      expect.objectContaining({
        content: '[Photo]',
      }),
    );
    await channel.disconnect();
  });

  it('isConnected returns true after connect', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );
    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: FAIL — connect() doesn't open WebSocket, message handling not implemented

- [ ] **Step 3: Implement WebSocket connection and message parsing**

Update `src/channels/signal.ts` — replace the `connect()` method and add private helpers:

```typescript
async connect(): Promise<void> {
  this.closed = false;
  return this.openWebSocket();
}

private openWebSocket(): Promise<void> {
  return new Promise<void>((resolve) => {
    const wsUrl = this.apiUrl
      .replace(/^http/, 'ws') + `/v1/receive/${this.phoneNumber}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      logger.info({ phone: this.phoneNumber }, 'Signal WebSocket connected');
      resolve();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(
          typeof event.data === 'string' ? event.data : String(event.data),
        );
        this.handleEnvelope(data);
      } catch (err) {
        logger.debug({ err }, 'Signal: failed to parse WebSocket message');
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      logger.debug({ err }, 'Signal WebSocket error');
    };
  });
}

private scheduleReconnect(): void {
  if (this.closed) return;
  logger.debug(
    { delayMs: this.reconnectDelay },
    'Signal: scheduling reconnect',
  );
  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    this.openWebSocket().catch((err) =>
      logger.error({ err }, 'Signal: reconnect failed'),
    );
  }, this.reconnectDelay);
  this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
}

private handleEnvelope(data: any): void {
  const envelope = data?.envelope;
  if (!envelope) return;

  const dataMsg = envelope.dataMessage;
  if (!dataMsg) return;

  const sourceNumber: string =
    envelope.sourceNumber || envelope.source || '';
  const sourceName: string = envelope.sourceName || sourceNumber;
  const timestamp = new Date(envelope.timestamp).toISOString();

  // Determine JID and whether it's a group
  const groupId = dataMsg.groupInfo?.groupId;
  const isGroup = !!groupId;
  const chatJid = isGroup
    ? `sig:group:${groupId}`
    : `sig:${sourceNumber}`;

  // Emit chat metadata
  this.opts.onChatMetadata(
    chatJid,
    timestamp,
    isGroup ? undefined : sourceName,
    'signal',
    isGroup,
  );

  // Build content from message text or attachment placeholders
  const content = this.extractContent(dataMsg);
  if (!content) return;

  // Only deliver to registered groups
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) {
    logger.debug({ chatJid }, 'Message from unregistered Signal chat');
    return;
  }

  const isFromMe = sourceNumber === this.phoneNumber;

  this.opts.onMessage(chatJid, {
    id: `${envelope.timestamp}-${sourceNumber}`,
    chat_jid: chatJid,
    sender: sourceNumber,
    sender_name: sourceName,
    content,
    timestamp,
    is_from_me: isFromMe,
  });

  logger.info(
    { chatJid, sender: sourceName },
    'Signal message stored',
  );
}

private extractContent(dataMsg: any): string | null {
  if (dataMsg.message) return dataMsg.message;

  // Attachment placeholders
  const attachments: any[] = dataMsg.attachments || [];
  if (attachments.length > 0) {
    const first = attachments[0];
    const ct: string = first.contentType || '';
    if (ct.startsWith('image/')) return '[Photo]';
    if (ct.startsWith('video/')) return '[Video]';
    if (ct.startsWith('audio/')) return '[Voice message]';
    return `[Document: ${first.filename || 'file'}]`;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: All inbound message tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat(signal): implement WebSocket inbound message handling with reconnect"
```

---

### Task 3: REST Outbound Message Sending

**Files:**
- Modify: `src/channels/signal.test.ts`
- Modify: `src/channels/signal.ts`

- [ ] **Step 1: Write failing tests for sendMessage**

Add to `src/channels/signal.test.ts`:

```typescript
describe('sendMessage', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends 1:1 message via REST API', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );

    await channel.sendMessage('sig:+15559876543', 'Hello');

    expect(globalThis.fetch).toHaveBeenCalledWith(
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
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );

    await channel.sendMessage('sig:group:dGVzdGdyb3VwMTIz', 'Hello group');

    expect(globalThis.fetch).toHaveBeenCalledWith(
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
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );

    const longText = 'x'.repeat(5000);
    await channel.sendMessage('sig:+15559876543', longText);

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    const call1Body = JSON.parse(
      (globalThis.fetch as any).mock.calls[0][1].body,
    );
    const call2Body = JSON.parse(
      (globalThis.fetch as any).mock.calls[1][1].body,
    );
    expect(call1Body.message).toBe('x'.repeat(4096));
    expect(call2Body.message).toBe('x'.repeat(904));
  });

  it('sends exactly one message at 4096 characters', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );

    await channel.sendMessage('sig:+15559876543', 'y'.repeat(4096));

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('handles send failure gracefully', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(
      new Error('Network error'),
    );

    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );

    // Should not throw
    await expect(
      channel.sendMessage('sig:+15559876543', 'Will fail'),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: FAIL — sendMessage is a no-op stub

- [ ] **Step 3: Implement sendMessage**

Update `sendMessage` in `src/channels/signal.ts`:

```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  const MAX_LENGTH = 4096;

  try {
    const chunks =
      text.length <= MAX_LENGTH
        ? [text]
        : Array.from(
            { length: Math.ceil(text.length / MAX_LENGTH) },
            (_, i) => text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
          );

    for (const chunk of chunks) {
      const body = this.buildSendBody(jid, chunk);
      const res = await fetch(`${this.apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logger.warn(
          { jid, status: res.status },
          'Signal: send returned non-OK status',
        );
      }
    }

    logger.info({ jid, length: text.length }, 'Signal message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send Signal message');
  }
}

private buildSendBody(
  jid: string,
  message: string,
): Record<string, any> {
  if (jid.startsWith('sig:group:')) {
    const groupId = jid.slice('sig:group:'.length);
    return {
      number: this.phoneNumber,
      recipients: [groupId],
      message,
    };
  }
  const recipient = jid.slice('sig:'.length);
  return {
    number: this.phoneNumber,
    recipients: [recipient],
    message,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: All sendMessage tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat(signal): implement REST outbound message sending with chunking"
```

---

### Task 4: Typing Indicator

**Files:**
- Modify: `src/channels/signal.test.ts`
- Modify: `src/channels/signal.ts`

- [ ] **Step 1: Write failing tests for setTyping**

Add to `src/channels/signal.test.ts`:

```typescript
describe('setTyping', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends typing indicator for 1:1 chat', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );

    await channel.setTyping('sig:+15559876543', true);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:18080/v1/typing-indicator/+15551234567',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ recipient: '+15559876543' }),
      }),
    );
  });

  it('does nothing when isTyping is false', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );

    await channel.setTyping('sig:+15559876543', false);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('handles typing failure gracefully', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(
      new Error('Network error'),
    );

    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://localhost:18080',
      '+15551234567',
      opts,
    );

    await expect(
      channel.setTyping('sig:+15559876543', true),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: FAIL — setTyping is a no-op stub

- [ ] **Step 3: Implement setTyping**

Update `setTyping` in `src/channels/signal.ts`:

```typescript
async setTyping(jid: string, isTyping: boolean): Promise<void> {
  if (!isTyping) return;
  try {
    const recipient = jid.startsWith('sig:group:')
      ? jid.slice('sig:group:'.length)
      : jid.slice('sig:'.length);

    await fetch(
      `${this.apiUrl}/v1/typing-indicator/${this.phoneNumber}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient }),
      },
    );
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: All setTyping tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat(signal): add typing indicator support"
```

---

### Task 5: Barrel File and Env Example

**Files:**
- Modify: `src/channels/index.ts`
- Modify: `.env.example` (if it exists; create if not)

- [ ] **Step 1: Add signal import to barrel file**

In `src/channels/index.ts`, add after the `// whatsapp` import block:

```typescript
// signal
import './signal.js';
```

- [ ] **Step 2: Add env vars to .env.example**

Add to `.env.example` (create if missing):

```bash
# Signal (via signal-cli-rest-api Docker container)
# SIGNAL_API_URL=http://localhost:18080
# SIGNAL_PHONE_NUMBER=+1XXXXXXXXXX
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass including signal tests

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Clean build with no TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add src/channels/index.ts .env.example
git commit -m "feat(signal): register signal channel in barrel file and add env example"
```

---

### Task 6: `/add-signal` Skill

**Files:**
- Create: `.claude/skills/add-signal/SKILL.md`

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/add-signal/SKILL.md`:

````markdown
---
name: add-signal
description: Add Signal as a channel using signal-cli-rest-api Docker container. Supports 1:1 and group chats via device linking (no separate phone number needed).
---

# Add Signal Channel

This skill adds Signal support to NanoClaw via the signal-cli-rest-api Docker container, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/signal.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

AskUserQuestion: Do you have a signal-cli-rest-api Docker container running, or do you need to set one up?

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `signal` is missing, add it:

```bash
git remote add signal https://github.com/qwibitai/nanoclaw-signal.git
```

### Merge the skill branch

```bash
git fetch signal main
git merge signal/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/signal.ts` (SignalChannel class with self-registration via `registerChannel`)
- `src/channels/signal.test.ts` (unit tests with mocked WebSocket and fetch)
- `import './signal.js'` appended to the channel barrel file `src/channels/index.ts`
- `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/signal.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Docker Setup

### Install Docker container

If the user doesn't have the container running:

> I'll set up the signal-cli-rest-api Docker container for you.

```bash
mkdir -p ~/.config/nanoclaw/signal-cli

docker run -d --name signal-api \
  --restart unless-stopped \
  -p 18080:8080 \
  -v $HOME/.config/nanoclaw/signal-cli:/home/.local/share/signal-cli \
  -e MODE=native \
  bbernhard/signal-cli-rest-api
```

Wait a few seconds for it to start, then verify:

```bash
curl -s http://localhost:18080/v1/about | head -20
```

### Link as secondary device

Tell the user:

> I need you to link this Signal API to your Signal account (like adding Signal Desktop):
>
> 1. Open this URL in your browser:
>    `http://localhost:18080/v1/qrcodelink?device_name=NanoClaw`
> 2. It will show a QR code
> 3. On your phone: Signal > Settings > Linked Devices > Link New Device
> 4. Scan the QR code
>
> Once linked, tell me your phone number (the one registered with Signal).

Wait for the user to complete linking and provide their phone number.

### Verify linking

```bash
curl -s http://localhost:18080/v1/about
```

Should show the linked account.

## Phase 4: Configure Environment

### Set environment variables

Add to `.env`:

```bash
SIGNAL_API_URL=http://localhost:18080
SIGNAL_PHONE_NUMBER=<their-phone-number>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 5: Registration

### Get Chat ID

For **1:1 chats**, the JID is `sig:<phone-number>` (e.g., `sig:+15559876543`). Ask the user which phone number they want to chat with.

For **group chats**, list groups via the API:

```bash
curl -s "http://localhost:18080/v1/groups/<phone-number>" | python3 -m json.tool
```

Each group has an `id` field (base64). The JID is `sig:group:<id>`.

### Register the chat

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "sig:<id>" --name "<chat-name>" --folder "signal_main" --trigger "@${ASSISTANT_NAME}" --channel signal --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "sig:<id>" --name "<chat-name>" --folder "signal_<name>" --trigger "@${ASSISTANT_NAME}" --channel signal
```

## Phase 6: Verify

### Test the connection

Tell the user:

> Send a message from Signal:
> - For main chat: Any message works
> - For non-main: Include `@Andy` (or your assistant's trigger) in the message
>
> The assistant should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i signal
```

## Troubleshooting

### Bot not responding

Check:
1. Docker container is running: `docker ps | grep signal-api`
2. `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` are set in `.env` AND synced to `data/env/env`
3. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'sig:%'"`
4. WebSocket is connected: `tail -f logs/nanoclaw.log | grep -i "signal.*connect"`
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Signal API not reachable

```bash
curl -s http://localhost:18080/v1/about
```

If it fails, check Docker: `docker logs signal-api`

### Device linking expired

Signal device links expire after ~60 seconds. If linking failed:
1. Restart the container: `docker restart signal-api`
2. Try the QR code link again

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Removal

To remove Signal integration:

1. Delete `src/channels/signal.ts` and `src/channels/signal.test.ts`
2. Remove `import './signal.js'` from `src/channels/index.ts`
3. Remove `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` from `.env`
4. Remove Signal registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'sig:%'"`
5. Stop container: `docker stop signal-api && docker rm signal-api`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
````

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-signal/SKILL.md
git commit -m "feat(signal): add /add-signal skill for setup workflow"
```

---

### Task 7: Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests pass, all new signal tests pass

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean TypeScript compilation

- [ ] **Step 3: Run linter**

Run: `npm run lint`
Expected: No lint errors in signal.ts

- [ ] **Step 4: Verify channel loads without crashing (no credentials)**

Run: `SIGNAL_API_URL= SIGNAL_PHONE_NUMBER= npx tsx -e "import './src/channels/signal.js'"`
Expected: Logs warning about missing credentials, does not crash

- [ ] **Step 5: Final commit if any fixes needed**

If any issues were found and fixed in prior steps, commit them:

```bash
git add -A
git commit -m "fix(signal): address integration test findings"
```
