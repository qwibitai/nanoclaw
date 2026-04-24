import fs from 'fs';
import path from 'path';

import {
  downloadMediaMessage,
  normalizeMessageContent,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';

import { resolveGroupFolderPath } from './group-folder.js';

/**
 * Returns true if the message is an image (handles forwarded/wrapped messages via normalizeMessageContent).
 */
export function isImageMessage(msg: WAMessage): boolean {
  const normalized = normalizeMessageContent(msg.message);
  return normalized?.imageMessage != null;
}

/**
 * Download the image from a WAMessage.
 * Returns the buffer and mimetype, or null if download fails.
 */
export async function downloadImageMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<{ buffer: Buffer; mimetype: string } | null> {
  const normalized = normalizeMessageContent(msg.message);
  const imageMsg = normalized?.imageMessage;
  if (!imageMsg) return null;

  const buffer = (await downloadMediaMessage(
    msg,
    'buffer',
    {},
    {
      logger: console as any,
      reuploadRequest: sock.updateMediaMessage,
    },
  )) as Buffer;

  if (!buffer || buffer.length === 0) return null;

  return {
    buffer,
    mimetype: imageMsg.mimetype || 'image/jpeg',
  };
}

/**
 * Save image buffer to the group's images/ directory.
 * Returns the container-relative path: /workspace/group/images/<filename>
 */
export function saveImageToGroup(
  groupFolder: string,
  buffer: Buffer,
  mimetype: string,
  messageId: string,
): string {
  const ext =
    mimetype === 'image/png'
      ? 'png'
      : mimetype === 'image/webp'
        ? 'webp'
        : mimetype === 'image/gif'
          ? 'gif'
          : 'jpg';
  const safeId =
    messageId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) ||
    `img-${Date.now()}`;
  const filename = `${safeId}.${ext}`;
  const groupDir = resolveGroupFolderPath(groupFolder);
  const imagesDir = path.join(groupDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, filename), buffer);
  return `/workspace/group/images/${filename}`;
}
