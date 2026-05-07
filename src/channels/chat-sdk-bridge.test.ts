import { describe, expect, it } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface RecordedPost {
  threadId: string;
  body: { markdown?: string; raw?: string };
}

/**
 * Build a bridge over a stub adapter that records every postMessage body so
 * tests can assert which delivery shape (markdown vs raw) was used.
 */
function recordingBridge(opts: {
  transformOutboundText?: (t: string) => string;
  transformOutboundMarkdown?: (t: string) => string;
}): { bridge: ReturnType<typeof createChatSdkBridge>; posts: RecordedPost[] } {
  const posts: RecordedPost[] = [];
  const adapter = stubAdapter({
    name: 'stub',
    channelIdFromThreadId: (t: string) => t,
    postMessage: async (threadId: string, body: { markdown?: string; raw?: string }) => {
      posts.push({ threadId, body });
      return { id: 'msg-stub', threadId, raw: {} };
    },
  } as unknown as Partial<Adapter>);
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    ...opts,
  });
  return { bridge, posts };
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
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
});

describe('createChatSdkBridge — fetchThreadHistory anchor', () => {
  // Discord auto-creates a thread when a user replies to a channel-root
  // message; the parent message lives in the parent channel, outside what
  // `fetchMessages(threadId)` returns. The fetchThreadAnchor hook prepends
  // that anchor so the agent's first wake inside the thread sees what the
  // user is replying to.

  function adapterWithFetchMessages(msgs: Array<{ id: string; text: string; sender: string; iso: string }>) {
    return stubAdapter({
      fetchMessages: async () => ({
        messages: msgs.map((m) => ({
          id: m.id,
          text: m.text,
          author: { fullName: m.sender, userName: m.sender, isMe: false },
          metadata: { dateSent: new Date(m.iso) },
        })),
      }),
    } as unknown as Partial<Adapter>);
  }

  it('prepends the anchor messages returned by fetchThreadAnchor (M0 + M1, in chronological order)', async () => {
    const bridge = createChatSdkBridge({
      adapter: adapterWithFetchMessages([
        { id: 'in-1', text: 'reply inside thread', sender: 'Dave', iso: '2026-05-03T13:00:00Z' },
      ]),
      supportsThreads: true,
      fetchThreadAnchor: async () => [
        {
          sender: 'Axie',
          text: 'wiki lint findings — 3 categories',
          timestamp: '2026-05-03T10:00:00Z',
          isAnchor: true,
        },
        {
          sender: 'Dave',
          text: '@Axie fix stale claims',
          timestamp: '2026-05-03T10:30:00Z',
          isAnchor: true,
        },
      ],
    });
    const history = await bridge.fetchThreadHistory!('discord:g:c:t', { limit: 50 });
    expect(history).toHaveLength(3);
    expect(history[0].text).toBe('wiki lint findings — 3 categories');
    expect(history[0].isAnchor).toBe(true);
    expect(history[1].text).toBe('@Axie fix stale claims');
    expect(history[1].isAnchor).toBe(true);
    expect(history[2].sender).toBe('Dave');
    expect(history[2].isAnchor).toBeUndefined();
  });

  it('skips the anchor when fetchThreadAnchor returns null (forum threads, channel root, errors)', async () => {
    const bridge = createChatSdkBridge({
      adapter: adapterWithFetchMessages([
        { id: 'in-1', text: 'reply inside thread', sender: 'Dave', iso: '2026-05-03T12:00:00Z' },
      ]),
      supportsThreads: true,
      fetchThreadAnchor: async () => null,
    });
    const history = await bridge.fetchThreadHistory!('discord:g:c:t', { limit: 50 });
    expect(history).toHaveLength(1);
    expect(history[0].sender).toBe('Dave');
  });

  it('does not duplicate when the anchor is already in the in-thread results (forum threads)', async () => {
    const sharedIso = '2026-05-03T10:00:00Z';
    const sharedText = 'forum starter post';
    const bridge = createChatSdkBridge({
      adapter: adapterWithFetchMessages([
        { id: 'starter', text: sharedText, sender: 'Axie', iso: sharedIso },
        { id: 'in-1', text: 'reply', sender: 'Dave', iso: '2026-05-03T12:00:00Z' },
      ]),
      supportsThreads: true,
      fetchThreadAnchor: async () => [{ sender: 'Axie', text: sharedText, timestamp: sharedIso, isAnchor: true }],
    });
    const history = await bridge.fetchThreadHistory!('discord:g:c:t', { limit: 50 });
    expect(history.filter((m) => m.text === sharedText)).toHaveLength(1);
  });

  it('still returns in-thread history when fetchThreadAnchor throws', async () => {
    const bridge = createChatSdkBridge({
      adapter: adapterWithFetchMessages([{ id: 'in-1', text: 'reply', sender: 'Dave', iso: '2026-05-03T12:00:00Z' }]),
      supportsThreads: true,
      fetchThreadAnchor: async () => {
        throw new Error('network down');
      },
    });
    const history = await bridge.fetchThreadHistory!('discord:g:c:t', { limit: 50 });
    expect(history).toHaveLength(1);
    expect(history[0].sender).toBe('Dave');
  });

  it('forwards excludeMessageId to fetchThreadAnchor (so adapters can skip when anchor == trigger)', async () => {
    let receivedExclude: string | undefined;
    const bridge = createChatSdkBridge({
      adapter: adapterWithFetchMessages([]),
      supportsThreads: true,
      fetchThreadAnchor: async (_t, opts) => {
        receivedExclude = opts?.excludeMessageId;
        return null;
      },
    });
    await bridge.fetchThreadHistory!('discord:g:c:t', { limit: 50, excludeMessageId: 'mention-msg-id' });
    expect(receivedExclude).toBe('mention-msg-id');
  });
});

describe('createChatSdkBridge — outbound transform path', () => {
  // The transform mode determines whether the adapter sees `markdown` or `raw`.
  // `markdown` is required for adapters that emit rich blocks (Slack Block Kit
  // tables, Discord ASCII tables) — those code paths are gated on the message
  // arriving as `markdown` or `ast`. `raw` is appropriate when the transform
  // has already pre-rendered to platform-native syntax (Telegram mrkdwn).

  it('transformOutboundText forces raw delivery (legacy behavior preserved)', async () => {
    const { bridge, posts } = recordingBridge({
      transformOutboundText: (t) => t.toUpperCase(),
    });
    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: 'hello *world*' },
    } as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ raw: 'HELLO *WORLD*' });
  });

  it('transformOutboundMarkdown keeps markdown delivery (rich-block features still fire)', async () => {
    const { bridge, posts } = recordingBridge({
      transformOutboundMarkdown: (md) => md.replace(/^## (.+)$/gm, '**$1**'),
    });
    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: '## Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |' },
    } as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].body.markdown).toBeDefined();
    expect(posts[0].body.raw).toBeUndefined();
    expect(posts[0].body.markdown).toBe('**Heading**\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  });

  it('no transform → markdown delivery, content unchanged', async () => {
    const { bridge, posts } = recordingBridge({});
    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: '**bold** text' },
    } as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ markdown: '**bold** text' });
  });

  it('transformOutboundText wins when both are set (legacy precedence)', async () => {
    const { bridge, posts } = recordingBridge({
      transformOutboundText: () => 'TEXT-WINS',
      transformOutboundMarkdown: () => 'MARKDOWN-LOSES',
    });
    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: 'whatever' },
    } as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ raw: 'TEXT-WINS' });
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});
