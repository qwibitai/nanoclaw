import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.registryMockFactory();
});
vi.mock('../env.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.envMockFactory();
});
vi.mock('../config.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.configMockFactory();
});
vi.mock('../live-location.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.liveLocationMockFactory();
});
vi.mock('../db.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.dbMockFactory();
});
vi.mock('../logger.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.loggerMockFactory();
});
vi.mock('../group-folder.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.groupFolderMockFactory();
});
vi.mock('grammy', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.grammyMockFactory();
});
import { getActiveLiveLocationContext } from '../live-location.js';
import { TelegramChannel } from './telegram.js';
import {
  createEditedLocationCtx,
  createMediaCtx,
  createTestOpts,
  createTextCtx,
  currentBot,
  triggerEditedLocationMessage,
  triggerMediaMessage,
  triggerTextMessage,
} from './telegram-test-harness.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('live location', () => {
  it('registers edited_message:location handler on connect', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();
    expect(currentBot().filterHandlers.has('edited_message:location')).toBe(
      true,
    );
  });

  it('start: calls startSession, sends system msg, calls onMessage', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    // Get the LiveLocationManager mock instance created inside connect()
    const { LiveLocationManager } = await import('../live-location.js');
    const mockInstance = vi.mocked(LiveLocationManager).mock.results[0]?.value;

    const ctx = createMediaCtx({
      extra: {
        location: {
          latitude: 35.6762,
          longitude: 139.6503,
          live_period: 600,
        },
      },
    });
    await triggerMediaMessage('message:location', ctx);

    expect(mockInstance.startSession).toHaveBeenCalledWith(
      'tg:100200300',
      1,
      35.6762,
      139.6503,
      600,
      undefined,
      undefined,
    );
    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      '📍 Live location sharing start.',
      expect.anything(),
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: expect.stringContaining('[Live location sharing start]'),
      }),
    );
  });

  it('start: unregistered chat is ignored', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({})),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const { LiveLocationManager } = await import('../live-location.js');
    const mockInstance = vi.mocked(LiveLocationManager).mock.results[0]?.value;

    const ctx = createMediaCtx({
      extra: {
        location: { latitude: 35, longitude: 139, live_period: 600 },
      },
    });
    await triggerMediaMessage('message:location', ctx);

    expect(mockInstance.startSession).not.toHaveBeenCalled();
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('message:text with active session prepends prefix', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    vi.mocked(getActiveLiveLocationContext).mockReturnValue(
      '[Live location sharing enabled] lat: 35, long: 139. check `tail /path/log`\n',
    );

    const ctx = createTextCtx({ text: '@Andy hello' });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: expect.stringContaining(
          '[Live location sharing enabled] lat: 35, long: 139',
        ),
      }),
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: expect.stringContaining('@Andy hello'),
      }),
    );
  });

  it('message:text without active session leaves content unchanged', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    vi.mocked(getActiveLiveLocationContext).mockReturnValue('');

    const ctx = createTextCtx({ text: '@Andy hello' });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ content: '@Andy hello' }),
    );
  });

  it('edited_message:location update calls updateSession', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const { LiveLocationManager } = await import('../live-location.js');
    const mockInstance = vi.mocked(LiveLocationManager).mock.results[0]?.value;

    const ctx = createEditedLocationCtx({
      latitude: 36,
      longitude: 140,
      live_period: 600,
    });
    await triggerEditedLocationMessage(ctx);

    expect(mockInstance.updateSession).toHaveBeenCalledWith(
      'tg:100200300',
      1,
      36,
      140,
      undefined,
      undefined,
      600,
    );
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('edited_message:location stopped calls stopSession', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const { LiveLocationManager } = await import('../live-location.js');
    const mockInstance = vi.mocked(LiveLocationManager).mock.results[0]?.value;
    mockInstance.updateSession.mockReturnValue('stopped');

    const ctx = createEditedLocationCtx({
      latitude: 36,
      longitude: 140,
      live_period: 0,
    });
    await triggerEditedLocationMessage(ctx);

    expect(mockInstance.stopSession).toHaveBeenCalledWith('tg:100200300');
  });
});
