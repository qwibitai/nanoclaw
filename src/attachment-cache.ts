import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile([
  'NANOCLAW_ATTACHMENT_CACHE_TTL_HOURS',
  'NANOCLAW_ATTACHMENT_CACHE_MAX_BYTES',
  'NANOCLAW_ATTACHMENT_MAX_FILE_BYTES',
]);

const ATTACHMENT_CACHE_TTL_HOURS = parseInt(
  process.env.NANOCLAW_ATTACHMENT_CACHE_TTL_HOURS ||
    env.NANOCLAW_ATTACHMENT_CACHE_TTL_HOURS ||
    '72',
  10,
);
const ATTACHMENT_CACHE_MAX_BYTES = parseInt(
  process.env.NANOCLAW_ATTACHMENT_CACHE_MAX_BYTES ||
    env.NANOCLAW_ATTACHMENT_CACHE_MAX_BYTES ||
    '268435456',
  10,
);
const ATTACHMENT_MAX_FILE_BYTES = parseInt(
  process.env.NANOCLAW_ATTACHMENT_MAX_FILE_BYTES ||
    env.NANOCLAW_ATTACHMENT_MAX_FILE_BYTES ||
    '10485760',
  10,
);

export interface CachedAttachment {
  kind: 'image';
  segment_type: string;
  original_url?: string;
  source_field?: string;
  file_name: string;
  local_path: string;
  relative_path: string;
  mime_type?: string;
  size_bytes: number;
  cached_at: string;
}

interface CacheResult {
  metadata?: Record<string, unknown>;
  synthesizedContent?: string;
}

interface AttachmentCandidate {
  kind: 'image';
  segmentType: string;
  url: string;
  sourceField: string;
}

interface DetectedImageType {
  mimeType: string;
  extension: string;
}

export async function cacheAttachmentsForMessage(input: {
  groupDir: string;
  metadata?: Record<string, unknown>;
  messageId: string;
  content: string;
}): Promise<CacheResult> {
  const metadata = cloneRecord(input.metadata);
  if (!metadata) return {};

  const candidates = extractAttachmentCandidates(metadata);
  if (candidates.length === 0) return { metadata };

  const cacheDir = path.join(input.groupDir, '.attachments');
  fs.mkdirSync(cacheDir, { recursive: true });

  const attachments: CachedAttachment[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const cached = await downloadCandidate(
      candidate,
      cacheDir,
      input.messageId,
      index,
    );
    if (cached) attachments.push(cached);
  }

  pruneAttachmentCache(cacheDir);

  if (attachments.length === 0) {
    return { metadata };
  }

  metadata.attachments = attachments;

  const synthesizedContent =
    input.content.trim().length > 0
      ? undefined
      : `[User sent ${attachments.length} image attachment${attachments.length === 1 ? '' : 's'}]`;

  return { metadata, synthesizedContent };
}

function cloneRecord(
  value?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

function extractAttachmentCandidates(
  metadata: Record<string, unknown>,
): AttachmentCandidate[] {
  const results: AttachmentCandidate[] = [];
  const seen = new Set<string>();

  visitCandidateSource(metadata.segments, results, seen);
  visitCandidateSource(metadata.reply, results, seen);

  return results;
}

function visitCandidateSource(
  value: unknown,
  results: AttachmentCandidate[],
  seen: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitCandidateSource(item, results, seen);
    }
    return;
  }
  if (!isRecord(value)) return;

  maybeCollectImageCandidate(value, results, seen);

  for (const key of [
    'segments',
    'segment',
    'reply',
    'raw',
    'message',
    'messages',
    'message_chain',
    'raw_message',
  ]) {
    if (key in value) {
      visitCandidateSource(value[key], results, seen);
    }
  }
}

