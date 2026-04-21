import sharp from 'sharp';
import { logger } from './logger.js';
import type { ImageAttachment } from './types.js';

export type { ImageAttachment } from './types.js';

const SUPPORTED: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function isSupportedImageMime(mime: string | undefined | null): boolean {
  return !!mime && SUPPORTED.has(mime);
}

const MAX_EDGE_PX = 1568;
const JPEG_QUALITY = 85;
const MAX_ENCODED_BYTES = 5 * 1024 * 1024; // Anthropic per-image ceiling

/**
 * Resize (if needed), re-encode as JPEG, base64-encode.
 * Returns null on decode failure or if the result is still too large.
 */
export async function processImageBuffer(
  buffer: Buffer,
  _sourceMime: string,
): Promise<ImageAttachment | null> {
  try {
    const pipeline = sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: MAX_EDGE_PX,
        height: MAX_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY });

    const out = await pipeline.toBuffer();
    if (out.byteLength > MAX_ENCODED_BYTES) {
      logger.warn(
        { bytes: out.byteLength, max: MAX_ENCODED_BYTES },
        'Image exceeds max size after resize, dropping',
      );
      return null;
    }
    return {
      mediaType: 'image/jpeg',
      data: out.toString('base64'),
    };
  } catch (err) {
    logger.warn({ err }, 'processImageBuffer failed');
    return null;
  }
}
