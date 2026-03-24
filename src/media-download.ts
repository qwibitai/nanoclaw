import fs from 'fs';
import path from 'path';

import { downloadMediaMessage, WAMessage, WASocket } from '@whiskeysockets/baileys';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

const MEDIA_DIR = path.join(STORE_DIR, 'media');

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
};

export function isMediaMessage(msg: WAMessage): boolean {
  return !!(msg.message?.imageMessage || msg.message?.documentMessage);
}

export async function downloadAndSaveMedia(
  msg: WAMessage,
  sock: WASocket,
): Promise<string> {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const buffer = (await downloadMediaMessage(
    msg,
    'buffer',
    {},
    {
      logger: console as any,
      reuploadRequest: sock.updateMediaMessage,
    },
  )) as Buffer;

  if (!buffer || buffer.length === 0) {
    throw new Error('Empty media buffer');
  }

  const media = msg.message?.imageMessage || msg.message?.documentMessage;
  const mimetype = media?.mimetype || 'application/octet-stream';
  const ext = MIME_EXT[mimetype] || '.' + mimetype.split('/')[1] || '.bin';
  const filename = `${msg.key.id}${ext}`;
  const filePath = path.join(MEDIA_DIR, filename);

  fs.writeFileSync(filePath, buffer);
  logger.info({ filePath, bytes: buffer.length, mimetype }, 'Media saved');

  return filePath;
}
