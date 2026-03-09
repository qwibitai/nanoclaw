import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ChatIO, CredentialProvider, FlowResult } from './types.js';
import { RESELECT } from './types.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-reauth-test-${Date.now()}`);
vi.stubEnv('HOME', tmpDir);

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, '.config', 'nanoclaw'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./exec.js', () => ({
  authSessionDir: vi.fn((scope: string) => path.join(tmpDir, 'sessions', scope)),
  execInContainer: vi.fn(),
}));

// Controllable provider for tests
function makeProvider(
  options: Array<{ label: string; description?: string; result: FlowResult | null }>,
): CredentialProvider {
  return {
    service: 'test',
    displayName: 'Test Provider',
    hasAuth: () => false,
    provision: () => ({ env: {} }),
    storeResult: vi.fn(),
    authOptions: () =>
      options.map((opt) => ({
        label: opt.label,
        description: opt.description,
        provider: provider,
        run: vi.fn(async () => opt.result),
      })),
  };
  // Self-reference after declaration
  var provider = arguments.callee as any;
  // won't work — use below approach instead
}

function createProvider(
  options: Array<{
    label: string;
    description?: string;
    run: (ctx: any) => Promise<FlowResult | null>;
  }>,
): CredentialProvider {
  const provider: CredentialProvider = {
    service: 'test',
    displayName: 'Test Provider',
    hasAuth: () => false,
    provision: () => ({ env: {} }),
    storeResult: vi.fn(),
    authOptions: () =>
      options.map((opt) => ({
        label: opt.label,
        description: opt.description,
        provider,
        run: opt.run,
      })),
  };
  return provider;
}

function createChat(replies: Array<string | null>): ChatIO & { sent: string[] } {
  let replyIndex = 0;
  const sent: string[] = [];
  return {
    sent,
    send: vi.fn(async (text: string) => { sent.push(text); }),
    receive: vi.fn(async () => {
      const reply = replyIndex < replies.length ? replies[replyIndex] : null;
      replyIndex++;
      return reply;
    }),
    advanceCursor: vi.fn(),
  };
}

// Must mock registry before importing reauth
const mockProviders: CredentialProvider[] = [];
vi.mock('./registry.js', () => ({
  getAllProviders: () => mockProviders,
}));

const { runReauth } = await import('./reauth.js');

