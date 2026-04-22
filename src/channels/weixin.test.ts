import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildTextMessage, sendMessage } from './weixin/api.js';
import { parseWeixinMessage } from './weixin/inbound.js';
import { normalizeAccountId } from './weixin/storage.js';
import {
  MessageItemType,
  MessageState,
  MessageType,
  type WeixinMessage,
} from './weixin/types.js';

describe('weixin normalizeAccountId', () => {
  it('replaces @ and . so accountId is filesystem-safe', () => {
    expect(normalizeAccountId('abc123@im.bot')).toBe('abc123-im-bot');
    expect(normalizeAccountId('plain')).toBe('plain');
  });
});

describe('weixin parseWeixinMessage', () => {
  it('returns null when from_user_id is empty', () => {
    expect(parseWeixinMessage({ from_user_id: '' }, undefined)).toBeNull();
  });

  it('filters messages sent by ourselves', () => {
    const msg: WeixinMessage = {
      from_user_id: 'bot',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hi' } }],
    };
    expect(parseWeixinMessage(msg, 'bot')).toBeNull();
  });

  it('decodes plain text messages', () => {
    const msg: WeixinMessage = {
      from_user_id: 'u-1',
      create_time_ms: 1_700_000_000_000,
      context_token: 'ctx-1',
      client_id: 'cid-1',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hello' } }],
    };
    const parsed = parseWeixinMessage(msg, 'other-bot');
    expect(parsed).not.toBeNull();
    expect(parsed!.jid).toBe('wx:u-1');
    expect(parsed!.contextToken).toBe('ctx-1');
    expect(parsed!.message.content).toBe('hello');
    expect(parsed!.message.id).toBe('cid-1');
    expect(parsed!.message.sender).toBe('u-1');
    expect(parsed!.message.is_from_me).toBe(false);
  });

  it('prefixes the current text with a quoted-context block when ref_msg has text', () => {
    const msg: WeixinMessage = {
      from_user_id: 'u-2',
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: 'reply' },
          ref_msg: {
            title: 'orig',
            message_item: {
              type: MessageItemType.TEXT,
              text_item: { text: 'body' },
            },
          },
        },
      ],
    };
    const parsed = parseWeixinMessage(msg, undefined);
    expect(parsed!.message.content).toBe('[引用: orig | body]\nreply');
  });

  it('keeps only the current text when the quoted message is media', () => {
    const msg: WeixinMessage = {
      from_user_id: 'u-3',
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: 'look' },
          ref_msg: { message_item: { type: MessageItemType.IMAGE } },
        },
      ],
    };
    const parsed = parseWeixinMessage(msg, undefined);
    expect(parsed!.message.content).toBe('look');
  });

  it('falls back to a media placeholder for image-only messages', () => {
    const msg: WeixinMessage = {
      from_user_id: 'u-4',
      item_list: [{ type: MessageItemType.IMAGE }],
    };
    const parsed = parseWeixinMessage(msg, undefined);
    expect(parsed!.message.content).toBe('[图片]');
  });

  it('uses the transcript when a voice item carries text', () => {
    const msg: WeixinMessage = {
      from_user_id: 'u-5',
      item_list: [
        { type: MessageItemType.VOICE, voice_item: { text: 'hi from voice' } },
      ],
    };
    const parsed = parseWeixinMessage(msg, undefined);
    expect(parsed!.message.content).toBe('hi from voice');
  });
});

describe('weixin buildTextMessage', () => {
  it('builds a SendMessageReq wrapping a single TEXT item', () => {
    const req = buildTextMessage({
      to: 'u-1',
      text: 'hi',
      contextToken: 'ctx',
      clientId: 'cid',
    });
    expect(req.msg).toMatchObject({
      to_user_id: 'u-1',
      from_user_id: '',
      client_id: 'cid',
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hi' } }],
    });
  });

  it('omits item_list when text is empty', () => {
    const req = buildTextMessage({ to: 'u-1', text: '', clientId: 'cid' });
    expect(req.msg?.item_list).toBeUndefined();
  });
});

describe('weixin sendMessage API', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to ilink/bot/sendmessage with Bearer auth and JSON body', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = mock as unknown as typeof fetch;

    const body = buildTextMessage({ to: 'u-1', text: 'hi', clientId: 'cid' });
    await sendMessage({
      baseUrl: 'https://example.com/api',
      token: 'secret-token',
      body,
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('https://example.com/api/ilink/bot/sendmessage');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers.AuthorizationType).toBe('ilink_bot_token');
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.msg.to_user_id).toBe('u-1');
    expect(parsedBody.base_info).toBeDefined();
  });

  it('throws with the HTTP status when the server rejects the request', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('nope', { status: 403 }),
      ) as unknown as typeof fetch;

    await expect(
      sendMessage({
        baseUrl: 'https://example.com/api',
        token: 't',
        body: buildTextMessage({ to: 'u', text: 'x', clientId: 'c' }),
      }),
    ).rejects.toThrow(/403/);
  });
});
