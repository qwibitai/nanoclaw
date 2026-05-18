import { describe, it, expect } from 'vitest';
import { isSupportedImageMime } from './image.js';

describe('isSupportedImageMime', () => {
  it('accepts image/jpeg', () => {
    expect(isSupportedImageMime('image/jpeg')).toBe(true);
  });
  it('accepts image/png', () => {
    expect(isSupportedImageMime('image/png')).toBe(true);
  });
  it('accepts image/gif', () => {
    expect(isSupportedImageMime('image/gif')).toBe(true);
  });
  it('accepts image/webp', () => {
    expect(isSupportedImageMime('image/webp')).toBe(true);
  });
  it('accepts image/heic', () => {
    expect(isSupportedImageMime('image/heic')).toBe(true);
  });
  it('accepts image/heif', () => {
    expect(isSupportedImageMime('image/heif')).toBe(true);
  });
  it('accepts image/avif', () => {
    expect(isSupportedImageMime('image/avif')).toBe(true);
  });
  it('rejects application/pdf', () => {
    expect(isSupportedImageMime('application/pdf')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isSupportedImageMime('')).toBe(false);
  });
  it('rejects undefined-shaped input', () => {
    expect(isSupportedImageMime(undefined as unknown as string)).toBe(false);
  });
});

import sharp from 'sharp';
import { processImageBuffer, type ImageAttachment } from './image.js';

async function makePngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 64, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

describe('processImageBuffer', () => {
  it('resizes a large image so long edge is at most 1568px', async () => {
    const buf = await makePngBuffer(3000, 2000);
    const att = await processImageBuffer(buf, 'image/png');
    expect(att).not.toBeNull();
    const decoded = Buffer.from(att!.data, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
  });

  it('re-encodes as JPEG (mediaType = image/jpeg) after resize', async () => {
    const buf = await makePngBuffer(3000, 2000);
    const att = await processImageBuffer(buf, 'image/png');
    expect(att!.mediaType).toBe('image/jpeg');
  });

  it('passes through small images without upscaling', async () => {
    const buf = await makePngBuffer(800, 600);
    const att = await processImageBuffer(buf, 'image/png');
    const decoded = Buffer.from(att!.data, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBeLessThanOrEqual(800);
    expect(meta.height).toBeLessThanOrEqual(600);
  });

  it('returns null when buffer cannot be decoded', async () => {
    const bogus = Buffer.from('not-an-image');
    const att = await processImageBuffer(bogus, 'image/png');
    expect(att).toBeNull();
  });

  it('base64 output decodes back to a valid image', async () => {
    const buf = await makePngBuffer(400, 300);
    const att = await processImageBuffer(buf, 'image/png');
    const decoded = Buffer.from(att!.data, 'base64');
    await expect(sharp(decoded).metadata()).resolves.toBeTruthy();
  });

  it('decodes HEIF/AVIF input and re-encodes as JPEG', async () => {
    // libheif (bundled with sharp) writes HEIF as .avif. We round-trip a
    // synthetic AVIF buffer through processImageBuffer to prove the
    // pipeline accepts HEIF-family inputs from real iPhone Photos.
    const avif = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 10, g: 200, b: 80 },
      },
    })
      .heif({ compression: 'av1' })
      .toBuffer();
    const att = await processImageBuffer(avif, 'image/heic');
    expect(att).not.toBeNull();
    expect(att!.mediaType).toBe('image/jpeg');
    const decoded = Buffer.from(att!.data, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(meta.format).toBe('jpeg');
  });
});