describe('runReauth', () => {
  beforeEach(() => {
    mockProviders.length = 0;
  });

  it('returns false when no providers registered', async () => {
    const chat = createChat([]);
    const result = await runReauth('test-scope', chat, 'no creds', 'Test Provider');
    expect(result).toBe(false);
    expect(chat.sent[0]).toContain('No auth providers registered');
  });

  it('all messages have the reauth prefix', async () => {
    const provider = createProvider([
      { label: 'Option A', run: async () => ({ auth_type: 'test', token: 'tok' }) },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['1']); // select option 1
    await runReauth('test-scope', chat, 'test reason', 'Test Provider');

    for (const msg of chat.sent) {
      expect(msg).toMatch(/^🔑🤖/);
    }
  });

  it('shows group id for non-default scope', async () => {
    const provider = createProvider([
      { label: 'Option A', run: async () => null },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['1']);
    await runReauth('my-group', chat, 'test', 'Test Provider');

    expect(chat.sent[0]).toContain('Group: *my-group*');
  });

  it('shows default scope warning', async () => {
    const provider = createProvider([
      { label: 'Option A', run: async () => null },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['1']);
    await runReauth('default', chat, 'test', 'Test Provider');

    expect(chat.sent[0]).toContain('default');
    expect(chat.sent[0]).toContain('all groups');
  });

  it('shows options with descriptions separated by blank lines', async () => {
    const provider = createProvider([
      { label: 'Option A', description: 'Description of A', run: async () => null },
      { label: 'Option B', description: 'Description of B', run: async () => null },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['3']); // cancel
    await runReauth('scope', chat, 'reason', 'Test Provider');

    const menu = chat.sent[0];
    expect(menu).toContain('1. *Option A*');
    expect(menu).toContain('Description of A');
    expect(menu).toContain('2. *Option B*');
    expect(menu).toContain('Description of B');
    expect(menu).toContain('3. Cancel');
    // Descriptions should be indented
    expect(menu).toContain('   Description of A');
    // Options should be separated by blank lines
    const lines = menu.split('\n');
    const optAIndex = lines.findIndex((l) => l.includes('1. *Option A*'));
    const optBIndex = lines.findIndex((l) => l.includes('2. *Option B*'));
    // There should be a blank line between the description of A and option B
    const between = lines.slice(optAIndex + 2, optBIndex);
    expect(between.some((l) => l.trim() === '')).toBe(true);
  });

  it('instructions come after options', async () => {
    const provider = createProvider([
      { label: 'Option A', run: async () => null },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['2']); // cancel
    await runReauth('scope', chat, 'reason', 'Test Provider');

    const menu = chat.sent[0];
    const cancelPos = menu.indexOf('Cancel');
    const instructionPos = menu.indexOf('reply with a number only');
    expect(instructionPos).toBeGreaterThan(cancelPos);
  });

  it('cancels when user picks cancel number', async () => {
    const provider = createProvider([
      { label: 'A', run: async () => ({ auth_type: 't', token: 'k' }) },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['2']); // 2 = Cancel (1 option + Cancel)
    const result = await runReauth('scope', chat, 'reason', 'Test Provider');
    expect(result).toBe(false);
    expect(chat.sent.some((m) => m.includes('Cancelled'))).toBe(true);
  });

  it('cancels on invalid input', async () => {
    const provider = createProvider([
      { label: 'A', run: async () => ({ auth_type: 't', token: 'k' }) },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['abc']);
    const result = await runReauth('scope', chat, 'reason', 'Test Provider');
    expect(result).toBe(false);
  });

  it('returns false on timeout', async () => {
    const provider = createProvider([
      { label: 'A', run: async () => ({ auth_type: 't', token: 'k' }) },
    ]);
    mockProviders.push(provider);

    const chat = createChat([null]); // timeout
    const result = await runReauth('scope', chat, 'reason', 'Test Provider');
    expect(result).toBe(false);
    expect(chat.sent.some((m) => m.includes('Timed out'))).toBe(true);
  });

  it('stores credentials on success', async () => {
    const provider = createProvider([
      { label: 'A', run: async () => ({ auth_type: 'api_key', token: 'my-key' }) },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['1']);
    const result = await runReauth('scope', chat, 'reason', 'Test Provider');
    expect(result).toBe(true);
    expect(provider.storeResult).toHaveBeenCalledWith('scope', {
      auth_type: 'api_key',
      token: 'my-key',
    });
    expect(chat.sent.some((m) => m.includes('Credentials stored'))).toBe(true);
  });

  it('returns false when run() returns null', async () => {
    const provider = createProvider([
      { label: 'A', run: async () => null },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['1']);
    const result = await runReauth('scope', chat, 'reason', 'Test Provider');
    expect(result).toBe(false);
    expect(chat.sent.some((m) => m.includes('cancelled or failed'))).toBe(true);
  });

  it('handles run() throwing an error', async () => {
    const provider = createProvider([
      { label: 'A', run: async () => { throw new Error('boom'); } },
    ]);
    mockProviders.push(provider);

    const chat = createChat(['1']);
    const result = await runReauth('scope', chat, 'reason', 'Test Provider');
    expect(result).toBe(false);
    expect(chat.sent.some((m) => m.includes('Auth flow error') && m.includes('boom'))).toBe(true);
  });

  describe('RESELECT', () => {
    it('restarts menu when run() returns RESELECT', async () => {
      let callCount = 0;
      const provider = createProvider([
        {
          label: 'Needs GPG',
          run: async () => {
            callCount++;
            if (callCount === 1) return RESELECT;
            return { auth_type: 'api_key', token: 'key' };
          },
        },
        { label: 'Other', run: async () => ({ auth_type: 'other', token: 'tok' }) },
      ]);
      mockProviders.push(provider);

      // First attempt: pick option 1 (returns RESELECT)
      // Second attempt: pick option 2 (succeeds)
      const chat = createChat(['1', '2']);
      const result = await runReauth('scope', chat, 'reason', 'Test Provider');
      expect(result).toBe(true);
      // Menu should have been shown twice
      const menuMessages = chat.sent.filter((m) => m.includes('Choose an authentication method'));
      expect(menuMessages).toHaveLength(2);
    });

    it('can reselect and then cancel', async () => {
      const provider = createProvider([
        { label: 'Broken', run: async () => RESELECT },
      ]);
      mockProviders.push(provider);

      // First: pick option 1 (RESELECT), second: pick cancel (2)
      const chat = createChat(['1', '2']);
      const result = await runReauth('scope', chat, 'reason', 'Test Provider');
      expect(result).toBe(false);
    });

    it('prefixes provider messages during run()', async () => {
      const provider = createProvider([
        {
          label: 'Chatty',
          run: async (ctx: any) => {
            await ctx.chat.send('Hello from provider');
            return { auth_type: 'test', token: 'tok' };
          },
        },
      ]);
      mockProviders.push(provider);

      const chat = createChat(['1']);
      await runReauth('scope', chat, 'reason', 'Test Provider');

      const providerMsg = chat.sent.find((m) => m.includes('Hello from provider'));
      expect(providerMsg).toBeDefined();
      expect(providerMsg).toMatch(/^🔑🤖/);
    });
  });
});
