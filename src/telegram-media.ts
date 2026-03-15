/**
 * Telegram media download and processing.
 * Downloads photos/videos from Telegram, saves to group media directory,
 * and prepares image data for multimodal Claude content blocks.
 */
import fs from 'fs';
import path from 'path';
import { Bot } from 'grammy';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface MediaResult {
  /** Absolute path on host filesystem */
  localPath: string;
  /** Path inside the container (/workspace/group/media/...) */
  containerPath: string;
  /** Base64-encoded image data (photos only) */
  base64?: string;
  /** MIME type (e.g., image/jpeg, video/mp4) */
  mimeType: string;
  /** Media type */
  type: 'photo' | 'video';
}

export interface MediaFile {
  containerPath: string;
  base64: string;
  mimeType: string;
}

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * Download a file from Telegram and save to the group's media directory.
 */
export async function downloadTelegramMedia(
  bot: Bot,
  botToken: string,
  fileId: string,
  groupFolder: string,
  messageId: string,
  type: 'photo' | 'video',
): Promise<MediaResult> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram returned no file_path for file_id');
  }

  const ext =
    path.extname(file.file_path) || (type === 'photo' ? '.jpg' : '.mp4');
  const filename = `${type}_${messageId}_${Date.now()}${ext}`;
  const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const localPath = path.join(mediaDir, filename);
  const containerPath = `/workspace/group/media/${filename}`;

  // Download from Telegram file API
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  const mimeType = getMimeType(localPath);
  let base64: string | undefined;

  if (type === 'photo') {
    // Resize large photos to reduce token cost
    try {
      const sharp = (await import('sharp')).default;
      const resized = await sharp(buffer)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      fs.writeFileSync(localPath, resized);
      base64 = resized.toString('base64');
    } catch {
      // sharp not available — use raw image
      base64 = buffer.toString('base64');
      logger.warn('sharp not available, using raw image for vision');
    }
  }

  const result: MediaResult = {
    localPath,
    containerPath,
    mimeType: type === 'photo' ? 'image/jpeg' : mimeType,
    type,
    base64,
  };

  // Write sidecar JSON for the container pipeline to pick up
  if (base64) {
    const sidecar: MediaFile = {
      containerPath,
      base64,
      mimeType: result.mimeType,
    };
    fs.writeFileSync(`${localPath}.media.json`, JSON.stringify(sidecar));
  }

  logger.info(
    { type, groupFolder, localPath, size: buffer.length },
    'Telegram media downloaded',
  );
  return result;
}

/**
 * Load media sidecar files for a group. Returns all pending media files
 * and cleans up the sidecar JSON files after reading.
 */
export function loadAndCleanMediaFiles(groupFolder: string): MediaFile[] {
  const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
  if (!fs.existsSync(mediaDir)) return [];

  const files: MediaFile[] = [];
  for (const name of fs.readdirSync(mediaDir)) {
    if (!name.endsWith('.media.json')) continue;
    const sidecarPath = path.join(mediaDir, name);
    try {
      const data: MediaFile = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      files.push(data);
      fs.unlinkSync(sidecarPath); // consume once
    } catch (err) {
      logger.warn({ sidecarPath, err }, 'Failed to read media sidecar');
      try {
        fs.unlinkSync(sidecarPath);
      } catch {
        /* ignore */
      }
    }
  }
  return files;
}
