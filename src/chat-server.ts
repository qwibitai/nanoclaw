/**
 * chat-server.ts — in-process HTTP + WebSocket chat server for NanoClaw.
 *
 * Controlled by env vars:
 *   CHAT_SERVER_ENABLED=true       (default: false)
 *   CHAT_SERVER_PORT=3100          (default: 3100)
 *   CHAT_SERVER_HOST=127.0.0.1    (default: 127.0.0.1 — localhost only)
 *   TLS_CERT=path/to/cert.crt     (optional — enables HTTPS)
 *   TLS_KEY=path/to/cert.key      (optional — required with TLS_CERT)
 *
 * Endpoints:
 *   GET  /              → serves PWA (chat-pwa/index.html)
 *   GET  /api/rooms     → list rooms
 *   POST /api/rooms     → create room
 *   GET  /api/rooms/:id/messages → history
 *   GET  /api/agents    → list agent tokens
 *   POST /api/agents    → create agent token
 *   GET  /health        → { ok: true }
 *   WS   /ws            → WebSocket chat
 */
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import Busboy from 'busboy';
import { randomUUID } from 'crypto';
import webPush from 'web-push';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { redactSensitiveData } from './redact.js';
import {
  getAllRegisteredGroups,
  getAllTasks,
  getMessageRoutes,
  logMessageRoute,
  setRegisteredGroup,
  updateRegisteredGroup,
  deleteRegisteredGroup,
  getRegisteredGroup,
} from './db.js';
import { authenticateRequest, warnIfAutoProxyTrust } from './chat-server/auth.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  initChatDatabase,
  getChatRooms,
  getChatRoom,
  createChatRoom,
  deleteChatRoom,
  getChatMessages,
  getChatMessagesAfterId,
  deleteChatMessage,
  storeChatMessage,
  storeFileMessage,
  getChatAgentToken,
  createChatAgentToken,
  listChatAgentTokens,
  upsertPushSubscription,
  deletePushSubscription,
  deletePushSubscriptionForIdentity,
  getPushSubscriptionOwner,
  getPushSubscriptionsExcludingIdentity,
} from './chat-db.js';

// ── In-memory client registry ──────────────────────────────────────────────
interface WSClient {
  id: string;
  ws: WebSocket;
  identity: string;
  identity_type: 'user' | 'agent';
  room_id?: string;
  isAlive: boolean;
}

const clients = new Map<string, WSClient>();

function addClient(c: WSClient): void {
  clients.set(c.id, c);
}
function removeClient(id: string): WSClient | undefined {
  const c = clients.get(id);
  clients.delete(id);
  return c;
}
export function broadcast(
  roomId: string,
  msg: object,
  excludeId?: string,
): void {
  const isMessage = (msg as { type?: string }).type === 'message';
  // Redact sensitive data before sending to chat clients
  const outgoing = isMessage
    ? {
        ...msg,
        content: redactSensitiveData(
          (msg as { content?: string }).content || '',
        ),
      }
    : msg;
  const payload = JSON.stringify(outgoing);
  const notifyPayload = isMessage
    ? JSON.stringify({ type: 'unread', room_id: roomId })
    : '';
  for (const c of clients.values()) {
    if (c.id === excludeId || c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      if (c.room_id === roomId) c.ws.send(payload);
      else if (isMessage) c.ws.send(notifyPayload);
    } catch {
      // Socket may have closed between readyState check and send
    }
  }
  // Also fan out to Web Push subscriptions (offline devices). Fire-and-forget.
  if (isMessage) {
    const m = msg as {
      sender?: string;
      content?: string;
      id?: string;
    };
    const room = getChatRoom(roomId);
    // Redact before sending to external push services — the payload lands on
    // OS lock screens and in vendor logs.
    sendPushForMessage({
      roomId,
      roomName: room?.name || roomId,
      sender: m.sender || 'unknown',
      content: redactSensitiveData(m.content || ''),
      messageId: m.id,
    }).catch((err) =>
      logger.warn({ err: err.message }, 'sendPushForMessage failed'),
    );
  }
}
interface MemberInfo {
  identity: string;
  identity_type: 'user' | 'agent';
}

function getMemberList(roomId: string): MemberInfo[] {
  const seen = new Set<string>();
  const members: MemberInfo[] = [];
  for (const c of clients.values()) {
    if (c.room_id === roomId && !seen.has(c.identity)) {
      seen.add(c.identity);
      members.push({ identity: c.identity, identity_type: c.identity_type });
    }
  }
  // Include the agent if it's actively processing for this room
  if (activeAgents.has(roomId)) {
    const agentIdentity = activeAgents.get(roomId)!;
    if (!seen.has(agentIdentity)) {
      members.push({ identity: agentIdentity, identity_type: 'agent' });
    }
  }
  return members;
}

