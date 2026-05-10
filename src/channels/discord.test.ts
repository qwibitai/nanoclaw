import { describe, expect, it, vi } from 'vitest';

import { isUserMessage, rewriteDiscordLinks, discordPostParent, discordCreateThread, type DiscordRestClient } from './discord.js';

describe('rewriteDiscordLinks', () => {
  it('rewrites bare Google document and slide URLs to safe labeled links', () => {
    const docUrl = 'https://docs.google.com/document/d/doc-id/edit';
    const slidesUrl = 'https://docs.google.com/presentation/d/slides-id/edit';

    expect(rewriteDiscordLinks(`Doc:\n${docUrl}\n\nSlides:\n${slidesUrl}`)).toBe(
      `Doc:\n[Open Google Doc](${docUrl})\n\nSlides:\n[Open Google Slides](${slidesUrl})`,
    );
  });

  it('rewrites masked links whose visible text is also a URL', () => {
    const url = 'https://docs.google.com/document/d/doc-id/edit';

    expect(rewriteDiscordLinks(`[${url}](${url})`)).toBe(`[Open Google Doc](${url})`);
  });

  it('preserves descriptive masked links', () => {
    const input =
      '[Chase Sapphire Reserve official page](https://creditcards.chase.com/rewards-credit-cards/sapphire/reserve)';

    expect(rewriteDiscordLinks(input)).toBe(input);
  });

  it('does not rewrite URLs inside code', () => {
    const url = 'https://example.com/path';
    const input = `Run \`curl ${url}\`\n\n\`\`\`\n${url}\n\`\`\``;

    expect(rewriteDiscordLinks(input)).toBe(input);
  });
});

describe('isUserMessage (Discord inbound filter)', () => {
  it('keeps default text messages (type 0)', () => {
    expect(isUserMessage({ raw: { type: 0 } })).toBe(true);
  });

  it('keeps Reply messages (type 19)', () => {
    expect(isUserMessage({ raw: { type: 19 } })).toBe(true);
  });

  it('keeps slash-command and context-menu invocations (types 20, 23)', () => {
    expect(isUserMessage({ raw: { type: 20 } })).toBe(true);
    expect(isUserMessage({ raw: { type: 23 } })).toBe(true);
  });

  it('drops THREAD_CREATED (type 18)', () => {
    expect(isUserMessage({ raw: { type: 18 } })).toBe(false);
  });

  // THREAD_STARTER_MESSAGE is a synthetic echo of the parent; routing it would duplicate content.
  it('drops THREAD_STARTER_MESSAGE (type 21)', () => {
    expect(isUserMessage({ raw: { type: 21 } })).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 22, 24])('drops system message type %i', (type) => {
    expect(isUserMessage({ raw: { type } })).toBe(false);
  });

  it('keeps messages with no raw payload', () => {
    expect(isUserMessage({})).toBe(true);
    expect(isUserMessage({ raw: {} })).toBe(true);
  });
});

describe('discordPostParent', () => {
  it('test_post_parent_returns_message_id: returns {messageId} from REST response', async () => {
    const mockRest: DiscordRestClient = {
      post: vi.fn().mockResolvedValue({ id: 'msg-abc' }),
    };
    const result = await discordPostParent(mockRest, 'channel-id-X', 'launched');
    expect(result).toEqual({ messageId: 'msg-abc' });
  });
});

describe('discordCreateThread', () => {
  it('test_create_thread_returns_thread_id: returns {threadId, messageId} from REST responses', async () => {
    const mockRest: DiscordRestClient = {
      post: vi
        .fn()
        .mockResolvedValueOnce({ id: 'thread-y' })
        .mockResolvedValueOnce({ id: 'first-msg-z' }),
    };
    const result = await discordCreateThread(mockRest, 'channel-X', 'parent-msg-A', 'Task Y', 'first message');
    expect(result).toEqual({ threadId: 'thread-y', messageId: 'first-msg-z' });
  });

  it('test_thread_name_used: creates thread with correct name and startMessage', async () => {
    const postSpy = vi
      .fn()
      .mockResolvedValueOnce({ id: 'thread-z' })
      .mockResolvedValueOnce({ id: 'first-msg-id' });
    const mockRest: DiscordRestClient = { post: postSpy };
    await discordCreateThread(mockRest, 'channel', 'parent', 'My Task Name', 'first');
    // First call: thread creation with name and startMessage (via Routes.threads)
    expect(postSpy.mock.calls[0][1]).toEqual({ body: { name: 'My Task Name' } });
    expect(postSpy.mock.calls[0][0]).toContain('/channels/channel/messages/parent/threads');
  });
});
