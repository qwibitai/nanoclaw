import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ---

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    },
  };
});

const mockDownloadMediaMessage = vi.fn();

vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: (...args: unknown[]) => mockDownloadMediaMessage(...args),
}));

import {
  unwrapMessage,
  getMediaInfo,
  isSafeMime,
  downloadAndSaveMedia,
} from './whatsapp-media.js';
import type { WAMessage } from '@whiskeysockets/baileys';

// --- Helpers ---

function makeMessage(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: { id: 'test-msg-id', remoteJid: 'group@g.us' },
    ...overrides,
  } as WAMessage;
}

// --- Tests ---

describe('unwrapMessage', () => {
  it('returns null for null/undefined message', () => {
    expect(unwrapMessage(null)).toBeNull();
    expect(unwrapMessage(undefined)).toBeNull();
  });

  it('returns the message as-is for plain messages', () => {
    const msg = { conversation: 'hello' } as WAMessage['message'];
    expect(unwrapMessage(msg)).toBe(msg);
  });

  it('unwraps ephemeralMessage', () => {
    const inner = { imageMessage: { mimetype: 'image/jpeg' } };
    const msg = { ephemeralMessage: { message: inner } } as unknown as WAMessage['message'];
    expect(unwrapMessage(msg)).toBe(inner);
  });

  it('unwraps viewOnceMessage', () => {
    const inner = { videoMessage: { mimetype: 'video/mp4' } };
    const msg = { viewOnceMessage: { message: inner } } as unknown as WAMessage['message'];
    expect(unwrapMessage(msg)).toBe(inner);
  });

  it('unwraps viewOnceMessageV2', () => {
    const inner = { imageMessage: { mimetype: 'image/png' } };
    const msg = { viewOnceMessageV2: { message: inner } } as unknown as WAMessage['message'];
    expect(unwrapMessage(msg)).toBe(inner);
  });

  it('unwraps documentWithCaptionMessage', () => {
    const inner = { documentMessage: { mimetype: 'application/pdf' } };
    const msg = { documentWithCaptionMessage: { message: inner } } as unknown as WAMessage['message'];
    expect(unwrapMessage(msg)).toBe(inner);
  });

  it('unwraps nested ephemeral + viewOnce', () => {
    const inner = { imageMessage: { mimetype: 'image/jpeg' } };
    const msg = {
      ephemeralMessage: { message: { viewOnceMessage: { message: inner } } },
    } as unknown as WAMessage['message'];
    expect(unwrapMessage(msg)).toBe(inner);
  });
});

