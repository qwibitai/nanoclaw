import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { WAMessage } from '@whiskeysockets/baileys';
import { readEnvFile } from './env.js';

const MAX_DIMENSION = 1024;
const IMAGE_REF_PATTERN =
  /\[(?:Image|GIF frame|Video frame): (attachments\/[^\]|\s]+)(?:\s*\|\s*(https?:\/\/[^\]]+))?\]/g;

export interface ProcessedImage {
  content: string;
  relativePath: string;
  publicUrl?: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
  publicUrl?: string;
}

const EASYBITS_BASE_URL = 'https://www.easybits.cloud/api/v2';

export async function uploadToEasyBits(
  buffer: Buffer,
  fileName: string,
  contentType = 'image/jpeg',
): Promise<string | null> {
  let apiKey = process.env.EASYBITS_API_KEY || '';
  if (!apiKey) {
    try {
      apiKey = readEnvFile(['EASYBITS_API_KEY']).EASYBITS_API_KEY || '';
    } catch {
      // .env not available
    }
  }
  if (!apiKey) return null;

  try {
    const createRes = await fetch(`${EASYBITS_BASE_URL}/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName,
        contentType,
        size: buffer.length,
        access: 'public',
      }),
    });
    if (!createRes.ok) return null;

    const { file, putUrl } = (await createRes.json()) as {
      file: { url?: string; readUrl?: string };
      putUrl: string;
    };

    const uploadRes = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: buffer,
    });
    if (!uploadRes.ok) return null;

    return file.url || file.readUrl || null;
  } catch {
    return null;
  }
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
  const publicUrl = await uploadToEasyBits(resized, filename);
  const imageRef = publicUrl
    ? `[Image: ${relativePath} | ${publicUrl}]`
    : `[Image: ${relativePath}]`;
  const content = caption ? `${imageRef} ${caption}` : imageRef;

  return { content, relativePath, publicUrl: publicUrl ?? undefined };
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
      refs.push({
        relativePath: match[1],
        mediaType: 'image/jpeg',
        ...(match[2] && { publicUrl: match[2].trim() }),
      });
    }
  }
  return refs;
}
