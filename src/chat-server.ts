/**
 * chat-server.ts — in-process HTTP + WebSocket chat server for NanoClaw.
 *
 * Controlled by env vars:
 *   CHAT_SERVER_ENABLED=true       (default: false)
 *   CHAT_SERVER_PORT=3100          (default: 3100)
 *   CHAT_SERVER_HOST=127.0.0.1    (default: 127.0.0.1 — localhost only)
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
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import Busboy from 'busboy';
import { randomUUID } from 'crypto';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import {
  getAllRegisteredGroups,
  setRegisteredGroup,
  updateRegisteredGroup,
  deleteRegisteredGroup,
} from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  initChatDatabase,
  getChatRooms,
  getChatRoom,
  createChatRoom,
  deleteChatRoom,
  getChatMessages,
  storeChatMessage,
  storeFileMessage,
  getChatAgentToken,
  getWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  createChatAgentToken,
  listChatAgentTokens,
} from './chat-db.js';

// ── In-memory client registry ──────────────────────────────────────────────
interface WSClient {
  id: string;
  ws: WebSocket;
  identity: string;
  identity_type: 'user' | 'agent';
  room_id?: string;
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
  const payload = JSON.stringify(msg);
  const isMessage = (msg as { type?: string }).type === 'message';
  const notifyPayload = isMessage
    ? JSON.stringify({ type: 'unread', room_id: roomId })
    : '';
  for (const c of clients.values()) {
    if (c.id === excludeId || c.ws.readyState !== WebSocket.OPEN) continue;
    if (c.room_id === roomId) c.ws.send(payload);
    else if (isMessage) c.ws.send(notifyPayload);
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

export function setOnNewMessage(cb: ChatMessageCallback): void {
  onNewMessageCallback = cb;
}

export function clearOnNewMessage(): void {
  onNewMessageCallback = null;
}

export function isChatServerRunning(): boolean {
  return server !== null;
}

// ── Tailscale identity ─────────────────────────────────────────────────────
import { execFile } from 'child_process';

async function tailscaleWhois(ip: string): Promise<string | null> {
  const cleanIp = ip.replace(/^::ffff:/, '');
  return new Promise((resolve) => {
    execFile(
      'tailscale',
      ['whois', '--json', cleanIp],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const login =
            data?.UserProfile?.LoginName ||
            data?.Node?.Hostinfo?.Hostname ||
            null;
          resolve(login);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// ── Authentication ────────────────────────────────────────────────────────
const CHAT_SERVER_TOKEN = process.env.CHAT_SERVER_TOKEN || '';

function isLocalhost(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

async function authenticateRequest(
  req: http.IncomingMessage,
): Promise<{ ok: boolean; identity?: string; reason?: string }> {
  const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(
    /^::ffff:/,
    '',
  );

  // Localhost always passes
  if (isLocalhost(remoteIp)) {
    return { ok: true, identity: `user@${remoteIp}` };
  }

  // Check bearer token from Authorization header or query param
  const authHeader = req.headers.authorization;
  const url = new URL(req.url ?? '/', `http://localhost`);
  const tokenParam = url.searchParams.get('token');
  const providedToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : tokenParam;

  if (CHAT_SERVER_TOKEN && providedToken === CHAT_SERVER_TOKEN) {
    return { ok: true, identity: `user@${remoteIp}` };
  }

  // Check Tailscale identity
  const tsUser = await tailscaleWhois(remoteIp);
  if (tsUser) {
    return { ok: true, identity: tsUser };
  }

  // No valid auth
  if (!CHAT_SERVER_TOKEN) {
    // No token configured — allow but warn
    logger.warn(
      { remoteIp },
      'Remote connection without auth (no CHAT_SERVER_TOKEN configured)',
    );
    return { ok: true, identity: `user@${remoteIp}` };
  }

  return { ok: false, reason: 'Unauthorized' };
}

// ── File upload helpers ────────────────────────────────────────────────────
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

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
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
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
    return json(200, getChatMessages(room.id, 100));
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
      json(200, { ok: true });
    } catch (err: any) {
      json(400, { error: err.message || 'Invalid JSON' });
    }
    return;
  }

  // Delete a bot/group
  if (botMatch && method === 'DELETE') {
    const jid = decodeURIComponent(botMatch[1]);
    deleteRegisteredGroup(jid);
    if (jid.startsWith('chat:')) {
      const roomId = jid.replace(/^chat:/, '');
      deleteChatRoom(roomId);
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

  // ── Workflows ──────────────────────────────────────────────────────────
  if (url.pathname === '/api/workflows' && method === 'GET') {
    return json(200, getWorkflows());
  }

  if (url.pathname === '/api/workflows' && method === 'POST') {
    try {
      const body = await readBody();
      const { name, steps } = JSON.parse(body);
      if (!name || !Array.isArray(steps))
        return json(400, { error: 'name and steps required' });
      json(200, createWorkflow(name, steps));
    } catch {
      json(400, { error: 'Invalid JSON' });
    }
    return;
  }

  const flowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (flowMatch && method === 'GET') {
    const flow = getWorkflow(flowMatch[1]);
    return flow ? json(200, flow) : json(404, { error: 'Workflow not found' });
  }

  if (flowMatch && method === 'PUT') {
    try {
      const body = await readBody();
      const updates = JSON.parse(body);
      updateWorkflow(flowMatch[1], updates);
      json(200, { ok: true });
    } catch {
      json(400, { error: 'Invalid JSON' });
    }
    return;
  }

  if (flowMatch && method === 'DELETE') {
    deleteWorkflow(flowMatch[1]);
    return json(200, { ok: true });
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
          error: `File exceeds ${MAX_UPLOAD_SIZE / 1024 / 1024}MB limit`,
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
    };
    addClient(client);

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
          const tsUser = await tailscaleWhois(remoteIp);
          client.identity = tsUser ?? `user@${remoteIp}`;
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
          messages: getChatMessages(room.id, 50),
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
        broadcast(client.room_id, outgoing, clientId);
        if (onNewMessageCallback && client.identity_type === 'user') {
          onNewMessageCallback(client.room_id, stored);
        }
        send(outgoing);
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
let server: http.Server | null = null;

export async function startChatServer(): Promise<void> {
  if (process.env.CHAT_SERVER_ENABLED !== 'true') {
    logger.debug(
      'Chat server disabled (set CHAT_SERVER_ENABLED=true to enable)',
    );
    return;
  }

  const port = parseInt(process.env.CHAT_SERVER_PORT || '3100');
  const host = process.env.CHAT_SERVER_HOST || '127.0.0.1';

  initChatDatabase(DATA_DIR);

  server = http.createServer(handleHttp);
  setupWebSocket(server);

  await new Promise<void>((resolve, reject) => {
    server!.listen(port, host, () => {
      logger.info({ port, host }, 'Chat server started');
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