// Track which rooms have an active agent (set via typing events from channel adapter)
const activeAgents = new Map<string, string>(); // roomId -> agent identity

export function setAgentPresence(
  roomId: string,
  identity: string,
  active: boolean,
): void {
  const wasBefore = activeAgents.has(roomId);
  if (active) {
    activeAgents.set(roomId, identity);
  } else {
    activeAgents.delete(roomId);
  }
  const isNow = activeAgents.has(roomId);
  // Broadcast updated member list if agent presence changed
  if (wasBefore !== isNow) {
    broadcast(roomId, {
      type: 'members',
      room_id: roomId,
      members: getMemberList(roomId),
    });
  }
}

// ── Message hook for channel adapter ──────────────────────────────────────
type ChatMessageCallback = (
  roomId: string,
  message: import('./chat-db.js').ChatMessage,
) => void;
let onNewMessageCallback: ChatMessageCallback | null = null;
let onGroupUpdatedCallback: (() => void) | null = null;

export function setOnNewMessage(cb: ChatMessageCallback): void {
  onNewMessageCallback = cb;
}

export function clearOnNewMessage(): void {
  onNewMessageCallback = null;
}

export function broadcastRooms(): void {
  const payload = JSON.stringify({ type: 'rooms', rooms: getChatRooms() });
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
  }
}

export function setOnGroupUpdated(cb: () => void): void {
  onGroupUpdatedCallback = cb;
}

export function clearOnGroupUpdated(): void {
  onGroupUpdatedCallback = null;
}

export function isChatServerRunning(): boolean {
  return server !== null;
}

// ── Web Push ───────────────────────────────────────────────────────────────
let webPushReady = false;

// Only accept subscriptions on known push services. Blocks authenticated
// callers from pointing the server at private-IP or internal HTTPS endpoints
// (effective SSRF via sendNotification).
const PUSH_HOSTS_ALLOW = [
  /\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

function isValidPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return PUSH_HOSTS_ALLOW.some((re) => re.test(u.hostname));
}

function initWebPush(): void {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const sub = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!pub || !priv) {
    logger.warn('VAPID keys missing — Web Push disabled');
    return;
  }
  webPush.setVapidDetails(sub, pub, priv);
  webPushReady = true;
  logger.info('Web Push initialized');
}

interface BroadcastPushMsg {
  roomId: string;
  roomName: string;
  sender: string;
  content: string;
  messageId?: string;
}

export async function sendPushForMessage(m: BroadcastPushMsg): Promise<void> {
  if (!webPushReady) {
    logger.info({ sender: m.sender }, 'Push: skipped (not ready)');
    return;
  }
  const subs = getPushSubscriptionsExcludingIdentity(m.sender);
  logger.info(
    { sender: m.sender, roomId: m.roomId, subCount: subs.length },
    'Push: dispatching',
  );
  if (subs.length === 0) return;

  const payload = JSON.stringify({
    title: `${m.sender} · ${m.roomName}`,
    body: (m.content || '').slice(0, 160),
    roomId: m.roomId,
    messageId: m.messageId,
    tag: `room-${m.roomId}`,
  });

  await Promise.all(
    subs.map(async (row) => {
      try {
        const keys = JSON.parse(row.keys_json) as {
          p256dh: string;
          auth: string;
        };
        const res = await webPush.sendNotification(
          { endpoint: row.endpoint, keys },
          payload,
          { TTL: 60 },
        );
        logger.info(
          {
            endpointTail: row.endpoint.slice(-24),
            status: res.statusCode,
          },
          'Push: delivered',
        );
      } catch (err: any) {
        // 404/410 means the subscription was revoked on the device — prune it.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          deletePushSubscription(row.endpoint);
          logger.info(
            { endpoint: row.endpoint },
            'Pruned dead push subscription',
          );
        } else {
          logger.warn(
            {
              err: err.message,
              statusCode: err.statusCode,
              body: err.body,
              endpointTail: row.endpoint.slice(-24),
            },
            'Web Push send failed',
          );
        }
      }
    }),
  );
}

// ── File upload helpers ────────────────────────────────────────────────────
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024; // 1GB
const CHUNK_SIZE = 512 * 1024; // 512KB chunks (stays well under Azure's 2MB limit)
const CHUNK_UPLOAD_TIMEOUT = 5 * 60 * 1000; // 5 minutes to complete a chunked upload

// Track in-progress chunked uploads
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

