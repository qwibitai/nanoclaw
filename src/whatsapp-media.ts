import fs from 'fs';
import path from 'path';

import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';

import { logger } from './logger.js';

export interface MediaInfo {
  type: string;
  mediaKey: string;
  mimetype: string;
  filename?: string;
}

export interface MediaResult {
  filePath: string;
  containerPath: string;
  mediaType: string;
  mimetype: string;
  filename?: string;
}

// Map WhatsApp message keys to human-readable media type
const MEDIA_MESSAGE_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

const MEDIA_KEY_TO_TYPE: Record<string, string> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

// Safe MIME types we'll download (block executables, scripts, etc.)
const SAFE_MIME_PREFIXES = [
  'image/',
  'audio/',
  'video/',
  'text/',
  'application/pdf',
  'application/json',
  'application/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/octet-stream',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/msword',
];

// Extension lookup for common MIME types
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
};

// Fallback extensions per media type when MIME lookup fails
const DEFAULT_EXTENSIONS: Record<string, string> = {
  imageMessage: 'jpg',
  videoMessage: 'mp4',
  audioMessage: 'ogg',
  documentMessage: 'bin',
  stickerMessage: 'webp',
};

/**
 * Unwrap nested WhatsApp message containers.
 * WhatsApp wraps media in ephemeral, viewOnce, and documentWithCaption containers.
 */
export function unwrapMessage(
  message: WAMessage['message'],
): NonNullable<WAMessage['message']> | null {
  if (!message) return null;

  let inner = message;
  if (inner.ephemeralMessage?.message)
    inner = inner.ephemeralMessage.message;
  if (inner.viewOnceMessage?.message)
    inner = inner.viewOnceMessage.message;
  if (inner.viewOnceMessageV2?.message)
    inner = inner.viewOnceMessageV2.message;
  if (inner.documentWithCaptionMessage?.message)
    inner = inner.documentWithCaptionMessage.message;

  return inner;
}

export function isSafeMime(mime: string): boolean {
  return SAFE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

/**
 * Detect media info from a WhatsApp message.
 * Returns null for text-only messages or messages with no content.
 * Unwraps nested containers (ephemeral, viewOnce, etc.) before checking.
 */
export function getMediaInfo(msg: WAMessage): MediaInfo | null {
  const inner = unwrapMessage(msg.message);
  if (!inner) return null;

  for (const key of MEDIA_MESSAGE_KEYS) {
    const mediaMsg = inner[key];
    if (mediaMsg) {
      const typed = mediaMsg as { mimetype?: string; fileName?: string };
      return {
        type: MEDIA_KEY_TO_TYPE[key],
        mediaKey: key,
        mimetype: typed.mimetype || '',
        filename: typed.fileName,
      };
    }
  }

  return null;
}

function getExtension(mime: string, mediaKey: string, filename?: string): string {
  if (filename) {
    const ext = path.extname(filename).slice(1);
    if (ext) return ext;
  }
  return MIME_TO_EXT[mime] || DEFAULT_EXTENSIONS[mediaKey] || 'bin';
}

/**
 * Download media from a WhatsApp message and save to disk.
 * Returns null if no media, unsafe MIME, or download failure.
 * Uses deterministic filenames based on message ID.
 */
export async function downloadAndSaveMedia(
  msg: WAMessage,
  groupFolder: string,
  groupsDir: string,
): Promise<MediaResult | null> {
  const info = getMediaInfo(msg);
  if (!info) return null;

  const msgId = msg.key.id;
  if (!msgId) return null;

  if (!isSafeMime(info.mimetype)) {
    logger.info(
      { mime: info.mimetype, mediaKey: info.mediaKey },
      'Skipping unsafe media MIME type',
    );
    return null;
  }

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});

    const ext = getExtension(info.mimetype, info.mediaKey, info.filename);
    const filename = `${msgId}.${ext}`;

    const mediaDir = path.join(groupsDir, groupFolder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const filePath = path.join(mediaDir, filename);
    fs.writeFileSync(filePath, buffer as Buffer);

    const containerPath = `/workspace/group/media/${filename}`;

    logger.info(
      { msgId, type: info.type, mime: info.mimetype, size: (buffer as Buffer).length },
      'Media downloaded',
    );

    return {
      filePath,
      containerPath,
      mediaType: info.type,
      mimetype: info.mimetype,
      filename: info.filename,
    };
  } catch (err) {
    logger.warn(
      { msgId, type: info.type, mime: info.mimetype, err },
      'Failed to download media',
    );
    return null;
  }
}
