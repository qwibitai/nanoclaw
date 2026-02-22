import fs from 'fs';
import path from 'path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';

export interface MediaInfo {
  filePath: string;
  fileName: string;
  mimeType: string;
  caption?: string;
}

/**
 * Download and save media from a WhatsApp message
 * @param message - The WhatsApp message containing media
 * @param groupFolder - The group folder name to save media in
 * @returns MediaInfo if media was downloaded, undefined otherwise
 */
export async function downloadAndSaveMedia(
  message: WAMessage,
  groupFolder: string,
): Promise<MediaInfo | undefined> {
  try {
    const msg = message.message;
    if (!msg) return undefined;

    // Check if message contains media
    const imageMessage = msg.imageMessage;
    const videoMessage = msg.videoMessage;
    const audioMessage = msg.audioMessage;
    const documentMessage = msg.documentMessage;

    if (!imageMessage && !videoMessage && !audioMessage && !documentMessage) {
      return undefined; // No media in this message
    }

    // Determine media type and caption
    let mimeType: string;
    let caption: string | undefined;
    let extension: string;

    if (imageMessage) {
      mimeType = imageMessage.mimetype || 'image/jpeg';
      caption = imageMessage.caption || undefined;
      extension = mimeType.split('/')[1] || 'jpg';
    } else if (videoMessage) {
      mimeType = videoMessage.mimetype || 'video/mp4';
      caption = videoMessage.caption || undefined;
      extension = mimeType.split('/')[1] || 'mp4';
    } else if (audioMessage) {
      mimeType = audioMessage.mimetype || 'audio/ogg';
      extension = mimeType.split('/')[1] || 'ogg';
    } else if (documentMessage) {
      mimeType = documentMessage.mimetype || 'application/octet-stream';
      caption = documentMessage.caption || undefined;
      extension = documentMessage.fileName?.split('.').pop() || 'bin';
    } else {
      return undefined;
    }

    logger.info({ mimeType, hasCaption: !!caption }, 'Downloading media from message');

    // Download media as buffer
    const buffer = await downloadMediaMessage(message, 'buffer', {});

    if (!buffer || buffer.length === 0) {
      logger.warn('Downloaded media buffer is empty');
      return undefined;
    }

    // Create media directory for this group
    const groupDir = path.join(DATA_DIR, '..', 'groups', groupFolder);
    const mediaDir = path.join(groupDir, 'images'); // Using 'images' for backward compatibility
    fs.mkdirSync(mediaDir, { recursive: true });

    // Generate unique filename using timestamp and message ID
    const timestamp = Date.now();
    const messageId = message.key.id || 'unknown';
    const sanitizedId = messageId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
    const fileName = `${timestamp}_${sanitizedId}.${extension}`;
    const filePath = path.join(mediaDir, fileName);

    // Save media to file
    fs.writeFileSync(filePath, buffer);

    logger.info({ filePath, size: buffer.length, mimeType }, 'Media saved successfully');

    return {
      filePath,
      fileName,
      mimeType,
      caption,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to download and save media');
    return undefined;
  }
}

/**
 * Format media info as a message attribute for the agent
 * @param mediaInfo - The media information
 * @returns Formatted string with media details
 */
export function formatMediaAttribute(mediaInfo: MediaInfo): string {
  const attrs = [
    `image="${mediaInfo.filePath}"`,
    `mime="${mediaInfo.mimeType}"`,
  ];
  return attrs.join(' ');
}