// ── Static PWA serving ─────────────────────────────────────────────────────
const PWA_DIR = path.resolve(
  new URL(import.meta.url).pathname,
  '../../chat-pwa',
);

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
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function servePwa(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  let urlPath = req.url?.split('?')[0] ?? '/';
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PWA_DIR, urlPath);
  // Prevent path traversal
  if (!filePath.startsWith(PWA_DIR)) {
    res.writeHead(403);
    res.end();
    return true;
  }
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
  const basename = path.basename(filePath);
  const contentType =
    basename === 'manifest.json'
      ? 'application/manifest+json'
      : MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
  });
  res.end(fs.readFileSync(filePath));
  return true;
}

// ── HTTP request handler ───────────────────────────────────────────────────
async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  const url = new URL(req.url ?? '/', `http://localhost`);
  const method = req.method ?? 'GET';

  // OPTIONS and health bypass auth
  let senderIdentity = 'unknown';
  if (method === 'OPTIONS' || url.pathname === '/health') {
    // fall through to handlers below
  } else {
    const auth = await authenticateRequest(req);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: auth.reason || 'Unauthorized' }));
      return;
    }
    senderIdentity = auth.identity || 'unknown';
  }

  function json(status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  function readBody(): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => resolve(body));
      req.on('error', (err) => reject(err));
    });
  }

  // Health
  if (url.pathname === '/health' && method === 'GET') {
    return json(200, { ok: true, uptime: process.uptime() });
  }

  // Auth check — used by PWA to verify token (reuses auth from above)
  if (url.pathname === '/api/auth/check' && method === 'GET') {
    return json(200, { ok: true, identity: senderIdentity });
  }

  // Stats — dashboard metrics
  if (url.pathname === '/api/stats' && method === 'GET') {
    const groups = getAllRegisteredGroups();
    const entries = Object.entries(groups);

    // Channel breakdown
    const channels: Record<string, number> = {};
    for (const [jid, g] of entries) {
      const ch = jid.startsWith('tg:')
        ? 'telegram'
        : jid.startsWith('dc:')
          ? 'discord'
          : jid.startsWith('chat:')
            ? 'local-chat'
            : jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')
              ? 'whatsapp'
              : g.folder.split('_')[0] || 'unknown';
      channels[ch] = (channels[ch] || 0) + 1;
    }

    // Scheduled tasks
    let tasks: { active: number; paused: number; total: number } = {
      active: 0,
      paused: 0,
      total: 0,
    };
    try {
      const allTasks = getAllTasks();
      tasks.total = allTasks.length;
      tasks.active = allTasks.filter((t) => t.status === 'active').length;
      tasks.paused = allTasks.filter((t) => t.status === 'paused').length;
    } catch {
      // table may not exist
    }

    // IPC queue depth per group (async)
    const ipcQueues: Record<string, number> = {};
    const fsPromises = await import('fs/promises');
    await Promise.all(
      entries.map(async ([, g]) => {
        const msgDir = path.join(DATA_DIR, 'ipc', g.folder, 'messages');
        try {
          const files = await fsPromises.readdir(msgDir);
          ipcQueues[g.folder] = files.filter((f) => f.endsWith('.json')).length;
        } catch {
          ipcQueues[g.folder] = 0;
        }
      }),
    );

    // Active containers
    let activeContainers = 0;
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(
          'docker',
          ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
          { timeout: 3000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        ),
      );
      activeContainers = out.trim().split('\n').filter(Boolean).length;
    } catch {
      // docker not available or no containers
    }

    // 24h message counts from chat rooms
    let messages24h = 0;
    const messagesByChannel: Record<string, number> = {};
    const roomMessages: Array<{ id: string; name: string; count: number }> = [];
    try {
      const rooms = getChatRooms();
      const since = Date.now() - 86400000;
      for (const room of rooms) {
        const msgs = getChatMessages(room.id, 1000);
        const recent = msgs.filter((m) => m.created_at > since).length;
        messages24h += recent;
        if (recent > 0) {
          roomMessages.push({ id: room.id, name: room.name, count: recent });
          messagesByChannel['local-chat'] =
            (messagesByChannel['local-chat'] || 0) + recent;
        }
      }
    } catch {
      // chat db may not exist
    }
    roomMessages.sort((a, b) => b.count - a.count);
    const busiestRooms = roomMessages.slice(0, 5);

    // Ollama status
    const ollamaHost = process.env.OLLAMA_HOST || '';
    let ollama: { ok: boolean; models?: string[]; host: string } = {
      ok: false,
      host: ollamaHost,
    };
    if (ollamaHost) {
      try {
        const ollamaRes = await fetch(`${ollamaHost}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (ollamaRes.ok) {
          const data = (await ollamaRes.json()) as {
            models?: Array<{ name: string }>;
          };
          ollama = {
            ok: true,
            host: ollamaHost,
            models: (data.models || []).map((m) => m.name),
          };
        }
      } catch {
        // Ollama not reachable
      }
    }

    // Host system metrics
    const os = await import('os');
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const system = {
      memoryUsedPct: Math.round(((totalMem - freeMem) / totalMem) * 100),
      memoryUsedGB: +((totalMem - freeMem) / 1073741824).toFixed(1),
      memoryTotalGB: +(totalMem / 1073741824).toFixed(1),
      loadAvg: os.loadavg().map((v) => +v.toFixed(2)),
      cpus: os.cpus().length,
      platform: os.platform(),
    };

    return json(200, {
      bots: entries.length,
      channels,
      tasks,
      ipcQueues,
      activeContainers,
      messages24h,
      messagesByChannel,
      busiestRooms,
      ollama,
      system,
    });
  }

  // Message routes — cross-group send history (last 30 days)
  if (url.pathname === '/api/routes' && method === 'GET') {
    try {
      const routes = getMessageRoutes(30);
      const groups = getAllRegisteredGroups();
      const result: Record<string, string[]> = {};
      for (const route of routes) {
        const sourceBot = Object.entries(groups).find(
          ([, g]) => g.folder === route.source_folder,
        );
        if (!sourceBot) continue;
        const sourceRoomId = sourceBot[0].startsWith('chat:')
          ? sourceBot[0].replace(/^chat:/, '')
          : null;
        const targetRoomId = route.target_jid.startsWith('chat:')
          ? route.target_jid.replace(/^chat:/, '')
          : null;
        if (sourceRoomId && targetRoomId) {
          if (!result[sourceRoomId]) result[sourceRoomId] = [];
          if (!result[sourceRoomId].includes(targetRoomId)) {
            result[sourceRoomId].push(targetRoomId);
          }
        }
      }
      return json(200, result);
    } catch {
      return json(200, {});
    }
  }

  // Save pipeline routes
  if (url.pathname === '/api/routes' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody());
      if (!body.source || !Array.isArray(body.targets)) {
        return json(400, { error: 'source and targets[] required' });
      }
      if (
        typeof body.source !== 'string' ||
        !/^[a-z0-9_-]+$/i.test(body.source)
      ) {
        return json(400, { error: 'Invalid source format' });
      }
      const groups = getAllRegisteredGroups();
      const sourceJid = `chat:${body.source}`;
      const sourceGroup = groups[sourceJid];
      if (!sourceGroup) {
        return json(404, {
          error: `No bot registered for room ${body.source}`,
        });
      }
      for (const target of body.targets) {
        if (typeof target !== 'string' || !/^[a-z0-9_-]+$/i.test(target))
          continue;
        const targetJid = `chat:${target}`;
        if (!groups[targetJid]) continue;
        logMessageRoute(sourceGroup.folder, targetJid);
      }
      return json(200, { ok: true });
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
  }

  // List scheduled tasks
  if (url.pathname === '/api/tasks' && method === 'GET') {
    try {
      return json(200, getAllTasks());
    } catch {
      return json(200, []);
    }
  }

  // List rooms
  if (url.pathname === '/api/rooms' && method === 'GET') {
    return json(200, getChatRooms());
  }

  // Create room
  if (url.pathname === '/api/rooms' && method === 'POST') {
    try {
      const body = await readBody();
      const { id, name } = JSON.parse(body);
      if (!id || !name) return json(400, { error: 'id and name required' });
      json(200, createChatRoom(id, name));
    } catch {
      json(400, { error: 'Invalid JSON' });
    }
    return;
  }

  // Room history — /api/rooms/:id/messages
  const histMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (histMatch && method === 'GET') {
    const room = getChatRoom(histMatch[1]);
    if (!room) return json(404, { error: 'Room not found' });
    const afterId = url.searchParams.get('after_id');
    const msgs = afterId
      ? getChatMessagesAfterId(room.id, afterId, 200)
      : getChatMessages(room.id, 100);
    return json(
      200,
      msgs.map((m) => ({
        ...m,
        content: redactSensitiveData(m.content),
      })),
    );
  }

  // Agent tokens
  if (url.pathname === '/api/agents' && method === 'GET') {
    return json(200, listChatAgentTokens());
  }
  if (url.pathname === '/api/agents' && method === 'POST') {
    try {
      const body = await readBody();
      const { agent_id, name, allowed_rooms } = JSON.parse(body);
      if (!agent_id || !name)
        return json(400, { error: 'agent_id and name required' });
      json(200, createChatAgentToken(agent_id, name, allowed_rooms));
    } catch {
      json(400, { error: 'Invalid JSON' });
    }
    return;
  }

  // ── Bot CRUD ──────────────────────────────────────────────────────────
  // List all registered bots/groups
  if (url.pathname === '/api/bots' && method === 'GET') {
    const groups = getAllRegisteredGroups();
    const bots = Object.entries(groups).map(([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      trigger: g.trigger,
      channel: g.folder.split('_')[0],
      isMain: g.isMain || false,
      requiresTrigger: g.requiresTrigger !== false,
      added_at: g.added_at,
      tags: [],
    }));
    return json(200, bots);
  }

  // Create a new bot/group
  if (url.pathname === '/api/bots' && method === 'POST') {
    try {
      const body = await readBody();
      const { jid, name, folder, trigger, requiresTrigger } = JSON.parse(body);
      if (!jid || !name || !folder || !trigger)
        return json(400, {
          error: 'jid, name, folder, and trigger required',
        });
      setRegisteredGroup(jid, {
        name,
        folder,
        trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: requiresTrigger !== false,
      });
      // Auto-create chat room for local-chat bots
      if (jid.startsWith('chat:')) {
        const roomId = jid.replace(/^chat:/, '');
        createChatRoom(roomId, name);
      }
      json(200, { ok: true, jid });
    } catch (err: any) {
      json(400, { error: err.message || 'Invalid JSON' });
    }
    return;
  }

  // Update a bot/group
  const botMatch = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
  if (botMatch && method === 'PUT') {
    try {
      const body = await readBody();
      const updates = JSON.parse(body);
      const jid = decodeURIComponent(botMatch[1]);
      updateRegisteredGroup(jid, updates);
      if (onGroupUpdatedCallback) onGroupUpdatedCallback();
      json(200, { ok: true });
    } catch (err: any) {
      json(400, { error: err.message || 'Invalid JSON' });
    }
    return;
  }

  // Delete a bot/group
  if (botMatch && method === 'DELETE') {
    const jid = decodeURIComponent(botMatch[1]);
    const group = getRegisteredGroup(jid);
    deleteRegisteredGroup(jid);
    if (jid.startsWith('chat:')) {
      const roomId = jid.replace(/^chat:/, '');
      deleteChatRoom(roomId);
    }
    if (group?.folder) {
      try {
        const folderPath = resolveGroupFolderPath(group.folder);
        fs.rmSync(folderPath, { recursive: true, force: true });
        logger.info({ jid, folder: group.folder }, 'Deleted group folder');
      } catch (err) {
        logger.error(
          { jid, folder: group.folder, err },
          'Failed to delete group folder (DB row already removed)',
        );
      }
    }
    return json(200, { ok: true });
  }

  // Create bot via main group — posts a message to the main chat room
  if (url.pathname === '/api/bots/create-from-chat' && method === 'POST') {
    try {
      const body = await readBody();
      const { description } = JSON.parse(body);
      if (!description) return json(400, { error: 'description required' });

      // Find the main group's chat room
      const groups = getAllRegisteredGroups();
      let mainRoomId: string | null = null;
      for (const [jid, g] of Object.entries(groups)) {
        if (g.isMain && jid.startsWith('chat:')) {
          mainRoomId = jid.replace(/^chat:/, '');
          break;
        }
      }
      if (!mainRoomId) {
        return json(400, {
          error:
            'No main chat room found. Register a main group on the chat channel first.',
        });
      }

      // Post the bot creation request as a message to the main room
      const prompt = `Create a new bot for the local chat channel based on this description:\n\n"${description}"\n\nUse mcp__nanoclaw__register_group to register it with a "chat:" JID and "local_" folder prefix (e.g. jid="chat:my-bot", folder="local_my-bot"). Then write a CLAUDE.md file to /workspace/group/../<folder>/CLAUDE.md with the bot's instructions. The CLAUDE.md should define the bot's personality, capabilities, and formatting preferences for a markdown-capable web chat. Confirm when done with the bot name and trigger word.`;

      const stored = storeChatMessage(mainRoomId, 'system', 'user', prompt);
      broadcast(mainRoomId, { type: 'message', ...stored });
      if (onNewMessageCallback) {
        onNewMessageCallback(mainRoomId, stored);
      }

      json(200, {
        ok: true,
        mainRoom: mainRoomId,
        message:
          'Bot creation request sent to main agent. Check the Control Room for progress.',
      });
    } catch (err: any) {
      json(500, { error: err.message || 'Failed' });
    }
    return;
  }

  // Bot instructions (CLAUDE.md)
  const instrMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/instructions$/);
  if (instrMatch && method === 'GET') {
    const jid = decodeURIComponent(instrMatch[1]);
    const groups = getAllRegisteredGroups();
    const group = groups[jid];
    if (!group) return json(404, { error: 'Bot not found' });
    const mdPath = path.join(resolveGroupFolderPath(group.folder), 'CLAUDE.md');
    const content = fs.existsSync(mdPath)
      ? fs.readFileSync(mdPath, 'utf-8')
      : '';
    return json(200, { content });
  }
  if (instrMatch && method === 'PUT') {
    try {
      const body = await readBody();
      const { content } = JSON.parse(body);
      const jid = decodeURIComponent(instrMatch[1]);
      const groups = getAllRegisteredGroups();
      const group = groups[jid];
      if (!group) return json(404, { error: 'Bot not found' });
      const groupDir = resolveGroupFolderPath(group.folder);
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), content || '');
      json(200, { ok: true });
    } catch {
      json(400, { error: 'Invalid JSON' });
    }
    return;
  }

  // ── File upload ─────────────────────────────────────────────────────────
  const uploadMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/upload$/);
  if (uploadMatch && method === 'POST') {
    const roomId = uploadMatch[1];
    const groupFolder = resolveGroupFolder(roomId);
    if (!groupFolder)
      return json(404, { error: 'Room not registered as a group' });

    const uploadsDir = getUploadsDir(groupFolder);
    fs.mkdirSync(uploadsDir, { recursive: true });

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return json(400, { error: 'Content-Type must be multipart/form-data' });
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

    busboy.on('finish', async () => {
      if (limitHit)
        return json(413, {
          error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
        });
      if (!fileInfo) return json(400, { error: 'No file uploaded' });

      const sender = senderIdentity;
      const fileMeta = {
        url: fileInfo.path,
        filename: fileInfo.filename,
        mime: fileInfo.mime,
        size: fileInfo.size,
      };
      const stored = storeFileMessage(
        roomId,
        sender,
        'user',
        fileMeta,
        caption,
      );
      broadcast(roomId, { type: 'message', ...stored });

      // Trigger the channel adapter so the agent processes this message
      if (onNewMessageCallback) {
        onNewMessageCallback(roomId, stored);
      }

      json(200, { ...fileInfo, caption });
    });

    busboy.on('error', () => json(500, { error: 'Upload failed' }));
    req.pipe(busboy);
    return;
  }

  // ── Web Push: VAPID public key + subscribe/unsubscribe ──────────────────
  if (url.pathname === '/api/push/vapid-public' && method === 'GET') {
    const pub = process.env.VAPID_PUBLIC_KEY || '';
    if (!pub) return json(501, { error: 'VAPID_PUBLIC_KEY not set' });
    return json(200, { key: pub });
  }

  if (url.pathname === '/api/push/subscribe' && method === 'POST') {
    const body = await readBody();
    let parsed: {
      endpoint?: string;
      keys?: { p256dh: string; auth: string };
    };
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    if (!parsed.endpoint || !parsed.keys?.p256dh || !parsed.keys?.auth) {
      return json(400, { error: 'Missing endpoint or keys' });
    }
    if (!isValidPushEndpoint(parsed.endpoint)) {
      return json(400, { error: 'Endpoint not on allowlist' });
    }
    // Length caps: real endpoints are ~400-600 chars, p256dh ~88 base64url,
    // auth ~24 base64url. Cap generously to prevent DB bloat.
    if (parsed.endpoint.length > 2048)
      return json(400, { error: 'Endpoint too long' });
    if (parsed.keys.p256dh.length > 256 || parsed.keys.auth.length > 64) {
      return json(400, { error: 'Key material too long' });
    }
    // Prevent identity-hijack on known endpoints: if the row already exists
    // with a different identity, reject instead of silently reassigning.
    const existingOwner = getPushSubscriptionOwner(parsed.endpoint);
    if (existingOwner && existingOwner !== senderIdentity) {
      logger.warn(
        {
          identity: senderIdentity,
          existingOwner,
          endpointTail: parsed.endpoint.slice(-24),
        },
        'Push subscribe rejected — endpoint owned by different identity',
      );
      return json(409, {
        error: 'Endpoint already registered to a different identity',
      });
    }
    upsertPushSubscription(
      parsed.endpoint,
      senderIdentity,
      JSON.stringify(parsed.keys),
    );
    logger.info(
      { identity: senderIdentity, endpointTail: parsed.endpoint.slice(-24) },
      'Push subscription stored',
    );
    return json(200, { ok: true });
  }

  if (url.pathname === '/api/push/unsubscribe' && method === 'POST') {
    const body = await readBody();
    let parsed: { endpoint?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    if (!parsed.endpoint) return json(400, { error: 'Missing endpoint' });
    // Only allow deleting your own subscription.
    deletePushSubscriptionForIdentity(parsed.endpoint, senderIdentity);
    return json(200, { ok: true });
  }

  // ── Chunked file upload ─────────────────────────────────────────────────
  const chunkMatch = url.pathname.match(
    /^\/api\/rooms\/([^/]+)\/upload\/chunk$/,
  );
  if (chunkMatch && method === 'POST') {
    const roomId = chunkMatch[1];
    const body = await readBody();
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
      return json(400, { error: 'Invalid JSON' });
    }

    const { uploadId, chunkIndex, totalChunks, filename, mime, data } = parsed;
    if (!uploadId || chunkIndex == null || !totalChunks || !filename || !data) {
      return json(400, { error: 'Missing required fields' });
    }

    // Validate uploadId as UUID to prevent path traversal
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        uploadId,
      )
    ) {
      return json(400, { error: 'Invalid uploadId format' });
    }

    const groupFolder = resolveGroupFolder(roomId);
    if (!groupFolder)
      return json(404, { error: 'Room not registered as a group' });

    // Initialize or retrieve upload state
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
    } else {
      // Validate totalChunks matches initial value
      if (totalChunks !== upload.totalChunks) {
        return json(400, { error: 'totalChunks mismatch' });
      }
    }

    // Write chunk and check incremental size
    const chunkBuf = Buffer.from(data, 'base64');
    upload.cumulativeSize += chunkBuf.length;
    if (upload.cumulativeSize > MAX_UPLOAD_SIZE) {
      cleanupChunkedUpload(uploadId);
      return json(413, {
        error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
      });
    }
    fs.writeFileSync(path.join(upload.tempDir, String(chunkIndex)), chunkBuf);
    upload.receivedChunks.add(chunkIndex);

    // Check if all chunks received
    if (upload.receivedChunks.size < upload.totalChunks) {
      return json(200, {
        ok: true,
        received: upload.receivedChunks.size,
        total: upload.totalChunks,
      });
    }

    // All chunks received — reassemble
    clearTimeout(upload.timer);

    // Check total size BEFORE writing to prevent disk DoS
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
      return json(413, {
        error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
      });
    }

    // Write reassembled file and await completion
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

    // Cleanup temp
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
    if (onNewMessageCallback) {
      onNewMessageCallback(roomId, stored);
    }

    return json(200, { ...fileMeta, caption });
  }

  // Serve uploaded files
  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
  if (fileMatch && method === 'GET') {
    const groupFolder = decodeURIComponent(fileMatch[1]);
    const filename = decodeURIComponent(fileMatch[2]);
    // Prevent path traversal
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
      return json(404, { error: 'File not found' });
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
    return;
  }

  // OPTIONS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Static PWA files
  if (servePwa(req, res)) return;

  json(404, { error: 'Not found' });
}

// ── WebSocket handler ──────────────────────────────────────────────────────
function setupWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  // Ping/pong keepalive — detect stale connections
  const WS_PING_INTERVAL = 30_000;
  const pingTimer = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.isAlive) {
        c.ws.terminate();
        removeClient(c.id);
        continue;
      }
      c.isAlive = false;
      c.ws.ping();
    }
  }, WS_PING_INTERVAL);
  wss.on('close', () => clearInterval(pingTimer));

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Authenticate the upgrade request
    const auth = await authenticateRequest(req);
    if (!auth.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket as any, head, (ws) => {
      // Attach identity so the connection handler can use it
      (req as any)._authIdentity = auth.identity;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const clientId = randomUUID();
    const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(
      /^::ffff:/,
      '',
    );

    const client: WSClient = {
      id: clientId,
      ws,
      identity: 'unauthenticated',
      identity_type: 'user',
      isAlive: true,
    };
    addClient(client);

    ws.on('pong', () => {
      client.isAlive = true;
    });
    ws.on('error', (err) => {
      logger.warn(
        { clientId, identity: client.identity, error: err.message },
        'WebSocket client error',
      );
    });

    let authenticated = false;

    const send = (data: object) => ws.send(JSON.stringify(data));

    ws.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', error: 'Invalid JSON' });
        return;
      }

      // ── AUTH ────────────────────────────────────────────────────────────
      if (msg.type === 'auth') {
        if (msg.token) {
          const agent = getChatAgentToken(msg.token);
          if (!agent) {
            send({ type: 'error', error: 'Invalid token' });
            return;
          }
          client.identity = agent.agent_id;
          client.identity_type = 'agent';
        } else {
          // Use identity from upgrade auth (token, localhost, proxy, or tailscale)
          const upgradeIdentity = (req as any)._authIdentity as
            | string
            | undefined;
          client.identity = upgradeIdentity || `user@${remoteIp}`;
          client.identity_type = 'user';
        }
        authenticated = true;
        send({ type: 'system', message: `Connected as ${client.identity}` });
        send({ type: 'rooms', rooms: getChatRooms() });
        return;
      }

      if (!authenticated) {
        send({ type: 'error', error: 'Not authenticated' });
        return;
      }

      // ── JOIN ─────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        const room = getChatRoom(msg.room_id);
        if (!room) {
          send({ type: 'error', error: `Room not found: ${msg.room_id}` });
          return;
        }
        client.room_id = room.id;
        send({
          type: 'history',
          room_id: room.id,
          messages: getChatMessages(room.id, 50).map((m) => ({
            ...m,
            content: redactSensitiveData(m.content),
          })),
        });
        broadcast(
          room.id,
          {
            type: 'system',
            room_id: room.id,
            message: `${client.identity} joined`,
          },
          clientId,
        );
        // Broadcast updated member list to all (including the joiner)
        broadcast(room.id, {
          type: 'members',
          room_id: room.id,
          members: getMemberList(room.id),
        });
        return;
      }

      // ── TYPING ───────────────────────────────────────────────────────────
      if (msg.type === 'typing') {
        if (!client.room_id) return;
        broadcast(
          client.room_id,
          {
            type: 'typing',
            room_id: client.room_id,
            identity: client.identity,
            identity_type: client.identity_type,
            is_typing: !!msg.is_typing,
          },
          clientId,
        );
        return;
      }

      // ── MESSAGE ───────────────────────────────────────────────────────────
      if (msg.type === 'message') {
        if (!client.room_id) {
          send({ type: 'error', error: 'Join a room first' });
          return;
        }
        if (!msg.content?.trim()) return;
        const stored = storeChatMessage(
          client.room_id,
          client.identity,
          client.identity_type,
          msg.content,
        );
        const outgoing: Record<string, unknown> = {
          type: 'message',
          ...stored,
        };
        if (msg.client_id) outgoing.client_id = msg.client_id;
        // broadcast() handles redaction for all message payloads
        broadcast(client.room_id, outgoing, clientId);
        if (onNewMessageCallback && client.identity_type === 'user') {
          onNewMessageCallback(client.room_id, stored);
        }
        // Redact for the sender's own echo
        send({ ...outgoing, content: redactSensitiveData(stored.content) });
        return;
      }

      // ── DELETE MESSAGE ──────────────────────────────────────────────────
      if (msg.type === 'delete_message') {
        if (!client.room_id) return;
        if (!msg.message_id) {
          send({ type: 'error', error: 'message_id required' });
          return;
        }
        const deleted = deleteChatMessage(msg.message_id, client.identity);
        if (deleted) {
          broadcast(client.room_id, {
            type: 'delete_message',
            room_id: client.room_id,
            message_id: msg.message_id,
          });
          send({
            type: 'delete_message',
            room_id: client.room_id,
            message_id: msg.message_id,
          });
        }
        return;
      }
    });

    ws.on('close', () => {
      const c = removeClient(clientId);
      if (c?.room_id) {
        broadcast(c.room_id, {
          type: 'system',
          room_id: c.room_id,
          message: `${c.identity} left`,
        });
        broadcast(c.room_id, {
          type: 'members',
          room_id: c.room_id,
          members: getMemberList(c.room_id),
        });
      }
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────
let server: http.Server | https.Server | null = null;

export async function startChatServer(): Promise<void> {
  if (process.env.CHAT_SERVER_ENABLED !== 'true') {
    logger.debug(
      'Chat server disabled (set CHAT_SERVER_ENABLED=true to enable)',
    );
    return;
  }

  const port = parseInt(process.env.CHAT_SERVER_PORT || '3100');
  const host = process.env.CHAT_SERVER_HOST || '127.0.0.1';
  const tlsCert = process.env.TLS_CERT;
  const tlsKey = process.env.TLS_KEY;

  initChatDatabase(DATA_DIR);
  initWebPush();

  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    logger.warn(
      'Both TLS_CERT and TLS_KEY must be set for HTTPS — falling back to HTTP',
    );
  }
  if (tlsCert && tlsKey) {
    server = https.createServer(
      {
        cert: fs.readFileSync(tlsCert),
        key: fs.readFileSync(tlsKey),
      },
      handleHttp,
    );
    logger.info('TLS enabled — serving over HTTPS');
  } else {
    server = http.createServer(handleHttp);
  }
  setupWebSocket(server);

  await new Promise<void>((resolve, reject) => {
    server!.listen(port, host, () => {
      const proto = tlsCert ? 'https' : 'http';
      logger.info({ port, host, proto }, 'Chat server started');
      warnIfAutoProxyTrust();
      resolve();
    });
    server!.once('error', reject);
  });
}

export function stopChatServer(): void {
  if (server) {
    server.close();
    server = null;
    logger.info('Chat server stopped');
  }
}
