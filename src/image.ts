import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { WAMessage } from '@whiskeysockets/baileys';

const MAX_DIMENSION = 1024;
const IMAGE_REF_PATTERN =
  /\[(?:Image|GIF frame|Video frame): (attachments\/[^\]]+)\]/g;

export interface ProcessedImage {
  content: string;
  relativePath: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

export function isImageMessage(msg: WAMessage): boolean {
  return !!msg.message?.imageMessage;
}

export function isVideoMessage(msg: WAMessage): boolean {
  return !!msg.message?.videoMessage;
}

export async function extractVideoFrame(
  videoBuffer: Buffer,
  groupDir: string,
): Promise<string> {
  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const tmpVideo = path.join(attachDir, `tmp-video-${Date.now()}.mp4`);
  const framePath = path.join(
    attachDir,
    `frame-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`,
  );
  fs.writeFileSync(tmpVideo, videoBuffer);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-i', tmpVideo, '-vframes', '1', '-q:v', '2', framePath],
        { timeout: 10000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return framePath;
  } finally {
    try {
      fs.unlinkSync(tmpVideo);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function processImage(
  buffer: Buffer,
  groupDir: string,
  caption: string,
): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  // Validate sharp output — corrupt input can produce tiny/invalid buffers
  if (resized.length < 1024 || resized[0] !== 0xff || resized[1] !== 0xd8) {
    return null;
  }

  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const filePath = path.join(attachDir, filename);
  fs.writeFileSync(filePath, resized);

  const relativePath = `attachments/${filename}`;
  const content = caption
    ? `[Image: ${relativePath}] ${caption}`
    : `[Image: ${relativePath}]`;

  return { content, relativePath };
}

export function parseImageReferences(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
  const refs: ImageAttachment[] = [];
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    IMAGE_REF_PATTERN.lastIndex = 0;
    while ((match = IMAGE_REF_PATTERN.exec(msg.content)) !== null) {
      // Always JPEG — processImage() normalizes all images to .jpg
      refs.push({ relativePath: match[1], mediaType: 'image/jpeg' });
    }
  }
  return refs;
}
