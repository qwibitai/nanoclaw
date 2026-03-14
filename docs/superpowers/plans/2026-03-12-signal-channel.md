# Signal Channel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Signal as a messaging channel for NanoClaw with linked-device auth, Note to Self support, and voice transcription.

**Architecture:** New `SignalChannel` class wrapping the `signal-sdk` npm package via the existing channel registry pattern. Transcription refactored to extract a shared `transcribeAudioFile()` function. Setup skill follows the `/add-whatsapp` pattern.

**Tech Stack:** TypeScript, signal-sdk (wraps signal-cli via JSON-RPC), vitest, whisper-cli

**Spec:** `docs/superpowers/specs/2026-03-12-signal-channel-design.md`

---

## Chunk 0: Branch Setup

### Task 0: Create feature branch

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/signal-channel
```

This ensures all Signal work lives on a dedicated branch, keeping `main` clean for upstream sync.

---

## Chunk 1: Transcription Refactor

Refactor `src/transcription.ts` to extract the whisper-cli invocation into a channel-agnostic function. WhatsApp continues working identically. This unblocks Signal voice transcription in Chunk 2.

### Task 1: Extract `transcribeAudioFile()` from transcription.ts

**Files:**
- Modify: `src/transcription.ts`
- Modify: `src/channels/whatsapp.ts` (update import if needed)

**Context:** Currently `transcription.ts` exports two functions:
- `transcribeAudioMessage(msg: WAMessage, sock: WASocket)` — downloads audio via Baileys, then calls private `transcribeWithWhisperCpp(buffer)`
- `isVoiceMessage(msg: WAMessage)` — checks `msg.message?.audioMessage?.ptt`

Both are tightly coupled to WhatsApp/Baileys types. We need to extract the whisper-cli invocation so Signal can use it too.

- [ ] **Step 1: Write the failing test for `transcribeAudioFile`**

Create a test that imports the new function. The existing test mocks (`vi.mock('../transcription.js', ...)`) in `whatsapp.test.ts` should still work after this change since we're only adding an export.

Add to a new test file `src/transcription.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';

// Mock child_process.execFile — let promisify work naturally
vi.mock('child_process', () => {
  const mockExecFile = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: any,
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // Default: resolve with empty output
      if (cb) cb(null, { stdout: '', stderr: '' });
    },
  );
  return { execFile: mockExecFile };
});

// Mock Baileys to avoid import errors (transcription.ts imports it)
vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: vi.fn(),
}));

import { transcribeAudioFile } from './transcription.js';

describe('transcribeAudioFile', () => {
  const mockExec = vi.mocked(execFile);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converts audio to WAV and runs whisper-cli', async () => {
    // ffmpeg call succeeds (1st call), whisper-cli returns transcript (2nd call)
    mockExec
      .mockImplementationOnce((_cmd, _args, _opts, cb: any) =>
        cb(null, { stdout: '', stderr: '' }),
      )
      .mockImplementationOnce((_cmd, _args, _opts, cb: any) =>
        cb(null, { stdout: 'Hello this is a test transcript', stderr: '' }),
      );

    const result = await transcribeAudioFile('/tmp/test-audio.ogg');

    expect(result).toBe('Hello this is a test transcript');
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0][0]).toBe('ffmpeg');
    expect(mockExec.mock.calls[1][0]).toBe('whisper-cli');
  });

  it('returns null when whisper-cli produces empty output', async () => {
    mockExec
      .mockImplementationOnce((_cmd, _args, _opts, cb: any) =>
        cb(null, { stdout: '', stderr: '' }),
      )
      .mockImplementationOnce((_cmd, _args, _opts, cb: any) =>
        cb(null, { stdout: '   ', stderr: '' }),
      );

    const result = await transcribeAudioFile('/tmp/test-audio.ogg');
    expect(result).toBeNull();
  });

  it('returns null when ffmpeg fails', async () => {
    mockExec.mockImplementationOnce((_cmd, _args, _opts, cb: any) =>
      cb(new Error('ffmpeg not found'), { stdout: '', stderr: '' }),
    );

    const result = await transcribeAudioFile('/tmp/test-audio.ogg');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/transcription.test.ts`
Expected: FAIL — `transcribeAudioFile` is not exported from `./transcription.js`

- [ ] **Step 3: Refactor transcription.ts**

Rewrite `src/transcription.ts` to export a generic `transcribeAudioFile` alongside the existing WhatsApp-specific functions. The key change: extract the ffmpeg + whisper-cli pipeline from `transcribeWithWhisperCpp` into `transcribeAudioFile` which takes a file path instead of a Buffer.

```typescript
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  downloadMediaMessage,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

/**
 * Transcribe an audio file using whisper.cpp.
 * Accepts any audio format ffmpeg can handle — converts to 16kHz mono WAV internally.
 * Returns the transcript text, or null if transcription fails.
 */
export async function transcribeAudioFile(
  filePath: string,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    // Convert to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync(
      'ffmpeg',
      ['-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const transcript = stdout.trim();
    return transcript || null;
  } catch (err) {
    console.error('whisper.cpp transcription failed:', err);
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpWav);
    } catch {
      /* best effort cleanup */
    }
  }
}

