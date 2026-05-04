/**
 * Telegram inbound attachment handling — parse, download, and normalize.
 *
 * Channel-agnostic contract: every adapter (Telegram, WhatsApp/Twilio,
 * Slack) implements its own fetcher behind the shared InboundAttachment
 * interface in adapter.ts. This module is the Telegram implementation.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { InboundAttachment } from './adapter.js';

const TELEGRAM_MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB bot API limit

export class OversizedAttachmentError extends Error {
  constructor(
    public readonly fileId: string,
    public readonly sizeBytes: number,
  ) {
    super(`File ${fileId} is ${sizeBytes} bytes, exceeding the 20 MB Telegram bot API limit`);
    this.name = 'OversizedAttachmentError';
  }
}

interface TelegramFileObject {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  photo?: TelegramPhotoSize[];
  document?: TelegramFileObject & { file_name?: string; mime_type?: string };
  voice?: TelegramFileObject & { mime_type?: string; duration?: number };
  video?: TelegramFileObject & { mime_type?: string };
  video_note?: TelegramFileObject & { length?: number };
  audio?: TelegramFileObject & { mime_type?: string; file_name?: string };
  caption?: string;
}

export interface ParsedAttachment {
  kind: InboundAttachment['kind'];
  fileId: string;
  mimeType: string;
  originalName?: string;
  sizeBytes: number;
}

/**
 * Extract attachment metadata from a Telegram message object.
 * For photos, picks the highest-resolution variant (last in the array).
 * Returns null if no media is present.
 */
export function parseTelegramAttachments(msg: TelegramMessage): ParsedAttachment | null {
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1]!;
    return {
      kind: 'photo',
      fileId: best.file_id,
      mimeType: 'image/jpeg',
      sizeBytes: best.file_size ?? 0,
    };
  }

  if (msg.document) {
    return {
      kind: 'document',
      fileId: msg.document.file_id,
      mimeType: msg.document.mime_type ?? 'application/octet-stream',
      originalName: msg.document.file_name,
      sizeBytes: msg.document.file_size ?? 0,
    };
  }

  if (msg.voice) {
    return {
      kind: 'voice',
      fileId: msg.voice.file_id,
      mimeType: msg.voice.mime_type ?? 'audio/ogg',
      sizeBytes: msg.voice.file_size ?? 0,
    };
  }

  if (msg.audio) {
    return {
      kind: 'audio',
      fileId: msg.audio.file_id,
      mimeType: msg.audio.mime_type ?? 'audio/mpeg',
      originalName: msg.audio.file_name,
      sizeBytes: msg.audio.file_size ?? 0,
    };
  }

  if (msg.video) {
    return {
      kind: 'video',
      fileId: msg.video.file_id,
      mimeType: msg.video.mime_type ?? 'video/mp4',
      sizeBytes: msg.video.file_size ?? 0,
    };
  }

  if (msg.video_note) {
    return {
      kind: 'video_note',
      fileId: msg.video_note.file_id,
      mimeType: 'video/mp4',
      sizeBytes: msg.video_note.file_size ?? 0,
    };
  }

  return null;
}

export interface DownloadOptions {
  botToken: string;
  fileId: string;
  destDir: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

/**
 * Download a Telegram file to disk. Uses getFile → download two-step.
 * Writes to a temp path then atomic-renames to prevent partial reads.
 *
 * Throws OversizedAttachmentError if the file exceeds 20 MB.
 */
export async function downloadTelegramAttachment(
  opts: DownloadOptions,
): Promise<{ filePath: string; sizeBytes: number }> {
  const { botToken, fileId, destDir, fetchImpl = fetch, apiBaseUrl = 'https://api.telegram.org' } = opts;

  const getFileUrl = `${apiBaseUrl}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const getFileResp = await fetchImpl(getFileUrl);
  if (!getFileResp.ok) {
    throw new Error(`Telegram getFile failed: ${getFileResp.status}`);
  }
  const getFileJson = (await getFileResp.json()) as {
    ok: boolean;
    result?: { file_path?: string; file_size?: number };
  };
  if (!getFileJson.ok || !getFileJson.result?.file_path) {
    throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
  }

  const { file_path, file_size } = getFileJson.result;

  if (file_size && file_size > TELEGRAM_MAX_FILE_BYTES) {
    throw new OversizedAttachmentError(fileId, file_size);
  }

  const downloadUrl = `${apiBaseUrl}/file/bot${botToken}/${file_path}`;
  const downloadResp = await fetchImpl(downloadUrl);
  if (!downloadResp.ok) {
    throw new Error(`Telegram file download failed: ${downloadResp.status}`);
  }

  // Belt-and-suspenders pre-flight: even if getFile.file_size said the
  // file was small, a buggy or hostile upstream could deliver a 500 MB
  // body. Read Content-Length BEFORE buffering the body and reject fast
  // — otherwise `await arrayBuffer()` slurps the whole thing into RAM
  // before we get a chance to refuse, which is an OOM vector for the
  // worker. (Telegram's CDN sets Content-Length reliably; if it's
  // missing we fall through to the post-buffer check below as a last
  // line of defense.)
  const contentLengthHeader = downloadResp.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > TELEGRAM_MAX_FILE_BYTES) {
      throw new OversizedAttachmentError(fileId, contentLength);
    }
  }

  const buffer = Buffer.from(await downloadResp.arrayBuffer());

  if (buffer.length > TELEGRAM_MAX_FILE_BYTES) {
    throw new OversizedAttachmentError(fileId, buffer.length);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const rand = randomBytes(4).toString('hex');
  const ext = path.extname(file_path!) || '';
  const finalName = `${fileId}-${rand}${ext}`;
  const tmpPath = path.join(destDir, `.tmp-${finalName}`);
  const finalPath = path.join(destDir, finalName);

  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, finalPath);

  return { filePath: finalPath, sizeBytes: buffer.length };
}
