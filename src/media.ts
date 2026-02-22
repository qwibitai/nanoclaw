/**
 * Media handling utilities for NanoClaw
 * Detects, saves, and formats media attachments from WhatsApp messages
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface MediaInfo {
  type: 'image' | 'document';
  mimetype: string;
  filename?: string;
  caption?: string;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

/**
 * Detect media in a Baileys WAMessage.
 * Returns media info if the message contains a supported attachment, null otherwise.
 * Skips voice messages (ptt), stickers, and videos (too large).
 */
export function getMediaInfo(msg: { message?: Record<string, any> | null }): MediaInfo | null {
  if (!msg.message) return null;

  if (msg.message.imageMessage) {
    return {
      type: 'image',
      mimetype: msg.message.imageMessage.mimetype || 'image/jpeg',
      caption: msg.message.imageMessage.caption || undefined,
    };
  }

  if (msg.message.documentMessage) {
    return {
      type: 'document',
      mimetype: msg.message.documentMessage.mimetype || 'application/octet-stream',
      filename: msg.message.documentMessage.fileName || undefined,
      caption: msg.message.documentMessage.caption || undefined,
    };
  }

  // Handle documentWithCaptionMessage wrapper (WhatsApp sometimes wraps documents)
  if (msg.message.documentWithCaptionMessage?.message?.documentMessage) {
    const doc = msg.message.documentWithCaptionMessage.message.documentMessage;
    return {
      type: 'document',
      mimetype: doc.mimetype || 'application/octet-stream',
      filename: doc.fileName || undefined,
      caption: doc.caption || undefined,
    };
  }

  return null;
}

/**
 * Save a media buffer to the group's media directory.
 * Returns the filename (relative to media/).
 */
export function saveMediaToGroup(
  groupFolder: string,
  buffer: Buffer,
  mediaInfo: MediaInfo,
): string {
  const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = crypto.randomBytes(4).toString('hex');

  let filename: string;
  if (mediaInfo.filename) {
    // Sanitize original filename, prepend timestamp for uniqueness
    const safe = mediaInfo.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    filename = `${timestamp}_${safe}`;
  } else {
    const ext = MIME_TO_EXT[mediaInfo.mimetype] || '';
    filename = `${timestamp}_${id}${ext}`;
  }

  const filePath = path.join(mediaDir, filename);
  fs.writeFileSync(filePath, buffer);
  logger.info({ groupFolder, filename, size: buffer.length }, 'Media saved');

  return filename;
}

/**
 * Format the message content to include media attachment info.
 * The container path tells the agent where to find the file.
 */
export function formatMediaContent(
  mediaInfo: MediaInfo,
  containerPath: string,
  originalContent: string,
): string {
  const parts: string[] = [];

  if (mediaInfo.type === 'image') {
    parts.push(`[Image attached: ${containerPath}]`);
  } else if (mediaInfo.mimetype === 'application/pdf') {
    parts.push(`[PDF attached: ${mediaInfo.filename || 'document.pdf'} — ${containerPath}]`);
  } else {
    const name = mediaInfo.filename || 'file';
    parts.push(`[Document attached: ${name} — ${containerPath}]`);
  }

  // Add caption/original text if present
  if (originalContent) {
    parts.push(originalContent);
  }

  return parts.join('\n');
}
