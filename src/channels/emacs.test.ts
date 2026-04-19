import { execFileSync, execSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted — must appear before any imports of the modules they replace) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/test-groups',
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../db.js', () => ({ setRegisteredGroup: vi.fn() }));

// Stub out all filesystem calls so tests never touch disk.
vi.mock('fs', () => ({
  default: {
    // Simulate missing symlink by default — triggers creation path
    lstatSync: vi.fn(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    symlinkSync: vi.fn(),
  },
}));

import { setRegisteredGroup } from '../db.js';
import type { ChannelOpts } from './registry.js';
import { EmacsBridgeChannel } from './emacs.js';

// ---------------------------------------------------------------------------
// Helpers

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'main:jid': {
        name: 'main',
        folder: 'main',
        trigger: '',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
    })),
    ...overrides,
  };
}

/** Make an HTTP request to the test server; returns status code and parsed body. */
async function req(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    const request = http.request(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, data: raw });
          }
        });
      },
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

/** Read the actual bound port after connect() (server listens on port 0). */
function boundPort(channel: EmacsBridgeChannel): number {
  return (((channel as any).server as http.Server).address() as AddressInfo)
    .port;
}

// ---------------------------------------------------------------------------

describe('EmacsBridgeChannel', () => {
  let opts: ChannelOpts;
  let channel: EmacsBridgeChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = createTestOpts();
    // Port 0 tells the OS to pick a free ephemeral port — no conflicts between test runs
    channel = new EmacsBridgeChannel(0, null, opts);
  });

  afterEach(async () => {
    if (channel.isConnected()) await channel.disconnect();
  });

  // -------------------------------------------------------------------------
  describe('connect / disconnect / isConnected', () => {
    it('isConnected returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected returns true after connect', async () => {
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected returns false after disconnect', async () => {
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect is a no-op when not connected', async () => {
      await expect(channel.disconnect()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('ownsJid', () => {
    it('returns true for emacs:default', () => {
      expect(channel.ownsJid('emacs:default')).toBe(true);
    });

    it('returns false for non-emacs JIDs', () => {
      expect(channel.ownsJid('tg:123456')).toBe(false);
      expect(channel.ownsJid('main:jid')).toBe(false);
      expect(channel.ownsJid('')).toBe(false);
      expect(channel.ownsJid('emacs:other')).toBe(false);
      expect(channel.ownsJid('123456@g.us')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('group auto-registration', () => {
    it('calls setRegisteredGroup when emacs:default is absent', async () => {
      await channel.connect();
      expect(setRegisteredGroup).toHaveBeenCalledWith(
        'emacs:default',
        expect.objectContaining({
          name: 'emacs',
          folder: 'emacs',
          requiresTrigger: false,
        }),
      );
    });

    it('mutates the live registeredGroups map immediately (no restart needed)', async () => {
      const groups: Record<string, any> = {};
      const localOpts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
      });
      const c = new EmacsBridgeChannel(0, null, localOpts);
      await c.connect();
      expect(groups['emacs:default']).toBeDefined();
      await c.disconnect();
    });

    it('skips registration when emacs:default is already present', async () => {
      const localOpts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'emacs:default': {
            name: 'emacs',
            folder: 'emacs',
            trigger: '',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const c = new EmacsBridgeChannel(0, null, localOpts);
      await c.connect();
      expect(setRegisteredGroup).not.toHaveBeenCalled();
      await c.disconnect();
    });
  });

  // -------------------------------------------------------------------------
  describe('POST /api/message', () => {
    let port: number;

    beforeEach(async () => {
      await channel.connect();
      port = boundPort(channel);
    });

    it('returns 200 with messageId and timestamp for valid text', async () => {
      const { status, data } = await req(
        port,
        'POST',
        '/api/message',
        JSON.stringify({ text: 'hello' }),
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty('messageId');
      expect(data).toHaveProperty('timestamp');
      expect(typeof data.timestamp).toBe('number');
    });

    it('calls opts.onMessage with correct structure', async () => {
      await req(port, 'POST', '/api/message', JSON.stringify({ text: 'ping' }));
      expect(opts.onMessage).toHaveBeenCalledWith(
        'emacs:default',
        expect.objectContaining({
          chat_jid: 'emacs:default',
          content: 'ping',
          sender: 'emacs',
          sender_name: 'Emacs',
          is_from_me: false,
        }),
      );
    });

    it('calls opts.onChatMetadata before opts.onMessage', async () => {
      const order: string[] = [];
      (opts.onChatMetadata as ReturnType<typeof vi.fn>).mockImplementation(() =>
        order.push('meta'),
      );
      (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(() =>
        order.push('msg'),
      );
      await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }));
      expect(order).toEqual(['meta', 'msg']);
    });

    it('returns 400 for empty text', async () => {
      const { status } = await req(
        port,
        'POST',
        '/api/message',
        JSON.stringify({ text: '' }),
      );
      expect(status).toBe(400);
    });

    it('returns 400 for whitespace-only text', async () => {
      const { status } = await req(
        port,
        'POST',
        '/api/message',
        JSON.stringify({ text: '   ' }),
      );
      expect(status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
      const { status } = await req(port, 'POST', '/api/message', 'not-json');
      expect(status).toBe(400);
    });

    it('returns 404 for unknown paths', async () => {
      const { status } = await req(
        port,
        'POST',
        '/api/unknown',
        JSON.stringify({ text: 'hi' }),
      );
      expect(status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('GET /api/messages', () => {
    let port: number;

    beforeEach(async () => {
      await channel.connect();
      port = boundPort(channel);
    });

    it('returns empty messages array when nothing has been sent', async () => {
      const { status, data } = await req(port, 'GET', '/api/messages?since=0');
      expect(status).toBe(200);
      expect(data).toEqual({ messages: [] });
    });

    it('returns messages added via sendMessage', async () => {
      await channel.sendMessage('emacs:default', 'hello back');
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].text).toBe('hello back');
    });

    it('filters out messages at or before the since timestamp', async () => {
      await channel.sendMessage('emacs:default', 'old');
      // Capture `since` after the first push, then wait to guarantee the
      // second push lands at a strictly later timestamp
      const since = Date.now();
      await new Promise((r) => setTimeout(r, 2));
      await channel.sendMessage('emacs:default', 'new');

      const { data } = await req(port, 'GET', `/api/messages?since=${since}`);
      expect(data.messages.map((m: any) => m.text)).not.toContain('old');
      expect(data.messages.map((m: any) => m.text)).toContain('new');
    });

    it('caps buffer at 200 messages, dropping the oldest', async () => {
      for (let i = 0; i < 201; i++) {
        await channel.sendMessage('emacs:default', `msg-${i}`);
      }
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect(data.messages).toHaveLength(200);
      // msg-0 was the first in and should have been evicted
      expect(data.messages.map((m: any) => m.text)).not.toContain('msg-0');
      expect(data.messages.map((m: any) => m.text)).toContain('msg-1');
      expect(data.messages.map((m: any) => m.text)).toContain('msg-200');
    });
  });

  // -------------------------------------------------------------------------
  describe('sendMessage', () => {
    beforeEach(async () => {
      await channel.connect();
    });

    it('pushes exact text to the buffer', async () => {
      await channel.sendMessage('emacs:default', 'response text');
      const { data } = await req(
        boundPort(channel),
        'GET',
        '/api/messages?since=0',
      );
      expect(data.messages[0].text).toBe('response text');
    });

    it('attaches a numeric epoch-ms timestamp', async () => {
      const before = Date.now();
      await channel.sendMessage('emacs:default', 'ts-check');
      const after = Date.now();
      const { data } = await req(
        boundPort(channel),
        'GET',
        '/api/messages?since=0',
      );
      expect(data.messages[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(data.messages[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  // -------------------------------------------------------------------------
  describe('authentication', () => {
    let authChannel: EmacsBridgeChannel;
    let port: number;

    beforeEach(async () => {
      authChannel = new EmacsBridgeChannel(0, 'secret', opts);
      await authChannel.connect();
      port = boundPort(authChannel);
    });

    afterEach(async () => {
      if (authChannel.isConnected()) await authChannel.disconnect();
    });

    it('rejects POST without Authorization header (401)', async () => {
      const { status } = await req(
        port,
        'POST',
        '/api/message',
        JSON.stringify({ text: 'hi' }),
      );
      expect(status).toBe(401);
    });

    it('rejects POST with wrong token (401)', async () => {
      const { status } = await req(
        port,
        'POST',
        '/api/message',
        JSON.stringify({ text: 'hi' }),
        { Authorization: 'Bearer wrong' },
      );
      expect(status).toBe(401);
    });

    it('accepts POST with correct Bearer token (200)', async () => {
      const { status } = await req(
        port,
        'POST',
        '/api/message',
        JSON.stringify({ text: 'hi' }),
        { Authorization: 'Bearer secret' },
      );
      expect(status).toBe(200);
    });

    it('rejects GET without Authorization header (401)', async () => {
      const { status } = await req(port, 'GET', '/api/messages?since=0');
      expect(status).toBe(401);
    });

    it('accepts GET with correct Bearer token (200)', async () => {
      const { status } = await req(
        port,
        'GET',
        '/api/messages?since=0',
        undefined,
        { Authorization: 'Bearer secret' },
      );
      expect(status).toBe(200);
    });

    it('channel without authToken ignores Authorization header entirely', async () => {
      const noAuthChannel = new EmacsBridgeChannel(0, null, opts);
      await noAuthChannel.connect();
      const noAuthPort = boundPort(noAuthChannel);
      try {
        const { status } = await req(
          noAuthPort,
          'GET',
          '/api/messages?since=0',
        );
        expect(status).toBe(200);
      } finally {
        await noAuthChannel.disconnect();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// nanoclaw--md-to-org-regex (Emacs Lisp, tested via emacs --batch)

function emacsAvailable(): boolean {
  try {
    execSync('emacs --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function mdToOrg(input: string): string {
  const elFile = path.resolve('emacs/nanoclaw.el');
  // Escape input as an Emacs string literal — no shell involved so no shell quoting needed
  const escaped = input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  // execFileSync passes args as an array (no shell), bypassing both shell quoting
  // and the vi.mock('fs') stub that would block writeFileSync
  return execFileSync(
    'emacs',
    [
      '--batch',
      '--load',
      elFile,
      '--eval',
      `(princ (nanoclaw--md-to-org-regex "${escaped}"))`,
    ],
    { encoding: 'utf8' },
  );
}

describe.skipIf(!emacsAvailable())('nanoclaw--md-to-org-regex', () => {
  it('converts bold **text** → *text*', () => {
    expect(mdToOrg('**hello**')).toBe('*hello*');
  });

  it('converts italic *text* → /text/', () => {
    expect(mdToOrg('*hello*')).toBe('/hello/');
  });

  it('handles bold before italic in the same string', () => {
    expect(mdToOrg('**bold** and *italic*')).toBe('*bold* and /italic/');
  });

  it('converts strikethrough ~~text~~ → +text+', () => {
    expect(mdToOrg('~~gone~~')).toBe('+gone+');
  });

  it('converts underline __text__ → _text_', () => {
    expect(mdToOrg('__under__')).toBe('_under_');
  });

  it('converts inline code `code` → ~code~', () => {
    expect(mdToOrg('`foo()`')).toBe('~foo()~');
  });

  it('converts fenced code block with language', () => {
    expect(mdToOrg('```typescript\nconst x = 1;\n```')).toBe(
      '#+begin_src typescript\nconst x = 1;\n#+end_src',
    );
  });

  it('converts fenced code block without language', () => {
    expect(mdToOrg('```\nhello\n```')).toBe(
      '#+begin_src text\nhello\n#+end_src',
    );
  });

  it('converts ## heading → ** heading', () => {
    expect(mdToOrg('## Section')).toBe('** Section');
  });

  it('converts ### heading → *** heading', () => {
    expect(mdToOrg('### Deep')).toBe('*** Deep');
  });

  it('leaves list items unchanged', () => {
    expect(mdToOrg('- item one')).toBe('- item one');
  });

  it('converts links [text](url) → [[url][text]]', () => {
    expect(mdToOrg('[NanoClaw](https://example.com)')).toBe(
      '[[https://example.com][NanoClaw]]',
    );
  });
});
