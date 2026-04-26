import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import Busboy from 'busboy';

import { getAllRegisteredGroups } from '../db.js';
import { storeFileMessage } from '../chat-db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from '../group-folder.js';
import { broadcast, getOnNewMessage } from './state.js';

const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024; // 1GB
const CHUNK_UPLOAD_TIMEOUT = 5 * 60 * 1000; // 5 minutes to complete a chunked upload

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const pendingChunkedUploads = new Map<
  string,
  {
    groupFolder: string;
    roomId: string;
    filename: string;
    mime: string;
    totalChunks: number;
    receivedChunks: Set<number>;
    tempDir: string;
    sender: string;
    timer: ReturnType<typeof setTimeout>;
    cumulativeSize: number;
  }
>();

function cleanupChunkedUpload(uploadId: string): void {
  const upload = pendingChunkedUploads.get(uploadId);
  if (!upload) return;
  clearTimeout(upload.timer);
  try {
    fs.rmSync(upload.tempDir, { recursive: true, force: true });
  } catch {}
  pendingChunkedUploads.delete(uploadId);
}

function resolveGroupFolder(roomId: string): string | null {
  const jid = `chat:${roomId}`;
  const groups = getAllRegisteredGroups();
  const group = groups[jid];
  return group ? group.folder : null;
}

function getUploadsDir(groupFolder: string): string {
  return path.join(resolveGroupFolderPath(groupFolder), 'uploads');
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => resolve(body));
    req.on('error', (err) => reject(err));
  });
}

export function handleMultipartUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roomId: string,
  senderIdentity: string,
): void {
  const groupFolder = resolveGroupFolder(roomId);
  if (!groupFolder) {
    return json(res, 404, { error: 'Room not registered as a group' });
  }

  const uploadsDir = getUploadsDir(groupFolder);
  fs.mkdirSync(uploadsDir, { recursive: true });

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return json(res, 400, {
      error: 'Content-Type must be multipart/form-data',
    });
  }

  const busboy = Busboy({
    headers: req.headers,
    limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 },
  });
  let fileInfo: {
    id: string;
    filename: string;
    mime: string;
    size: number;
    path: string;
  } | null = null;
  let limitHit = false;
  let caption = '';

  busboy.on('field', (name, value) => {
    if (name === 'caption') caption = value.trim();
  });

  busboy.on('file', (_fieldname, stream, info) => {
    const id = randomUUID();
    const ext = path.extname(info.filename) || '';
    const safeFilename = `${id}${ext}`;
    const filePath = path.join(uploadsDir, safeFilename);
    let size = 0;

    const ws = fs.createWriteStream(filePath);
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    stream.pipe(ws);

    stream.on('limit', () => {
      limitHit = true;
      ws.destroy();
      try {
        fs.unlinkSync(filePath);
      } catch {}
    });

    stream.on('end', () => {
      if (!limitHit) {
        fileInfo = {
          id,
          filename: info.filename,
          mime: info.mimeType || 'application/octet-stream',
          size,
          path: `/api/files/${encodeURIComponent(groupFolder)}/${safeFilename}`,
        };
      }
    });
  });

  busboy.on('finish', () => {
    if (limitHit) {
      return json(res, 413, {
        error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
      });
    }
    if (!fileInfo) return json(res, 400, { error: 'No file uploaded' });

    const fileMeta = {
      url: fileInfo.path,
      filename: fileInfo.filename,
      mime: fileInfo.mime,
      size: fileInfo.size,
    };
    const stored = storeFileMessage(
      roomId,
      senderIdentity,
      'user',
      fileMeta,
      caption,
    );
    broadcast(roomId, { type: 'message', ...stored });
    getOnNewMessage()?.(roomId, stored);

    json(res, 200, { ...fileInfo, caption });
  });

  busboy.on('error', () => json(res, 500, { error: 'Upload failed' }));
  req.pipe(busboy);
}