function maybeCollectImageCandidate(
  segment: Record<string, unknown>,
  results: AttachmentCandidate[],
  seen: Set<string>,
): void {
  const segmentType = stringOr(segment.type, 'unknown').toLowerCase();
  if (!isImageLikeSegment(segmentType, segment)) return;

  for (const field of ['url', 'image', 'file', 'path', 'data']) {
    const rawValue = segment[field];
    const url = extractUrl(rawValue);
    if (!url) continue;
    const dedupeKey = `${segmentType}:${field}:${url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push({
      kind: 'image',
      segmentType,
      url,
      sourceField: field,
    });
  }
}

function isImageLikeSegment(
  segmentType: string,
  segment: Record<string, unknown>,
): boolean {
  if (segmentType.includes('image') || segmentType === 'pic') return true;

  const fieldHints = [segment.image, segment.url, segment.file, segment.path];
  return fieldHints.some((value) => {
    const text = extractUrl(value) || stringOr(value);
    return !!text && /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(text);
  });
}

function extractUrl(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return undefined;
  }
  if (isRecord(value)) {
    for (const key of ['url', 'src', 'href', 'download_url']) {
      const nested = value[key];
      if (typeof nested === 'string' && /^https?:\/\//i.test(nested.trim())) {
        return nested.trim();
      }
    }
  }
  return undefined;
}

async function downloadCandidate(
  candidate: AttachmentCandidate,
  cacheDir: string,
  messageId: string,
  index: number,
): Promise<CachedAttachment | null> {
  const url = candidate.url;
  const hashed = crypto
    .createHash('sha1')
    .update(url)
    .digest('hex')
    .slice(0, 12);
  const existing = findExistingCachedFile(cacheDir, messageId, index, hashed);
  if (existing) {
    const stat = fs.statSync(existing.fullPath);
    const detected = detectImageType(
      fs.readFileSync(existing.fullPath),
      existing.fileName,
    );
    return {
      kind: 'image',
      segment_type: candidate.segmentType,
      original_url: url,
      source_field: candidate.sourceField,
      file_name: existing.fileName,
      local_path: toWorkspacePath(existing.fullPath),
      relative_path: path.posix.join('.attachments', existing.fileName),
      mime_type: detected?.mimeType,
      size_bytes: stat.size,
      cached_at: stat.mtime.toISOString(),
    };
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(
        { url, status: response.status },
        'Attachment download failed',
      );
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > ATTACHMENT_MAX_FILE_BYTES) {
      logger.warn(
        { url, sizeBytes: buffer.length, maxBytes: ATTACHMENT_MAX_FILE_BYTES },
        'Attachment exceeds max size, skipping cache',
      );
      return null;
    }

    const detected = detectImageType(
      buffer,
      undefined,
      response.headers.get('content-type') || undefined,
      url,
    );
    const ext = detected?.extension || getPreferredExtension(url);
    const fileName = `${sanitizeFilePart(messageId)}-${index + 1}-${hashed}${ext}`;
    const fullPath = path.join(cacheDir, fileName);
    fs.writeFileSync(fullPath, buffer);
    return {
      kind: 'image',
      segment_type: candidate.segmentType,
      original_url: url,
      source_field: candidate.sourceField,
      file_name: fileName,
      local_path: toWorkspacePath(fullPath),
      relative_path: path.posix.join('.attachments', fileName),
      mime_type: detected?.mimeType,
      size_bytes: buffer.length,
      cached_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err, url }, 'Attachment download error');
    return null;
  }
}

function pruneAttachmentCache(cacheDir: string): void {
  if (!fs.existsSync(cacheDir)) return;

  const now = Date.now();
  const ttlMs = ATTACHMENT_CACHE_TTL_HOURS * 60 * 60 * 1000;
  const entries = fs
    .readdirSync(cacheDir)
    .map((name) => {
      const fullPath = path.join(cacheDir, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, stat };
    })
    .filter((entry) => entry.stat.isFile())
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

  for (const entry of entries) {
    if (now - entry.stat.mtimeMs <= ttlMs) continue;
    fs.rmSync(entry.fullPath, { force: true });
  }

  const survivors = fs
    .readdirSync(cacheDir)
    .map((name) => {
      const fullPath = path.join(cacheDir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, stat };
    })
    .filter((entry) => entry.stat.isFile())
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

  let totalBytes = survivors.reduce((sum, entry) => sum + entry.stat.size, 0);
  for (const entry of survivors) {
    if (totalBytes <= ATTACHMENT_CACHE_MAX_BYTES) break;
    fs.rmSync(entry.fullPath, { force: true });
    totalBytes -= entry.stat.size;
  }
}

function toWorkspacePath(fullPath: string): string {
  const normalized = fullPath.split(path.sep).join('/');
  const marker = '/groups/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return normalized;
  const relative = normalized.slice(markerIndex + marker.length);
  const slashIndex = relative.indexOf('/');
  if (slashIndex === -1) return normalized;
  return `/workspace/group/${relative.slice(slashIndex + 1)}`;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'attachment';
}

function getPreferredExtension(url: string): string {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname);
    if (ext && ext.length <= 8) return ext.toLowerCase();
  } catch {
    // ignore parse failures and fall back
  }
  return '.img';
}

function findExistingCachedFile(
  cacheDir: string,
  messageId: string,
  index: number,
  hashed: string,
): { fileName: string; fullPath: string } | null {
  const prefix = `${sanitizeFilePart(messageId)}-${index + 1}-${hashed}`;
  for (const fileName of fs.readdirSync(cacheDir)) {
    if (!fileName.startsWith(prefix)) continue;
    const fullPath = path.join(cacheDir, fileName);
    if (fs.statSync(fullPath).isFile()) {
      return { fileName, fullPath };
    }
  }
  return null;
}

function detectImageType(
  buffer: Buffer,
  fileName?: string,
  contentType?: string,
  sourceUrl?: string,
): DetectedImageType | null {
  const normalizedHeader = normalizeImageContentType(contentType);
  if (normalizedHeader) return normalizedHeader;

  if (buffer.length >= 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { mimeType: 'image/jpeg', extension: '.jpg' };
    }
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (
    buffer.length >= 6 &&
    buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
  ) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (
    buffer.length >= 6 &&
    buffer.subarray(0, 6).toString('ascii') === 'GIF89a'
  ) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') {
    return { mimeType: 'image/bmp', extension: '.bmp' };
  }

  const byName = normalizeImageContentType(
    guessMimeTypeFromName(fileName || sourceUrl || ''),
  );
  if (byName) return byName;

  return null;
}

function guessMimeTypeFromName(value: string): string | undefined {
  const ext = path.extname(value).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return undefined;
  }
}

function normalizeImageContentType(
  value?: string,
): DetectedImageType | null {
  if (!value) return null;
  const normalized = value.split(';')[0].trim().toLowerCase();
  switch (normalized) {
    case 'image/jpeg':
      return { mimeType: 'image/jpeg', extension: '.jpg' };
    case 'image/png':
      return { mimeType: 'image/png', extension: '.png' };
    case 'image/gif':
      return { mimeType: 'image/gif', extension: '.gif' };
    case 'image/webp':
      return { mimeType: 'image/webp', extension: '.webp' };
    case 'image/bmp':
      return { mimeType: 'image/bmp', extension: '.bmp' };
    case 'image/svg+xml':
      return { mimeType: 'image/svg+xml', extension: '.svg' };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