/**
 * Transcribe a WhatsApp voice message.
 * Downloads the audio via Baileys, writes to a temp file, and calls transcribeAudioFile.
 */
export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-wa-voice-${Date.now()}`;
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return FALLBACK_MESSAGE;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    // Write buffer to temp file, then use the shared transcription function
    fs.writeFileSync(tmpOgg, buffer);
    const transcript = await transcribeAudioFile(tmpOgg);

    if (!transcript) {
      return FALLBACK_MESSAGE;
    }

    console.log(`Transcribed voice message: ${transcript.length} chars`);
    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return FALLBACK_MESSAGE;
  } finally {
    try {
      fs.unlinkSync(tmpOgg);
    } catch {
      /* best effort cleanup */
    }
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
```

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npx vitest run src/transcription.test.ts src/channels/whatsapp.test.ts`
Expected: All tests PASS. WhatsApp behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/transcription.ts src/transcription.test.ts
git commit -m "refactor: extract transcribeAudioFile() for cross-channel voice transcription"
```

---

## Chunk 2: Signal Channel Implementation

The core channel — factory registration, connection, message handling, sending, voice transcription, outgoing queue.

### Task 2: Add signal-sdk dependency and verify API

**Important:** signal-sdk is a newer package. Before writing the implementation, verify the actual API matches our assumptions.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install signal-sdk**

```bash
npm install signal-sdk
```

**Note:** This triggers signal-sdk's postinstall script which downloads the signal-cli binary (~50MB). Requires Java 17+ on macOS. If Java is missing, the postinstall may warn but the package will still install — the binary just won't work until Java is available.

- [ ] **Step 2: Verify installation and inspect API**

```bash
node -e "const {SignalCli} = require('signal-sdk'); const s = new SignalCli('+0'); console.log('Methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(s)).join(', '))" 2>&1
```

Also read the type definitions to confirm the exact constructor signature and `sendMessage` args:

```bash
cat node_modules/signal-sdk/dist/index.d.ts | head -100
```

If the API differs from the plan (e.g., `sendMessage` takes an options object instead of positional args, or `SignalCli` requires a config object), **update Task 3's implementation code before proceeding**.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add signal-sdk for Signal channel integration"
```

### Task 3: Signal channel — factory + connection + ownsJid

**Files:**
- Create: `src/channels/signal.ts`
- Create: `src/channels/signal.test.ts`

- [ ] **Step 1: Write failing tests for factory and ownsJid**

Create `src/channels/signal.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/nanoclaw-test-store',
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

vi.mock('../transcription.js', () => ({
  transcribeAudioFile: vi.fn().mockResolvedValue('Hello from voice'),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    },
  };
});

// Mock signal-sdk
const mockSignalOn = vi.fn();
const mockSignalConnect = vi.fn().mockResolvedValue(undefined);
const mockSignalSendMessage = vi.fn().mockResolvedValue(undefined);
const mockSignalShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock('signal-sdk', () => ({
  SignalCli: vi.fn().mockImplementation(() => ({
    on: mockSignalOn,
    connect: mockSignalConnect,
    sendMessage: mockSignalSendMessage,
    gracefulShutdown: mockSignalShutdown,
  })),
}));

// Set env before importing channel
process.env.SIGNAL_PHONE_NUMBER = '+447700900000';

import { SignalChannel } from './signal.js';
import { ChannelOpts } from './registry.js';

function createOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+447700900000': {
        name: 'Signal Main',
        folder: 'signal_main',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        isMain: true,
        requiresTrigger: false,
      },
    })),
  };
}

