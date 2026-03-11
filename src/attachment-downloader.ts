/**
 * Attachment downloader — central utility for all channels.
 * Downloads attachments to data/attachments/{groupFolder}/{messageId}/,
 * resizes images for Claude vision, enforces size limits, and handles cleanup.
 */
import fs from 'fs';
import path from 'path';

import sharp from 'sharp';

import {
  ATTACHMENTS_DIR,
  ATTACHMENT_CLEANUP_HOURS,
  MAX_DOCUMENT_SIZE,
  MAX_IMAGE_SIZE,
} from './config.js';
import { logger } from './logger.js';
import { Attachment } from './types.js';

// Claude's max processing resolution — images larger than this are resized
const MAX_IMAGE_DIMENSION = 1568;

export interface DownloadRequest {
  messageId: string;
  groupFolder: string;
  filename: string;
  mimeType: string;
  expectedSize?: number; // Pre-download size check (from platform metadata)
  fetchFn: () => Promise<Buffer>;
}

/** Sanitize a path segment to prevent path traversal and problematic characters. */
function sanitizePathSegment(segment: string): string {
  const sanitized = segment
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_') // strip leading dots
    .slice(0, 200);
  return sanitized || 'unnamed';
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

function isAudioMime(mimeType: string): boolean {
  return mimeType.startsWith('audio/');
}

/**
 * Resize an image if it exceeds Claude's processing resolution.
 * Returns the resized buffer, or the original if already within limits.
 */
async function resizeImageIfNeeded(buffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer).metadata();
    const { width, height } = metadata;
    if (!width || !height) return buffer;

    if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
      return buffer;
    }

    const resized = await sharp(buffer)
      .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: 'inside' })
      .toBuffer();

    logger.debug(
      { original: `${width}x${height}`, resizedSize: resized.length },
      'Image resized for Claude vision',
    );
    return resized;
  } catch (err) {
    logger.warn({ err }, 'Failed to resize image, using original');
    return buffer;
  }
}

/**
 * Download an attachment and save it to the attachments directory.
 * Never throws — returns null on failure so attachment errors don't block messages.
 */
export async function downloadAttachment(
  req: DownloadRequest,
): Promise<Attachment | null> {
  try {
    // Skip audio files (handled by voice transcription skill)
    if (isAudioMime(req.mimeType)) {
      logger.debug(
        { filename: req.filename, mimeType: req.mimeType },
        'Skipping audio attachment',
      );
      return null;
    }

    const maxSize = isImageMime(req.mimeType)
      ? MAX_IMAGE_SIZE
      : MAX_DOCUMENT_SIZE;

    // Reject oversized files before downloading (prevents OOM from large uploads)
    if (req.expectedSize && req.expectedSize > maxSize) {
      logger.warn(
        {
          filename: req.filename,
          expectedSize: req.expectedSize,
          maxSize,
          mimeType: req.mimeType,
        },
        'Attachment exceeds size limit (pre-download check), skipping',
      );
      return null;
    }

    let buffer = await req.fetchFn();

    // Post-download size check (catches cases where expectedSize was unavailable)
    if (buffer.length > maxSize) {
      logger.warn(
        {
          filename: req.filename,
          size: buffer.length,
          maxSize,
          mimeType: req.mimeType,
        },
        'Attachment exceeds size limit, skipping',
      );
      return null;
    }

    // Resize images that exceed Claude's processing resolution
    if (isImageMime(req.mimeType)) {
      buffer = await resizeImageIfNeeded(buffer);
    }

    // Save to data/attachments/{groupFolder}/{messageId}/
    const safeFilename = sanitizePathSegment(req.filename);
    const safeMessageId = sanitizePathSegment(req.messageId);
    const dir = path.join(ATTACHMENTS_DIR, req.groupFolder, safeMessageId);
    fs.mkdirSync(dir, { recursive: true });

    const localPath = path.join(dir, safeFilename);
    fs.writeFileSync(localPath, buffer);

    // Ensure container user (uid 1000) can read the file
    if (process.getuid?.() === 0) {
      try {
        fs.chownSync(dir, 1000, 1000);
        fs.chownSync(localPath, 1000, 1000);
      } catch {
        // best-effort
      }
    }

    logger.info(
      {
        filename: safeFilename,
        size: buffer.length,
        mimeType: req.mimeType,
        group: req.groupFolder,
      },
      'Attachment downloaded',
    );

    return {
      filename: safeFilename,
      mimeType: req.mimeType,
      localPath,
      size: buffer.length,
    };
  } catch (err) {
    logger.error(
      { filename: req.filename, group: req.groupFolder, err },
      'Failed to download attachment',
    );
    return null;
  }
}

/**
 * Remove attachment directories older than maxAgeHours.
 * Called periodically from the session sweep.
 */
export function cleanupOldAttachments(
  maxAgeHours: number = ATTACHMENT_CLEANUP_HOURS,
): void {
  if (!fs.existsSync(ATTACHMENTS_DIR)) return;

  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    for (const groupDir of fs.readdirSync(ATTACHMENTS_DIR)) {
      const groupPath = path.join(ATTACHMENTS_DIR, groupDir);
      if (!fs.statSync(groupPath).isDirectory()) continue;

      for (const msgDir of fs.readdirSync(groupPath)) {
        const msgPath = path.join(groupPath, msgDir);
        if (!fs.statSync(msgPath).isDirectory()) continue;

        const stat = fs.statSync(msgPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(msgPath, { recursive: true, force: true });
          cleaned++;
        }
      }

      // Remove empty group directories
      try {
        fs.rmdirSync(groupPath);
      } catch {
        // not empty
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error during attachment cleanup');
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up old attachments');
  }
}