export async function handleChunkedUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roomId: string,
  senderIdentity: string,
): Promise<void> {
  const body = await readBody(req);
  let parsed: {
    uploadId: string;
    chunkIndex: number;
    totalChunks: number;
    filename: string;
    mime: string;
    data: string;
    caption?: string;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const { uploadId, chunkIndex, totalChunks, filename, mime, data } = parsed;
  if (!uploadId || chunkIndex == null || !totalChunks || !filename || !data) {
    return json(res, 400, { error: 'Missing required fields' });
  }

  // Validate uploadId as UUID to prevent path traversal
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      uploadId,
    )
  ) {
    return json(res, 400, { error: 'Invalid uploadId format' });
  }

  const groupFolder = resolveGroupFolder(roomId);
  if (!groupFolder) {
    return json(res, 404, { error: 'Room not registered as a group' });
  }

  let upload = pendingChunkedUploads.get(uploadId);
  if (!upload) {
    const tempDir = path.join(os.tmpdir(), `nanoclaw-chunk-${uploadId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    upload = {
      groupFolder,
      roomId,
      filename,
      mime: mime || 'application/octet-stream',
      totalChunks,
      receivedChunks: new Set(),
      tempDir,
      sender: senderIdentity,
      timer: setTimeout(
        () => cleanupChunkedUpload(uploadId),
        CHUNK_UPLOAD_TIMEOUT,
      ),
      cumulativeSize: 0,
    };
    pendingChunkedUploads.set(uploadId, upload);
  } else if (totalChunks !== upload.totalChunks) {
    return json(res, 400, { error: 'totalChunks mismatch' });
  }

  const chunkBuf = Buffer.from(data, 'base64');
  upload.cumulativeSize += chunkBuf.length;
  if (upload.cumulativeSize > MAX_UPLOAD_SIZE) {
    cleanupChunkedUpload(uploadId);
    return json(res, 413, {
      error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
    });
  }
  fs.writeFileSync(path.join(upload.tempDir, String(chunkIndex)), chunkBuf);
  upload.receivedChunks.add(chunkIndex);

  if (upload.receivedChunks.size < upload.totalChunks) {
    return json(res, 200, {
      ok: true,
      received: upload.receivedChunks.size,
      total: upload.totalChunks,
    });
  }

  // All chunks received — reassemble
  clearTimeout(upload.timer);

  // Re-check total size BEFORE writing to prevent disk DoS
  let totalSize = 0;
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(upload.tempDir, String(i));
    try {
      totalSize += fs.statSync(chunkPath).size;
    } catch {
      // Missing chunk
    }
  }

  if (totalSize > MAX_UPLOAD_SIZE) {
    fs.rmSync(upload.tempDir, { recursive: true, force: true });
    pendingChunkedUploads.delete(uploadId);
    return json(res, 413, {
      error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
    });
  }

  const uploadsDir = getUploadsDir(groupFolder);
  fs.mkdirSync(uploadsDir, { recursive: true });
  const id = randomUUID();
  const ext = path.extname(filename) || '';
  const safeFilename = `${id}${ext}`;
  const finalPath = path.join(uploadsDir, safeFilename);

  const writeStream = fs.createWriteStream(finalPath);
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(upload.tempDir, String(i));
    writeStream.write(fs.readFileSync(chunkPath));
  }
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    writeStream.end();
  });

  fs.rmSync(upload.tempDir, { recursive: true, force: true });
  pendingChunkedUploads.delete(uploadId);

  const fileMeta = {
    url: `/api/files/${encodeURIComponent(groupFolder)}/${safeFilename}`,
    filename,
    mime: upload.mime,
    size: totalSize,
  };
  const caption = parsed.caption || '';
  const stored = storeFileMessage(
    roomId,
    upload.sender,
    'user',
    fileMeta,
    caption,
  );
  broadcast(roomId, { type: 'message', ...stored });
  getOnNewMessage()?.(roomId, stored);

  return json(res, 200, { ...fileMeta, caption });
}

export function handleFileServe(
  res: http.ServerResponse,
  groupFolder: string,
  filename: string,
): void {
  // Path-traversal guard
  if (
    !isValidGroupFolder(groupFolder) ||
    filename.includes('..') ||
    filename.includes('/')
  ) {
    res.writeHead(403);
    res.end();
    return;
  }
  const filePath = path.join(getUploadsDir(groupFolder), filename);
  const ext = path.extname(filename);
  const mime = MIME[ext] || 'application/octet-stream';
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return json(res, 404, { error: 'File not found' });
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${filename}"`,
    'Cache-Control': 'public, max-age=31536000, immutable',
    // Sandbox the response into an opaque origin so HTML/SVG uploads
    // cannot read the PWA's localStorage token. nosniff stops the
    // browser from reinterpreting the Content-Type.
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}
