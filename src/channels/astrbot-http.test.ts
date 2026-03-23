import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getChannelFactory } from './registry.js';
import { Channel } from '../types.js';

type FetchMock = ReturnType<typeof vi.fn>;

async function createAstrBotChannel(): Promise<Channel> {
  await import('./astrbot-http.js');
  const factory = getChannelFactory('astrbot-http');
  expect(factory).toBeTypeOf('function');
  const channel = factory!({
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({}),
    registerGroup: () => {},
    setMainGroup: () => {},
    resetSession: () => ({ ok: true }),
    defaultTrigger: '/nc',
  });
  expect(channel).not.toBeNull();
  return channel as Channel;
}

describe('astrbot http outbound delivery', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ASTRBOT_API_BASE = 'http://127.0.0.1:6185';
    process.env.ASTRBOT_HTTP_TOKEN = 'bridge-token';
    process.env.ASTRBOT_API_KEY = 'openapi-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('prefers plugin outbound route for astrbot replies', async () => {
    const fetchMock: FetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const channel = await createAstrBotChannel();
    (channel as any).umoByJid.set(
      'astrbot:aiocqhttp:GroupMessage:demo',
      'aiocqhttp:GroupMessage:demo',
    );

    await channel.sendMessage('astrbot:aiocqhttp:GroupMessage:demo', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:6185/api/plug/nanoclaw_bridge/outbound',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer bridge-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body).toEqual({
      chat_id: 'aiocqhttp:GroupMessage:demo',
      text: 'hello',
      umo: 'aiocqhttp:GroupMessage:demo',
    });
  });

  it('falls back to OpenAPI when plugin outbound rejects the message', async () => {
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'No pending event',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchMock);

    const channel = await createAstrBotChannel();
    (channel as any).umoByJid.set(
      'astrbot:aiocqhttp:GroupMessage:demo',
      'aiocqhttp:GroupMessage:demo',
    );

    await channel.sendMessage('astrbot:aiocqhttp:GroupMessage:demo', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://127.0.0.1:6185/api/v1/im/message',
    );
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer openapi-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const fallbackBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
    expect(fallbackBody).toEqual({
      umo: 'aiocqhttp:GroupMessage:demo',
      message: 'hello',
    });
  });
});
