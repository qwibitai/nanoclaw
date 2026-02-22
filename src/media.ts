/**
 * Media handling utilities for NanoClaw
 * Detects, saves, and formats media attachments from WhatsApp messages
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import exifr from 'exifr';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface GPSData {
  latitude: number;
  longitude: number;
  altitude?: number;
  timestamp?: string;
}

export interface MediaMetadata {
  gps?: GPSData;
  camera?: string;
  timestamp?: string;
  width?: number;
  height?: number;
}

export interface MediaInfo {
  type: 'image' | 'document';
  mimetype: string;
  filename?: string;
  caption?: string;
  metadata?: MediaMetadata;
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
 * Extract EXIF metadata from image buffer
 */
async function extractMetadata(buffer: Buffer, mimetype: string): Promise<MediaMetadata | undefined> {
  // Only extract metadata from images
  if (!mimetype.startsWith('image/')) {
    return undefined;
  }

  try {
    const exif = await exifr.parse(buffer, {
      gps: true,
    });

    if (!exif) return undefined;

    const metadata: MediaMetadata = {};

    // Extract GPS data
    if (exif.latitude && exif.longitude) {
      metadata.gps = {
        latitude: exif.latitude,
        longitude: exif.longitude,
        altitude: exif.GPSAltitude,
        timestamp: exif.GPSDateStamp || exif.DateTimeOriginal,
      };
      logger.info({
        lat: exif.latitude.toFixed(6),
        lon: exif.longitude.toFixed(6)
      }, 'GPS data extracted');
    }

    // Extract camera info
    if (exif.Make || exif.Model) {
      metadata.camera = [exif.Make, exif.Model].filter(Boolean).join(' ');
    }

    // Extract timestamp
    if (exif.DateTimeOriginal || exif.DateTime) {
      metadata.timestamp = exif.DateTimeOriginal || exif.DateTime;
    }

    // Extract dimensions
    if (exif.ExifImageWidth && exif.ExifImageHeight) {
      metadata.width = exif.ExifImageWidth;
      metadata.height = exif.ExifImageHeight;
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch (err) {
    logger.debug({ err }, 'Failed to extract EXIF metadata');
    return undefined;
  }
}

/**
 * Save a media buffer to the group's media directory.
 * Returns the filename (relative to media/).
 */
export async function saveMediaToGroup(
  groupFolder: string,
  buffer: Buffer,
  mediaInfo: MediaInfo,
): Promise<string> {
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

  // Extract metadata from images
  const metadata = await extractMetadata(buffer, mediaInfo.mimetype);
  if (metadata) {
    mediaInfo.metadata = metadata;
  }

  logger.info({ groupFolder, filename, size: buffer.length, hasGPS: !!metadata?.gps }, 'Media saved');

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
    let imageLine = `[Image attached: ${containerPath}`;

    // Add GPS data if available
    if (mediaInfo.metadata?.gps) {
      const { latitude, longitude, altitude } = mediaInfo.metadata.gps;
      imageLine += ` | GPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      if (altitude) {
        imageLine += ` (${altitude.toFixed(1)}m)`;
      }
    }

    // Add camera info if available
    if (mediaInfo.metadata?.camera) {
      imageLine += ` | Camera: ${mediaInfo.metadata.camera}`;
    }

    // Add timestamp if available
    if (mediaInfo.metadata?.timestamp) {
      imageLine += ` | Taken: ${mediaInfo.metadata.timestamp}`;
    }

    imageLine += ']';
    parts.push(imageLine);
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
