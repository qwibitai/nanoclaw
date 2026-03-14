import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, MAX_MEDIA_SIZE, MEDIA_DIR } from './config.js';
import { MediaAttachment } from './types.js';

export interface MediaRef {
  id: string; // URI: "{channel}:media:{uid}"
  channel: string; // 'whatsapp' | 'telegram' | 'slack'
  filename: string;
  mimetype: string;
  size?: number;
  sender: string;
  timestamp: string;
  ref: unknown; // Channel-specific download reference (opaque to host)
}

// --- MIME helpers ---

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/octet-stream': 'bin',
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

export function getExtFromMime(mimetype: string): string {
  return MIME_TO_EXT[mimetype] || 'bin';
}

export function guessMimetype(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

// --- ID helpers ---

export function generateMediaId(channel: string): string {
  const uid = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  return `${channel}:media:${uid}`;
}

export function mediaIdToFilename(mediaId: string): string {
  // "whatsapp:media:abc123" → "abc123"
  const parts = mediaId.split(':');
  if (parts.length < 3) throw new Error(`Invalid media ID: ${mediaId}`);
  return parts.slice(2).join(':');
}

// --- Path helpers with traversal guard ---

function resolveMediaDir(groupFolder: string): string {
  const dir = path.resolve(MEDIA_DIR, groupFolder);
  const rel = path.relative(MEDIA_DIR, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes media directory: ${dir}`);
  }
  return dir;
}

// --- Ref storage (fast, no download) ---
// Refs live in data/media-refs/{group}/ — completely outside the mounted
// data/media/{group}/ directory. This prevents the container from reading
// channel-specific download secrets (WhatsApp proto keys, Slack auth URLs).

function resolveRefsDir(groupFolder: string): string {
  const baseDir = path.resolve(DATA_DIR, 'media-refs');
  const dir = path.resolve(baseDir, groupFolder);
  const rel = path.relative(baseDir, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes media-refs directory: ${dir}`);
  }
  return dir;
}

export function saveMediaRef(groupFolder: string, ref: MediaRef): void {
  const refsDir = resolveRefsDir(groupFolder);
  fs.mkdirSync(refsDir, { recursive: true });
  const uid = mediaIdToFilename(ref.id);
  const refPath = path.join(refsDir, `${uid}.json`);
  fs.writeFileSync(refPath, JSON.stringify(ref, null, 2));
}

export function getMediaRef(
  groupFolder: string,
  mediaId: string,
): MediaRef | null {
  const refsDir = resolveRefsDir(groupFolder);
  const uid = mediaIdToFilename(mediaId);
  const refPath = path.join(refsDir, `${uid}.json`);
  if (!fs.existsSync(refPath)) return null;
  return JSON.parse(fs.readFileSync(refPath, 'utf-8'));
}

// --- File operations (post-download) ---

export function saveMediaFile(
  groupFolder: string,
  mediaId: string,
  buffer: Buffer,
  ext: string,
): string {
  const dir = resolveMediaDir(groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  const uid = mediaIdToFilename(mediaId);
  const filePath = path.join(dir, `${uid}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function getMediaFilePath(
  groupFolder: string,
  mediaId: string,
): string | null {
  const dir = resolveMediaDir(groupFolder);
  const uid = mediaIdToFilename(mediaId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const match = files.find((f) => f.startsWith(`${uid}.`));
  return match ? path.join(dir, match) : null;
}

export function isMediaDownloaded(
  groupFolder: string,
  mediaId: string,
): boolean {
  return getMediaFilePath(groupFolder, mediaId) !== null;
}

// --- Download error sentinel ---
// Written by the host when a download fails so the container can detect
// failure immediately instead of polling until timeout.

export function writeDownloadError(
  groupFolder: string,
  mediaId: string,
  error: string,
): void {
  const dir = resolveMediaDir(groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  const uid = mediaIdToFilename(mediaId);
  const errorPath = path.join(dir, `${uid}.error`);
  fs.writeFileSync(errorPath, error);
}

export function getDownloadError(
  groupFolder: string,
  mediaId: string,
): string | null {
  const dir = resolveMediaDir(groupFolder);
  const uid = mediaIdToFilename(mediaId);
  const errorPath = path.join(dir, `${uid}.error`);
  if (!fs.existsSync(errorPath)) return null;
  return fs.readFileSync(errorPath, 'utf-8');
}

// --- Container path resolution ---

export function resolveContainerMediaPath(
  containerPath: string,
  groupFolder: string,
): string | null {
  // /workspace/media/ → data/media/{groupFolder}/
  const mediaPrefix = '/workspace/media/';
  if (containerPath.startsWith(mediaPrefix)) {
    const rel = containerPath.slice(mediaPrefix.length);
    const dir = resolveMediaDir(groupFolder);
    const resolved = path.resolve(dir, rel);
    if (!resolved.startsWith(dir + path.sep) && resolved !== dir) return null;
    return resolved;
  }

  // /workspace/group/ → groups/{groupFolder}/
  const groupPrefix = '/workspace/group/';
  if (containerPath.startsWith(groupPrefix)) {
    const rel = containerPath.slice(groupPrefix.length);
    const groupDir = path.resolve(GROUPS_DIR, groupFolder);
    const resolved = path.resolve(groupDir, rel);
    if (!resolved.startsWith(groupDir + path.sep) && resolved !== groupDir)
      return null;
    return resolved;
  }

  return null;
}

// --- Channel helper: the ONE function channels call for inbound media ---

export function processInboundMedia(
  groupFolder: string,
  opts: {
    channel: string;
    mimetype: string;
    filename?: string;
    size?: number;
    sender: string;
    timestamp: string;
    ref: unknown; // Channel-specific download info
    caption?: string; // Text caption if any
    mediaType?: string; // 'image' | 'video' | 'audio' | 'document' | 'sticker'
  },
): { content: string; attachments: MediaAttachment[] } | null {
  if (opts.size != null && opts.size > MAX_MEDIA_SIZE) {
    return null;
  }

  const mediaId = generateMediaId(opts.channel);
  const filename =
    opts.filename ||
    `${opts.mediaType || 'file'}-${Date.now()}.${getExtFromMime(opts.mimetype)}`;

  saveMediaRef(groupFolder, {
    id: mediaId,
    channel: opts.channel,
    filename,
    mimetype: opts.mimetype,
    size: opts.size,
    sender: opts.sender,
    timestamp: opts.timestamp,
    ref: opts.ref,
  });

  const label = opts.mediaType
    ? `[${opts.mediaType.charAt(0).toUpperCase() + opts.mediaType.slice(1)}]`
    : '[File]';
  const content = opts.caption || label;

  return {
    content,
    attachments: [
      { id: mediaId, filename, mimetype: opts.mimetype, size: opts.size },
    ],
  };
}