describe('SignalChannel', () => {
  let channel: SignalChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createOpts();
    channel = new SignalChannel(opts);
  });

  describe('ownsJid', () => {
    it('returns true for signal: prefixed JIDs', () => {
      expect(channel.ownsJid('signal:+447700900000')).toBe(true);
      expect(channel.ownsJid('signal:+1234567890')).toBe(true);
    });

    it('returns false for non-signal JIDs', () => {
      expect(channel.ownsJid('123@g.us')).toBe(false);
      expect(channel.ownsJid('123@s.whatsapp.net')).toBe(false);
      expect(channel.ownsJid('+447700900000')).toBe(false);
    });
  });

  describe('name', () => {
    it('is "signal"', () => {
      expect(channel.name).toBe('signal');
    });
  });

  describe('connect', () => {
    it('creates SignalCli and calls connect', async () => {
      await channel.connect();
      expect(mockSignalConnect).toHaveBeenCalled();
      expect(mockSignalOn).toHaveBeenCalledWith('message', expect.any(Function));
      expect(channel.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('calls gracefulShutdown', async () => {
      await channel.connect();
      await channel.disconnect();
      expect(mockSignalShutdown).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: FAIL — `SignalChannel` is not exported from `./signal.js`

- [ ] **Step 3: Implement SignalChannel skeleton**

Create `src/channels/signal.ts`:

```typescript
import fs from 'fs';
import path from 'path';

import { SignalCli } from 'signal-sdk';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudioFile } from '../transcription.js';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const SIGNAL_PREFIX = 'signal:';

export class SignalChannel implements Channel {
  name = 'signal';

  private signal!: SignalCli;
  private connected = false;
  private phoneNumber: string;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    this.phoneNumber = process.env.SIGNAL_PHONE_NUMBER || '';
  }

  async connect(): Promise<void> {
    const dataDir = path.join(STORE_DIR, 'signal');
    fs.mkdirSync(dataDir, { recursive: true });

    this.signal = new SignalCli(this.phoneNumber);
    this.signal.on('message', (msg: any) => this.handleMessage(msg));
    await this.signal.connect();
    this.connected = true;
    logger.info('Connected to Signal');

    // Flush any messages queued while disconnected
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush Signal outgoing queue'),
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const phone = jid.replace(SIGNAL_PREFIX, '');
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'Signal disconnected, message queued',
      );
      return;
    }

    try {
      await this.signal.sendMessage(phone, prefixed);
      logger.info({ jid, length: prefixed.length }, 'Signal message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Signal message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(SIGNAL_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.signal) {
      await this.signal.gracefulShutdown();
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    try {
      const envelope = msg.envelope;
      if (!envelope) return;

      // Filter: only process data messages and sync messages with content
      const dataMessage = envelope.dataMessage;
      const syncSentMessage = envelope.syncMessage?.sentMessage;
      const messagePayload = dataMessage || syncSentMessage;
      if (!messagePayload) return;

      const text = messagePayload.message || '';
      const attachments: any[] = messagePayload.attachments || [];
      const hasAudioAttachment = attachments.some(
        (a: any) => a.contentType?.startsWith('audio/'),
      );

      // Skip protocol-only messages (no text, no voice)
      if (!text && !hasAudioAttachment) return;

      const senderPhone = envelope.source || this.phoneNumber;
      const chatJid = `${SIGNAL_PREFIX}${syncSentMessage ? syncSentMessage.destination || this.phoneNumber : senderPhone}`;
      const senderJid = `${SIGNAL_PREFIX}${senderPhone}`;
      const timestamp = new Date(
        envelope.timestamp || Date.now(),
      ).toISOString();

      // Note to Self detection:
      // syncMessage = bot sent this (or user from another linked device)
      // dataMessage from own number = user typed on their phone
      const isSyncMessage = !!syncSentMessage;
      const isFromMe = isSyncMessage;
      const isBotMessage = isSyncMessage || text.startsWith(`${ASSISTANT_NAME}:`);

      // Only deliver messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) {
        // Still notify about chat metadata for discovery
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          senderPhone === this.phoneNumber ? 'Note to Self' : senderPhone,
          'signal',
          false,
        );
        return;
      }

      // Transcribe voice messages
      let finalContent = text;
      if (hasAudioAttachment) {
        const audioAttachment = attachments.find(
          (a: any) => a.contentType?.startsWith('audio/'),
        );
        if (audioAttachment?.file) {
          try {
            const transcript = await transcribeAudioFile(audioAttachment.file);
            if (transcript) {
              finalContent = `[Voice: ${transcript}]`;
              logger.info(
                { chatJid, length: transcript.length },
                'Transcribed Signal voice message',
              );
            } else {
              finalContent = '[Voice Message - transcription unavailable]';
            }
          } catch (err) {
            logger.error({ err }, 'Signal voice transcription error');
            finalContent = '[Voice Message - transcription failed]';
          }
        }
      }

      const senderName =
        envelope.sourceName || senderPhone.replace('+', '');

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        senderPhone === this.phoneNumber ? 'Note to Self' : senderName,
        'signal',
        false,
      );

      this.opts.onMessage(chatJid, {
        id: envelope.timestamp?.toString() || Date.now().toString(),
        chat_jid: chatJid,
        sender: senderJid,
        sender_name: senderName,
        content: finalContent,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isBotMessage,
      });
    } catch (err) {
      logger.error({ err }, 'Error handling Signal message');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Signal outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const phone = item.jid.replace(SIGNAL_PREFIX, '');
        await this.signal.sendMessage(phone, item.text);
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Signal message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const configDir = path.join(STORE_DIR, 'signal');
  if (
    !fs.existsSync(configDir) ||
    !process.env.SIGNAL_PHONE_NUMBER
  ) {
    logger.warn(
      'Signal: not configured. Run /add-signal to set up.',
    );
    return null;
  }
  return new SignalChannel(opts);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat: add Signal channel implementation with Note to Self support"
```

### Task 4: Signal channel — message handling tests

**Files:**
- Modify: `src/channels/signal.test.ts`

- [ ] **Step 1: Add message handling tests**

Append these tests to `signal.test.ts`:

```typescript
describe('message handling', () => {
  let messageHandler: (msg: any) => void;

  beforeEach(async () => {
    opts = createOpts();
    channel = new SignalChannel(opts);
    await channel.connect();
    // Capture the message handler registered with signal.on('message', ...)
    messageHandler = mockSignalOn.mock.calls.find(
      (call: any[]) => call[0] === 'message',
    )?.[1];
  });

  it('processes a dataMessage and calls onMessage', async () => {
    await messageHandler({
      envelope: {
        source: '+441234567890',
        sourceName: 'Greg',
        timestamp: Date.now(),
        dataMessage: {
          message: 'Hello bot',
          attachments: [],
        },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:+441234567890',
      expect.objectContaining({
        content: 'Hello bot',
        sender: 'signal:+441234567890',
        sender_name: 'Greg',
        is_from_me: false,
        is_bot_message: false,
      }),
    );
  });

  it('detects syncMessage as bot message (Note to Self)', async () => {
    await messageHandler({
      envelope: {
        source: '+447700900000',
        sourceName: 'Bot',
        timestamp: Date.now(),
        syncMessage: {
          sentMessage: {
            destination: '+447700900000',
            message: 'Andy: Here is the answer',
            attachments: [],
          },
        },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:+447700900000',
      expect.objectContaining({
        is_from_me: true,
        is_bot_message: true,
      }),
    );
  });

  it('ignores messages without text or audio', async () => {
    await messageHandler({
      envelope: {
        source: '+441234567890',
        timestamp: Date.now(),
        dataMessage: {
          message: '',
          attachments: [],
        },
      },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('ignores receipt and typing events (no dataMessage)', async () => {
    await messageHandler({
      envelope: {
        source: '+441234567890',
        timestamp: Date.now(),
        receiptMessage: { type: 'DELIVERY' },
      },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('skips messages for unregistered chats but emits metadata', async () => {
    await messageHandler({
      envelope: {
        source: '+449999999999',
        sourceName: 'Unknown',
        timestamp: Date.now(),
        dataMessage: {
          message: 'Hey',
          attachments: [],
        },
      },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'signal:+449999999999',
      expect.any(String),
      '+449999999999',
      'signal',
      false,
    );
  });
});

describe('sendMessage', () => {
  beforeEach(async () => {
    opts = createOpts();
    channel = new SignalChannel(opts);
    await channel.connect();
  });

  it('strips signal: prefix and sends via signal-sdk', async () => {
    await channel.sendMessage('signal:+447700900000', 'Hello');

    expect(mockSignalSendMessage).toHaveBeenCalledWith(
      '+447700900000',
      'Andy: Hello',
    );
  });

  it('queues messages when disconnected', async () => {
    await channel.disconnect();

    await channel.sendMessage('signal:+447700900000', 'Hello');

    expect(mockSignalSendMessage).not.toHaveBeenCalled();
  });
});

describe('voice transcription', () => {
  let messageHandler: (msg: any) => void;

  beforeEach(async () => {
    opts = createOpts();
    channel = new SignalChannel(opts);
    await channel.connect();
    messageHandler = mockSignalOn.mock.calls.find(
      (call: any[]) => call[0] === 'message',
    )?.[1];
  });

  it('transcribes audio attachments via transcribeAudioFile', async () => {
    const { transcribeAudioFile } = await import('../transcription.js');

    await messageHandler({
      envelope: {
        source: '+441234567890',
        sourceName: 'Greg',
        timestamp: Date.now(),
        dataMessage: {
          message: '',
          attachments: [
            { contentType: 'audio/ogg', file: '/tmp/voice.ogg' },
          ],
        },
      },
    });

    expect(transcribeAudioFile).toHaveBeenCalledWith('/tmp/voice.ogg');
    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:+441234567890',
      expect.objectContaining({
        content: '[Voice: Hello from voice]',
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/channels/signal.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/channels/signal.test.ts
git commit -m "test: add Signal channel message handling and send tests"
```

### Task 5: Register Signal in channel index + update .env.example

**Files:**
- Modify: `src/channels/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add Signal import to channel index**

Add to `src/channels/index.ts` after the whatsapp import:

```typescript
// signal
import './signal.js';
```

- [ ] **Step 2: Update .env.example**

Add to `.env.example`:

```
SIGNAL_PHONE_NUMBER=
```

- [ ] **Step 3: Build to verify no compilation errors**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/index.ts .env.example
git commit -m "feat: register Signal channel at startup and add env config"
```

---

## Chunk 3: Setup Skill + Auth

### Task 6: Create setup/signal-auth.ts

**Files:**
- Create: `setup/signal-auth.ts`
- Modify: `setup/index.ts` (register the new step)

**Context:** This step wraps signal-sdk's device linking. Called by `npx tsx setup/index.ts --step signal-auth`. Displays QR code in terminal for the user to scan.

- [ ] **Step 1: Check setup/index.ts for the step registration pattern**

Read `setup/index.ts` to understand how steps are registered and called. Look for the pattern used by `whatsapp-auth` or other steps.

- [ ] **Step 2: Create setup/signal-auth.ts**

```typescript
import path from 'path';
import fs from 'fs';

const STORE_DIR = path.resolve(process.cwd(), 'store');

export async function run(_args: string[]): Promise<void> {
  const dataDir = path.join(STORE_DIR, 'signal');
  fs.mkdirSync(dataDir, { recursive: true });

  console.log('=== NANOCLAW SETUP: SIGNAL_AUTH ===');

  try {
    // Dynamic import to avoid requiring signal-sdk at module level
    const { SignalCli } = await import('signal-sdk');

    const signal = new SignalCli(process.env.SIGNAL_PHONE_NUMBER || '');

    console.log('Linking as secondary device...');
    console.log('Scan the QR code below with Signal on your phone:');
    console.log('  Signal → Settings → Linked Devices → Link New Device');
    console.log('');

    // deviceLink displays QR in terminal and waits for scan
    await signal.deviceLink({ deviceName: 'NanoClaw' });

    console.log('');
    console.log('SIGNAL_AUTH_OK=true');
    console.log('STATUS=success');

    await signal.gracefulShutdown();
  } catch (err) {
    console.error('Signal device linking failed:', err);
    console.log('SIGNAL_AUTH_OK=false');
    console.log(`STATUS=error`);
    console.log(`ERROR=${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('=== END ===');
}
```

- [ ] **Step 3: Register the step in setup/index.ts**

Add `'signal-auth'` to the `STEPS` map in `setup/index.ts`:

```typescript
'signal-auth': () => import('./signal-auth.js'),
```

Add it after the `'whatsapp-auth'` entry.

- [ ] **Step 4: Build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add setup/signal-auth.ts setup/index.ts
git commit -m "feat: add Signal device linking setup step"
```

### Task 7: Create the /add-signal skill

**Files:**
- Create: `.claude/skills/add-signal/SKILL.md`

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/add-signal/SKILL.md` following the pattern from `.claude/skills/add-whatsapp/SKILL.md`:

```markdown
# Add Signal Channel

Add Signal as a messaging channel for NanoClaw. Uses linked-device authentication (QR code scan from your phone).

**Prerequisites:**
- Java 17+ installed (macOS only — `brew install openjdk`)
- Signal app on your phone

## Phase 1: Pre-flight

### Check Java (macOS only)

```bash
java -version 2>&1 | head -1 || echo "JAVA_MISSING"
```

If missing on macOS: `brew install openjdk`

### Check if already configured

```bash
test -d store/signal && test -n "$SIGNAL_PHONE_NUMBER" && echo "ALREADY_CONFIGURED" || echo "NEEDS_SETUP"
```

If already configured, skip to Phase 4 (Verify).

### Check signal-sdk is installed

```bash
node -e "require('signal-sdk')" 2>/dev/null && echo "SDK_OK" || echo "SDK_MISSING"
```

If missing: `npm install signal-sdk && npm run build`

## Phase 2: Code Installation

Signal channel is built into NanoClaw core. If `src/channels/signal.ts` exists, skip this phase.

If missing, you're on an older version. Run `/update-nanoclaw` to get the Signal channel.

## Phase 3: Authentication (Device Linking)

### Get phone number

AskUserQuestion: What is the phone number for your Signal account? (E.164 format, e.g. +447700900000)

Write `SIGNAL_PHONE_NUMBER=<number>` to `.env`.

### Link device

Run device linking:

```bash
npx tsx setup/index.ts --step signal-auth
```

This displays a QR code in the terminal. User scans it from Signal: **Settings → Linked Devices → Link New Device**.

Wait for confirmation (`SIGNAL_AUTH_OK=true`). If it fails, retry.

## Phase 4: Registration

Register "Note to Self" as the main channel:

```bash
npx tsx setup/index.ts --step register \
  --jid "signal:+<SIGNAL_PHONE_NUMBER>" \
  --name "Signal Main" \
  --trigger "@Andy" \
  --folder signal_main \
  --channel signal \
  --is-main \
  --no-trigger-required
```

Replace `<SIGNAL_PHONE_NUMBER>` with the actual number from `.env`.

## Phase 5: Verify

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or on Linux:
```bash
npm run build
systemctl --user restart nanoclaw
```

### Test

Send a message in Signal "Note to Self". The agent should respond.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i signal
```

Look for:
- `Connected to Signal` — successful connection
- `Signal message sent` — bot replied
- `Transcribed Signal voice message` — voice transcription working

## Troubleshooting

**"Signal: not configured"**: Ensure `SIGNAL_PHONE_NUMBER` is set in `.env` and `store/signal/` exists with credentials.

**Device linking timeout**: You have 90 seconds to scan the QR code. Re-run the auth step.

**Java not found**: Install Java 17+. macOS: `brew install openjdk`. The setup step checks for this.

**Connection drops**: signal-sdk auto-reconnects. If persistent, check `store/signal/` permissions and signal-cli logs.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-signal/SKILL.md
git commit -m "feat: add /add-signal setup skill"
```

---

## Chunk 4: Final Integration + PR Prep

### Task 8: Full integration test

**Files:** None (testing only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run build**

Run: `npx tsc`
Expected: Clean build, no errors

- [ ] **Step 3: Verify git status is clean**

Run: `git status`
Expected: All changes committed

### Task 9: Create PR to upstream

**Files:** None (git operations only)

- [ ] **Step 1: Push to origin**

```bash
git push -u origin feat/signal-channel
```

- [ ] **Step 2: Create PR to upstream**

```bash
gh pr create \
  --repo qwibitai/nanoclaw \
  --title "feat: add Signal messaging channel" \
  --body "$(cat <<'EOF'
## Summary

- Adds Signal as a first-class NanoClaw messaging channel using `signal-sdk`
- Linked device authentication via QR code scan
- Note to Self as primary chat (1:1 personal assistant)
- Voice message transcription via local whisper-cli
- Setup skill (`/add-signal`) for guided installation
- Refactors `transcription.ts` to extract shared `transcribeAudioFile()` for cross-channel voice support

## Files

- `src/channels/signal.ts` — Channel implementation (factory, connect, send, receive)
- `src/channels/signal.test.ts` — Unit tests
- `src/transcription.ts` — Refactored to export `transcribeAudioFile()`
- `src/transcription.test.ts` — Tests for shared transcription
- `setup/signal-auth.ts` — Device linking setup step
- `.claude/skills/add-signal/SKILL.md` — Setup skill
- `src/channels/index.ts` — Register signal channel
- `.env.example` — Add `SIGNAL_PHONE_NUMBER`

## Test plan

- [ ] `npx vitest run` — all unit tests pass
- [ ] `npx tsc` — clean build
- [ ] Manual: link device, send message in Note to Self, verify agent responds
- [ ] Manual: send voice note, verify transcription
EOF
)"
```
