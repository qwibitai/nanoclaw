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
import { TelegramChannel } from './telegram.js';
import {
  createMediaCtx,
  createTestOpts,
  currentBot,
  flushPromises,
  triggerMediaMessage,
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

describe('non-text messages', () => {
  it('downloads photo and includes path in content', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createMediaCtx({
      extra: {
        photo: [
          { file_id: 'small_id', width: 90 },
          { file_id: 'large_id', width: 800 },
        ],
      },
    });
    await triggerMediaMessage('message:photo', ctx);
    await flushPromises();

    expect(currentBot().api.getFile).toHaveBeenCalledWith('large_id');
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '[Photo] (/workspace/group/attachments/photo_1.jpg)',
      }),
    );
  });

  it('downloads photo with caption', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createMediaCtx({
      caption: 'Look at this',
      extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
    });
    await triggerMediaMessage('message:photo', ctx);
    await flushPromises();

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content:
          '[Photo] (/workspace/group/attachments/photo_1.jpg) Look at this',
      }),
    );
  });

  it('falls back to placeholder when download fails', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    // Make getFile reject
    currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMediaCtx({
      caption: 'Check this',
      extra: { photo: [{ file_id: 'bad_id', width: 800 }] },
    });
    await triggerMediaMessage('message:photo', ctx);
    await flushPromises();

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ content: '[Photo] Check this' }),
    );
  });

  it('downloads document and includes filename and path', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    currentBot().api.getFile.mockResolvedValueOnce({
      file_path: 'documents/file_0.pdf',
    });

    const ctx = createMediaCtx({
      extra: { document: { file_name: 'report.pdf', file_id: 'doc_id' } },
    });
    await triggerMediaMessage('message:document', ctx);
    await flushPromises();

    expect(currentBot().api.getFile).toHaveBeenCalledWith('doc_id');
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content:
          '[Document: report.pdf] (/workspace/group/attachments/report.pdf)',
      }),
    );
  });

  it('downloads video', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    currentBot().api.getFile.mockResolvedValueOnce({
      file_path: 'videos/file_0.mp4',
    });

    const ctx = createMediaCtx({
      extra: { video: { file_id: 'vid_id' } },
    });
    await triggerMediaMessage('message:video', ctx);
    await flushPromises();

    expect(currentBot().api.getFile).toHaveBeenCalledWith('vid_id');
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '[Video] (/workspace/group/attachments/video_1.mp4)',
      }),
    );
  });

  it('downloads voice message', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    currentBot().api.getFile.mockResolvedValueOnce({
      file_path: 'voice/file_0.oga',
    });

    const ctx = createMediaCtx({
      extra: { voice: { file_id: 'voice_id' } },
    });
    await triggerMediaMessage('message:voice', ctx);
    await flushPromises();

    expect(currentBot().api.getFile).toHaveBeenCalledWith('voice_id');
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '[Voice message] (/workspace/group/attachments/voice_1.oga)',
      }),
    );
  });

  it('downloads audio with original filename', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    currentBot().api.getFile.mockResolvedValueOnce({
      file_path: 'audio/file_0.mp3',
    });

    const ctx = createMediaCtx({
      extra: { audio: { file_id: 'audio_id', file_name: 'song.mp3' } },
    });
    await triggerMediaMessage('message:audio', ctx);
    await flushPromises();

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '[Audio] (/workspace/group/attachments/song.mp3)',
      }),
    );
  });

  it('stores sticker with emoji (no download)', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createMediaCtx({
      extra: { sticker: { emoji: '😂' } },
    });
    await triggerMediaMessage('message:sticker', ctx);

    expect(currentBot().api.getFile).not.toHaveBeenCalled();
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ content: '[Sticker 😂]' }),
    );
  });

  it('stores static location with placeholder (no live_period)', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    // Provide an explicit location object without live_period — static location
    const ctx = createMediaCtx({
      extra: { location: { latitude: 35.6762, longitude: 139.6503 } },
    });
    await triggerMediaMessage('message:location', ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ content: '[Location]' }),
    );
  });

  it('stores contact with placeholder (no download)', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createMediaCtx({});
    await triggerMediaMessage('message:contact', ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ content: '[Contact]' }),
    );
  });

  it('ignores non-text messages from unregistered chats', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createMediaCtx({ chatId: 999999 });
    await triggerMediaMessage('message:photo', ctx);
    await flushPromises();

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('stores document with fallback name when filename missing', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    currentBot().api.getFile.mockResolvedValueOnce({
      file_path: 'documents/file_0.bin',
    });

    const ctx = createMediaCtx({
      extra: { document: { file_id: 'doc_id' } },
    });
    await triggerMediaMessage('message:document', ctx);
    await flushPromises();

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '[Document: file] (/workspace/group/attachments/file.bin)',
      }),
    );
  });
});

// --- sendMessage ---
