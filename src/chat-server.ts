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

import { DATA_DIR } from './config.js';
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
import {
  authenticateRequest,
  warnIfAutoProxyTrust,
} from './chat-server/auth.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  initChatDatabase,
  getChatRooms,
  getChatRoom,
  createChatRoom,
  deleteChatRoom,
  getChatMessages,
  getChatMessagesAfterId,
  storeChatMessage,
  storeFileMessage,
  createChatAgentToken,
  listChatAgentTokens,
  upsertPushSubscription,
  deletePushSubscriptionForIdentity,
  getPushSubscriptionOwner,
} from './chat-db.js';

// Re-export the externally-consumed chat-server API so existing import paths
// from channels/local-chat.ts and src/index.ts keep working.
export {
  broadcast,
  setAgentPresence,
  setOnNewMessage,
  clearOnNewMessage,
  setOnGroupUpdated,
  clearOnGroupUpdated,
  broadcastRooms,
} from './chat-server/state.js';
import {
  broadcast,
  getOnGroupUpdated,
  getOnNewMessage,
} from './chat-server/state.js';
import { initWebPush, isValidPushEndpoint } from './chat-server/push.js';
import { setupWebSocket } from './chat-server/ws.js';
import {
  handleMultipartUpload,
  handleChunkedUpload,
  handleFileServe,
} from './chat-server/files.js';

export function isChatServerRunning(): boolean {
  return server !== null;
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
      getOnGroupUpdated()?.();
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
      getOnNewMessage()?.(mainRoomId, stored);

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

  // ── File upload (multipart) ─────────────────────────────────────────────
  const uploadMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/upload$/);
  if (uploadMatch && method === 'POST') {
    return handleMultipartUpload(req, res, uploadMatch[1], senderIdentity);
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

  // ── File upload (chunked) ───────────────────────────────────────────────
  const chunkMatch = url.pathname.match(
    /^\/api\/rooms\/([^/]+)\/upload\/chunk$/,
  );
  if (chunkMatch && method === 'POST') {
    return handleChunkedUpload(req, res, chunkMatch[1], senderIdentity);
  }

  // Serve uploaded files
  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
  if (fileMatch && method === 'GET') {
    return handleFileServe(
      res,
      decodeURIComponent(fileMatch[1]),
      decodeURIComponent(fileMatch[2]),
    );
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
