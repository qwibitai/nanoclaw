import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });

  it('splits caption at maxCaptionLength when files are attached', async () => {
    // Reproduces the real Telegram failure: a 1108-char reply with a file
    // attachment was sent as caption, character-truncated to 1024 mid-code-span,
    // and rejected by Telegram with "Can't find end of the entity starting at
    // byte offset N". The bridge must split BEFORE the adapter truncates so
    // each post fits the platform's caption / message limits cleanly.
    const posts: Array<{ threadId: string; markdown: string; files?: unknown[] }> = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        postMessage: async (threadId: string, msg: unknown) => {
          const m = msg as { markdown?: string; files?: unknown[] };
          posts.push({ threadId, markdown: m.markdown ?? '', files: m.files });
          return { id: `m-${posts.length}`, raw: {}, threadId };
        },
      }),
      supportsThreads: false,
      maxTextLength: 4000,
      maxCaptionLength: 1024,
    });

    const para = 'a'.repeat(800);
    const longText = `${para}\n\n${para}`; // 1602 chars; one \n\n splits it
    await bridge.deliver('telegram:1', null, {
      kind: 'chat',
      content: { text: longText },
      files: [{ data: Buffer.from('x'), filename: 'f.mp4' }],
    } as never);

    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[0].markdown.length).toBeLessThanOrEqual(1024);
    expect(posts[0].files).toBeDefined();
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i].files).toBeUndefined();
      expect(posts[i].markdown.length).toBeLessThanOrEqual(4000);
    }
  });

  it('does not split file caption when text fits the caption limit', async () => {
    const posts: Array<{ markdown: string; files?: unknown[] }> = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        postMessage: async (_t: string, msg: unknown) => {
          const m = msg as { markdown?: string; files?: unknown[] };
          posts.push({ markdown: m.markdown ?? '', files: m.files });
          return { id: 'm-1', raw: {}, threadId: _t };
        },
      }),
      supportsThreads: false,
      maxTextLength: 4000,
      maxCaptionLength: 1024,
    });

    await bridge.deliver('telegram:1', null, {
      kind: 'chat',
      content: { text: 'short caption' },
      files: [{ data: Buffer.from('x'), filename: 'f.mp4' }],
    } as never);

    expect(posts).toHaveLength(1);
    expect(posts[0].markdown).toBe('short caption');
    expect(posts[0].files).toBeDefined();
  });

  it('falls back to platformId when outbound threadId is an empty string', async () => {
    const deliveredTo: string[] = [];
    const typedIn: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        postMessage: async (threadId: string) => {
          deliveredTo.push(threadId);
          return { id: 'm-1', raw: {}, threadId };
        },
        startTyping: async (threadId: string) => {
          typedIn.push(threadId);
        },
      }),
      supportsThreads: false,
    });

    await bridge.deliver('telegram:1594196884', '', {
      kind: 'chat',
      content: { text: 'hello' },
    });
    await bridge.setTyping?.('telegram:1594196884', '');

    expect(deliveredTo).toEqual(['telegram:1594196884']);
    expect(typedIn).toEqual(['telegram:1594196884']);
  });
});
