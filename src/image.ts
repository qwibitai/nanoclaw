/**
 * Image processing for NanoClaw
 * Downloads, resizes, and base64-encodes images for multimodal agent input.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

import { log } from './log.js';

export interface ImageAttachment {
  /** Base64-encoded image data */
  base64: string;
  /** MIME type (e.g., image/jpeg) */
  mimeType: string;
  /** Path where image was saved in group workspace */
  filePath: string;
}

const MAX_DIMENSION = 1024;
const JPEG_QUALITY = 80;

/**
 * Process a raw image buffer: resize to fit within MAX_DIMENSION and encode as JPEG.
 * Returns base64 data and saves to the specified path.
 */
export async function processImage(buffer: Buffer, savePath: string): Promise<ImageAttachment> {
  const dir = path.dirname(savePath);
  fs.mkdirSync(dir, { recursive: true });

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  fs.writeFileSync(savePath, resized);

  const base64 = resized.toString('base64');

  log.info('Processed image attachment', {
    savePath,
    originalSize: buffer.length,
    processedSize: resized.length,
  });

  return {
    base64,
    mimeType: 'image/jpeg',
    filePath: savePath,
  };
}

/**
 * Download a file from a URL into a buffer.
 */
export async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
