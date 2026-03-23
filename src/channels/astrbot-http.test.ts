import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { getChannelFactory } from './registry.js';
import { _astrbotHttpInternals } from './astrbot-http.js';
import { Channel } from '../types.js';

type FetchMock = ReturnType<typeof vi.fn>;

async function createAstrBotChannel(): Promise<Channel> {
  await import('./astrbot-http.js');
  const factory = getChannelFactory('astrbot-http');
  expect(factory).toBeTypeOf('function');
  const groups: Record<string, any> = {};
  const channel = factory!({
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    setMainGroup: () => {},
    resetSession: () => ({ ok: true }),
    defaultTrigger: '/nc',
  });
  expect(channel).not.toBeNull();
  (channel as any).__testGroups = groups;
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

  it('returns diagnostics from the control endpoint', async () => {
    process.env.NANOCLAW_MODEL = 'gpt-5.2';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4000';
    process.env.ANTHROPIC_API_KEY = 'dummy-key';

    const groups = {
      'astrbot:demo': {
        name: 'Demo Session',
        folder: 'astrbot_demo',
        trigger: '/nc',
        added_at: '2026-03-23T00:00:00.000Z',
        isMain: true,
      },
    };

    const body = _astrbotHttpInternals.buildDiagPayload(groups as any, true, {
      listenHost: '127.0.0.1',
      listenPort: 7801,
      token: 'bridge-token',
      apiBase: 'http://127.0.0.1:6185',
      apiKey: 'openapi-key',
    });

    expect(body).toMatchObject({
      ok: true,
      main: {
        jid: 'astrbot:demo',
        name: 'Demo Session',
      },
      diag: {
        channel: {
          connected: true,
          listenHost: '127.0.0.1',
          listenPort: 7801,
          tokenConfigured: true,
        },
        openapi: {
          apiBase: 'http://127.0.0.1:6185',
          apiKeyConfigured: true,
        },
        sessions: {
          registeredCount: 1,
        },
        model: {
          model: 'gpt-5.2',
          anthropicBaseUrl: 'http://127.0.0.1:4000',
          authMode: 'api-key',
          apiKeyConfigured: true,
        },
      },
    });
  });
});

describe('astrbot main CLAUDE template', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies the main CLAUDE template into a missing astrbot main folder', () => {
    const cwd = '/tmp/nanoclaw-project';
    const folder = 'astrbot_demo';
    const templatePath = path.join(cwd, 'groups', 'main', 'CLAUDE.md');
    const destPath = path.join(process.cwd(), 'groups', folder, 'CLAUDE.md');

    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    vi.spyOn(fs, 'existsSync').mockImplementation(((targetPath: fs.PathLike) =>
      targetPath === templatePath ? true : false) as typeof fs.existsSync);
    const copyFileSync = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      return undefined;
    });

    _astrbotHttpInternals.ensureMainClaudeTemplate(folder);

    expect(copyFileSync).toHaveBeenCalledWith(templatePath, destPath);
  });

  it('does not overwrite an existing astrbot main CLAUDE file', () => {
    const cwd = '/tmp/nanoclaw-project';
    const folder = 'astrbot_demo';
    const templatePath = path.join(cwd, 'groups', 'main', 'CLAUDE.md');
    const destPath = path.join(process.cwd(), 'groups', folder, 'CLAUDE.md');

    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    vi.spyOn(fs, 'existsSync').mockImplementation(
      ((targetPath: fs.PathLike) =>
        targetPath === templatePath ||
        targetPath === destPath) as typeof fs.existsSync,
    );
    const copyFileSync = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      return undefined;
    });

    _astrbotHttpInternals.ensureMainClaudeTemplate(folder);

    expect(copyFileSync).not.toHaveBeenCalled();
  });
});
