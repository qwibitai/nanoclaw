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
  const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
  const results: AttachmentCandidate[] = [];
  const seen = new Set<string>();

  for (const rawSegment of segments) {
    if (!isRecord(rawSegment)) continue;
    const segmentType = stringOr(rawSegment.type, 'unknown').toLowerCase();
    if (!isImageLikeSegment(segmentType, rawSegment)) continue;

    for (const field of ['url', 'image', 'file', 'path', 'data']) {
      const rawValue = rawSegment[field];
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

  return results;
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
  const ext = getPreferredExtension(url);
  const fileName = `${sanitizeFilePart(messageId)}-${index + 1}-${hashed}${ext}`;
  const fullPath = path.join(cacheDir, fileName);

  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    return {
      kind: 'image',
      segment_type: candidate.segmentType,
      original_url: url,
      source_field: candidate.sourceField,
      file_name: fileName,
      local_path: toWorkspacePath(fullPath),
      relative_path: path.posix.join('.attachments', fileName),
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

    const contentType = response.headers.get('content-type') || undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > ATTACHMENT_MAX_FILE_BYTES) {
      logger.warn(
        { url, sizeBytes: buffer.length, maxBytes: ATTACHMENT_MAX_FILE_BYTES },
        'Attachment exceeds max size, skipping cache',
      );
      return null;
    }

    fs.writeFileSync(fullPath, buffer);
    return {
      kind: 'image',
      segment_type: candidate.segmentType,
      original_url: url,
      source_field: candidate.sourceField,
      file_name: fileName,
      local_path: toWorkspacePath(fullPath),
      relative_path: path.posix.join('.attachments', fileName),
      mime_type: contentType,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
