import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ATTACHMENT_MAX_SIZE } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { Attachment, NewMessage } from './types.js';

const INLINE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);

// Magic byte signatures for MIME detection
const SIGNATURES: Array<{
  bytes: number[];
  offset?: number;
  mime: string;
}> = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  // WebP: RIFF at 0, WEBP at 8
  { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8, mime: 'image/webp' },
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  // ZIP-based (xlsx, docx, pptx, etc.)
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' },
];

const EXTENSION_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export interface SavedAttachment {
  path: string; // Container-relative: attachments/{uuid}-{filename}
  mimeType: string; // Validated via magic bytes
  mode: 'inline' | 'file';
}

interface FailedAttachment {
  error: string;
}

type DownloadResult = SavedAttachment | FailedAttachment;

function isFailedAttachment(r: DownloadResult): r is FailedAttachment {
  return 'error' in r;
}

export function detectMimeType(buffer: Buffer, filename?: string): string {
  // Check magic bytes
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (buffer.length < offset + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => buffer[offset + i] === b)) {
      return sig.mime;
    }
  }

  // Check if content looks like UTF-8 text (no null bytes in first 8KB)
  const sampleSize = Math.min(buffer.length, 8192);
  let looksLikeText = buffer.length > 0;
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) {
      looksLikeText = false;
      break;
    }
  }

  if (looksLikeText && filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.txt' || ext === '.csv' || ext === '.html' || ext === '.md') {
      return EXTENSION_MAP[ext] ?? 'text/plain';
    }
  }

  // Fall back to extension mapping
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext in EXTENSION_MAP) return EXTENSION_MAP[ext];
  }

  return 'application/octet-stream';
}

export function classifyMode(mimeType: string): 'inline' | 'file' {
  return INLINE_MIME_TYPES.has(mimeType) ? 'inline' : 'file';
}

function sanitizeFilename(filename: string): string {
  return (
    filename
      // Strip path separators and null bytes
      .replace(/[/\\:\0]/g, '')
      // Strip leading dots (no hidden files)
      .replace(/^\.+/, '')
      // Truncate
      .slice(0, 100) || 'attachment'
  );
}

function ensureAttachmentsDir(groupFolder: string): string {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const attachmentsDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  return attachmentsDir;
}

async function downloadAndSave(
  attachment: Attachment,
  groupFolder: string,
): Promise<DownloadResult> {
  try {
    const headers: Record<string, string> = {};
    if (attachment.authHeaders) {
      Object.assign(headers, attachment.authHeaders);
    }

    const response = await fetch(attachment.url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }

    // Stream body with size limit
    const reader = response.body?.getReader();
    if (!reader) return { error: 'no response body' };

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > ATTACHMENT_MAX_SIZE) {
        reader.cancel();
        return {
          error: `exceeds ${ATTACHMENT_MAX_SIZE / 1024 / 1024}MB limit`,
        };
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks);
    const mimeType = detectMimeType(buffer, attachment.filename);
    const mode = classifyMode(mimeType);

    const attachmentsDir = ensureAttachmentsDir(groupFolder);

    const id = crypto.randomUUID();
    const safeName = sanitizeFilename(attachment.filename);
    const diskFilename = `${id}-${safeName}`;
    const diskPath = path.join(attachmentsDir, diskFilename);
    fs.writeFileSync(diskPath, buffer);

    logger.info(
      {
        groupFolder,
        filename: safeName,
        mimeType,
        mode,
        size: buffer.length,
      },
      'Attachment saved',
    );

    return {
      path: `attachments/${diskFilename}`,
      mimeType,
      mode,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { groupFolder, url: attachment.url, error: message },
      'Attachment download failed',
    );
    return { error: message };
  }
}

/**
 * Download and annotate attachments for a batch of messages.
 * Downloads in parallel. Returns saved attachments for multimodal content block construction.
 */
export async function processAttachments(
  messages: NewMessage[],
  groupFolder: string,
  maxPerMessage: number,
): Promise<SavedAttachment[]> {
  const saved: SavedAttachment[] = [];
  const jobs: Array<{
    msg: NewMessage;
    att: Attachment;
    resultPromise: Promise<DownloadResult>;
  }> = [];

  for (const msg of messages) {
    if (!msg.attachments?.length) continue;
    for (const att of msg.attachments.slice(0, maxPerMessage)) {
      jobs.push({
        msg,
        att,
        resultPromise: downloadAndSave(att, groupFolder),
      });
    }
  }

  if (jobs.length === 0) return saved;

  const results = await Promise.all(jobs.map((j) => j.resultPromise));

  for (let i = 0; i < jobs.length; i++) {
    const { msg, att } = jobs[i];
    const result = results[i];

    if (isFailedAttachment(result)) {
      msg.content += `\n[Attachment failed: ${att.filename} — ${result.error}]`;
    } else {
      saved.push(result);
      if (result.mode === 'inline') {
        msg.content += `\n[Attached: ${att.filename}]`;
      } else {
        msg.content += `\n[File: ${att.filename} at /workspace/group/${result.path}]`;
      }
    }
  }

  return saved;
}