describe('getMediaInfo', () => {
  it('returns null when message has no content', () => {
    expect(getMediaInfo(makeMessage({ message: undefined }))).toBeNull();
    expect(getMediaInfo(makeMessage({ message: null as unknown as WAMessage['message'] }))).toBeNull();
  });

  it('detects imageMessage', () => {
    const msg = makeMessage({
      message: { imageMessage: { mimetype: 'image/jpeg' } } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toEqual({
      type: 'image',
      mediaKey: 'imageMessage',
      mimetype: 'image/jpeg',
      filename: undefined,
    });
  });

  it('detects videoMessage', () => {
    const msg = makeMessage({
      message: { videoMessage: { mimetype: 'video/mp4' } } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toEqual({
      type: 'video',
      mediaKey: 'videoMessage',
      mimetype: 'video/mp4',
      filename: undefined,
    });
  });

  it('detects audioMessage', () => {
    const msg = makeMessage({
      message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toEqual({
      type: 'audio',
      mediaKey: 'audioMessage',
      mimetype: 'audio/ogg; codecs=opus',
      filename: undefined,
    });
  });

  it('detects documentMessage with filename', () => {
    const msg = makeMessage({
      message: {
        documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf' },
      } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toEqual({
      type: 'document',
      mediaKey: 'documentMessage',
      mimetype: 'application/pdf',
      filename: 'report.pdf',
    });
  });

  it('detects stickerMessage', () => {
    const msg = makeMessage({
      message: { stickerMessage: { mimetype: 'image/webp' } } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toEqual({
      type: 'sticker',
      mediaKey: 'stickerMessage',
      mimetype: 'image/webp',
      filename: undefined,
    });
  });

  it('returns empty mimetype when not set', () => {
    const msg = makeMessage({
      message: { imageMessage: {} } as unknown as WAMessage['message'],
    });
    const info = getMediaInfo(msg);
    expect(info).not.toBeNull();
    expect(info!.mimetype).toBe('');
  });

  it('returns null for text-only messages', () => {
    const msg = makeMessage({
      message: { conversation: 'hello' } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toBeNull();
  });

  it('detects media inside ephemeral container', () => {
    const msg = makeMessage({
      message: {
        ephemeralMessage: {
          message: { imageMessage: { mimetype: 'image/jpeg' } },
        },
      } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toEqual({
      type: 'image',
      mediaKey: 'imageMessage',
      mimetype: 'image/jpeg',
      filename: undefined,
    });
  });

  it('detects media inside viewOnce container', () => {
    const msg = makeMessage({
      message: {
        viewOnceMessage: {
          message: { videoMessage: { mimetype: 'video/mp4' } },
        },
      } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toEqual({
      type: 'video',
      mediaKey: 'videoMessage',
      mimetype: 'video/mp4',
      filename: undefined,
    });
  });

  it('detects media inside documentWithCaption container', () => {
    const msg = makeMessage({
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: { mimetype: 'application/pdf', fileName: 'doc.pdf' },
          },
        },
      } as unknown as WAMessage['message'],
    });
    expect(getMediaInfo(msg)).toEqual({
      type: 'document',
      mediaKey: 'documentMessage',
      mimetype: 'application/pdf',
      filename: 'doc.pdf',
    });
  });
});

describe('isSafeMime', () => {
  it('allows image types', () => {
    expect(isSafeMime('image/jpeg')).toBe(true);
    expect(isSafeMime('image/png')).toBe(true);
    expect(isSafeMime('image/webp')).toBe(true);
  });

  it('allows audio types', () => {
    expect(isSafeMime('audio/ogg')).toBe(true);
    expect(isSafeMime('audio/mpeg')).toBe(true);
  });

  it('allows video types', () => {
    expect(isSafeMime('video/mp4')).toBe(true);
  });

  it('allows document types', () => {
    expect(isSafeMime('application/pdf')).toBe(true);
    expect(isSafeMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });

  it('blocks executable types', () => {
    expect(isSafeMime('application/x-executable')).toBe(false);
    expect(isSafeMime('application/x-msdos-program')).toBe(false);
  });

  it('blocks script types', () => {
    expect(isSafeMime('application/javascript')).toBe(false);
    expect(isSafeMime('application/x-sh')).toBe(false);
  });
});

describe('downloadAndSaveMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when message has no media', async () => {
    const msg = makeMessage({
      message: { conversation: 'text only' } as unknown as WAMessage['message'],
    });
    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');
    expect(result).toBeNull();
    expect(mockDownloadMediaMessage).not.toHaveBeenCalled();
  });

  it('returns null when message has no ID', async () => {
    const msg = makeMessage({
      key: { id: undefined as unknown as string, remoteJid: 'group@g.us' },
      message: { imageMessage: { mimetype: 'image/jpeg' } } as unknown as WAMessage['message'],
    });
    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');
    expect(result).toBeNull();
  });

  it('returns null for unsafe MIME type', async () => {
    const msg = makeMessage({
      key: { id: 'msg-unsafe', remoteJid: 'group@g.us' },
      message: { documentMessage: { mimetype: 'application/x-executable' } } as unknown as WAMessage['message'],
    });
    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');
    expect(result).toBeNull();
    expect(mockDownloadMediaMessage).not.toHaveBeenCalled();
  });

  it('downloads and saves image with deterministic filename', async () => {
    const buffer = Buffer.from('fake-image-data');
    mockDownloadMediaMessage.mockResolvedValue(buffer);

    const msg = makeMessage({
      key: { id: 'img-001', remoteJid: 'group@g.us' },
      message: { imageMessage: { mimetype: 'image/jpeg' } } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');

    expect(result).toEqual({
      filePath: '/groups/test-group/media/img-001.jpg',
      containerPath: '/workspace/group/media/img-001.jpg',
      mediaType: 'image',
      mimetype: 'image/jpeg',
      filename: undefined,
    });
    expect(mockMkdirSync).toHaveBeenCalledWith('/groups/test-group/media', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith('/groups/test-group/media/img-001.jpg', buffer);
  });

  it('uses correct extension for video/mp4', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('video'));

    const msg = makeMessage({
      key: { id: 'vid-001', remoteJid: 'group@g.us' },
      message: { videoMessage: { mimetype: 'video/mp4' } } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'my-group', '/groups');
    expect(result!.filePath).toBe('/groups/my-group/media/vid-001.mp4');
  });

  it('uses correct extension for audio/ogg opus', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('audio'));

    const msg = makeMessage({
      key: { id: 'aud-001', remoteJid: 'group@g.us' },
      message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'my-group', '/groups');
    expect(result!.filePath).toBe('/groups/my-group/media/aud-001.ogg');
  });

  it('uses correct extension for PDF document', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('pdf'));

    const msg = makeMessage({
      key: { id: 'doc-001', remoteJid: 'group@g.us' },
      message: { documentMessage: { mimetype: 'application/pdf' } } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'my-group', '/groups');
    expect(result!.filePath).toBe('/groups/my-group/media/doc-001.pdf');
  });

  it('uses document original filename extension', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('data'));

    const msg = makeMessage({
      key: { id: 'doc-002', remoteJid: 'group@g.us' },
      message: {
        documentMessage: { mimetype: 'application/octet-stream', fileName: 'report.xlsx' },
      } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');
    expect(result!.filePath).toBe('/groups/test-group/media/doc-002.xlsx');
    expect(result!.filename).toBe('report.xlsx');
  });

  it('falls back to DEFAULT_EXTENSIONS for unknown mimetype', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('data'));

    const msg = makeMessage({
      key: { id: 'img-002', remoteJid: 'group@g.us' },
      message: { imageMessage: { mimetype: 'image/x-custom' } } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');
    expect(result!.filePath).toBe('/groups/test-group/media/img-002.jpg');
  });

  it('falls back to bin for document with unknown mimetype', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('data'));

    const msg = makeMessage({
      key: { id: 'doc-003', remoteJid: 'group@g.us' },
      message: { documentMessage: { mimetype: 'application/x-unknown' } } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');
    expect(result).toBeNull(); // x-unknown is not in SAFE_MIME_PREFIXES
  });

  it('returns null and logs warning on download failure', async () => {
    mockDownloadMediaMessage.mockRejectedValue(new Error('Network error'));

    const msg = makeMessage({
      key: { id: 'fail-001', remoteJid: 'group@g.us' },
      message: { imageMessage: { mimetype: 'image/jpeg' } } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');
    expect(result).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('handles media inside nested ephemeral container', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('ephemeral-image'));

    const msg = makeMessage({
      key: { id: 'eph-001', remoteJid: 'group@g.us' },
      message: {
        ephemeralMessage: {
          message: { imageMessage: { mimetype: 'image/png' } },
        },
      } as unknown as WAMessage['message'],
    });

    const result = await downloadAndSaveMedia(msg, 'test-group', '/groups');
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image');
    expect(result!.filePath).toBe('/groups/test-group/media/eph-001.png');
  });
});
