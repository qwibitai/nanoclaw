/**
 * Playground channel — local web workbench for iterating on agent
 * personas before applying them to a target group.
 *
 * Architecture:
 *   - Registers as a normal channel adapter (`channel_type = 'playground'`).
 *   - Each draft gets its own auto-created `messaging_groups` row via
 *     `ensureDraftMessagingGroup` from agent-builder/core.ts.
 *   - HTTP server is *lazy*: not bound at host boot. `/playground` on
 *     Telegram calls `startPlaygroundServer()` which binds the port.
 *     `/playground stop` calls `stopPlaygroundServer()`.
 *   - One Server-Sent Events stream per connected browser tab. The
 *     adapter's `deliver()` pushes outbound messages to all SSE clients
 *     subscribed to the matching draft.
 *
 * Adapter is "always registered" but only does work when the server is
 * running. `deliver()` no-ops gracefully when no clients are connected
 * — the outbound row is already in `outbound.db`, so nothing's lost.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { PLAYGROUND_BIND_HOST, PLAYGROUND_ENABLED, PLAYGROUND_IDLE_MS, PLAYGROUND_PORT } from '../config.js';
import { log } from '../log.js';
import {
  applyDraft,
  createDraft,
  diffDraftAgainstTarget,
  discardDraft,
  ensureDraftMessagingGroup,
  ensureDraftWiring,
  getDraftStatus,
  listAgentGroups,
  listDrafts,
} from '../agent-builder/core.js';
import { checkDraftMutation } from './playground-gate-registry.js';
import { GROUPS_DIR } from '../config.js';
import { getAgentGroupByFolder, updateAgentGroup } from '../db/agent-groups.js';
import { getActiveSessions, updateSession } from '../db/sessions.js';
import { isContainerRunning, killContainer } from '../container-runner.js';
import { readContainerConfig, writeContainerConfig } from '../container-config.js';
import { getLibraryCacheStat, listLibrary } from './playground/library.js';
import type { ChannelAdapter, ChannelSetup, InboundEvent, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const PLATFORM_PREFIX = 'playground:';

// ── Magic-link auth ────────────────────────────────────────────────────────
//
// /playground generates a fresh magic token and prints a URL containing
// it. Hitting /auth?key=<token> validates the token, immediately
// invalidates it, sets a signed HTTP-only cookie, and redirects to /.
// All other endpoints require the cookie. /playground stop rotates the
// cookie secret, killing all active sessions.

const COOKIE_NAME = 'nc_playground';
let magicToken: string | null = null; // valid until first successful /auth, then null
let cookieValue: string | null = null; // value the cookie must match for auth
let cookieUserId: string | null = null; // who issued the magic link (Telegram user_id, e.g. "telegram:42"); null = anonymous session
let lastActivityAt = 0; // ms timestamp; bumped on every authed request

function rotateCredentials(userId: string | null = null): void {
  magicToken = crypto.randomBytes(24).toString('base64url');
  cookieValue = crypto.randomBytes(24).toString('base64url');
  cookieUserId = userId;
  lastActivityAt = Date.now();
}

/**
 * Returns true if the active session has been idle past the configured
 * limit. When that's the case, the cookie value is scrubbed (so the
 * next request gets 401), live SSE connections are closed, and the
 * playground "logs out" gracefully — re-sending /playground on Telegram
 * issues a fresh magic link.
 */
function checkIdleExpiry(): boolean {
  if (!cookieValue) return true;
  const idleMs = Date.now() - lastActivityAt;
  if (idleMs <= PLAYGROUND_IDLE_MS) return false;

  log.info('Playground session idle-expired', { idleMinutes: Math.floor(idleMs / 60000) });
  cookieValue = null;
  cookieUserId = null;
  for (const c of sseClients) {
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  return true;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

// ── SSE client tracking ────────────────────────────────────────────────────

interface SseClient {
  draftFolder: string;
  res: http.ServerResponse;
}

const sseClients = new Set<SseClient>();

function pushToDraft(draftFolder: string, eventName: string, data: unknown): void {
  for (const client of sseClients) {
    if (client.draftFolder !== draftFolder) continue;
    try {
      client.res.write(`event: ${eventName}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // dropped connection — sweep on next iteration
    }
  }
}

// ── Adapter implementation ─────────────────────────────────────────────────

let setupConfig: ChannelSetup | null = null;

function createAdapter(): ChannelAdapter {
  return {
    name: 'playground',
    channelType: 'playground',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;
    },

    async teardown(): Promise<void> {
      setupConfig = null;
      await stopPlaygroundServer();
    },

    isConnected(): boolean {
      return setupConfig !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const draftFolder = platformId.startsWith(PLATFORM_PREFIX)
        ? platformId.slice(PLATFORM_PREFIX.length)
        : platformId;
      pushToDraft(draftFolder, 'message', { kind: message.kind, content: message.content });
      return undefined; // no platform message id
    },
  };
}

// Always register the adapter so the router can find it; the HTTP server
// is started separately via `/playground` Telegram command.
registerChannelAdapter('playground', { factory: createAdapter });

// ── HTTP server (lazy) ─────────────────────────────────────────────────────

let server: http.Server | null = null;

// Public assets live under src/ regardless of whether tsc has copied them
// into dist/. cwd is always the project root for both `node dist/index.js`
// (systemd) and `pnpm run dev` (tsx).
const PUBLIC_DIR = path.join(process.cwd(), 'src/channels/playground/public');

interface ServerStatus {
  running: boolean;
  url: string | null;
}

export function getPlaygroundStatus(): ServerStatus {
  return { running: server !== null, url: server !== null ? `http://localhost:${PLAYGROUND_PORT}/` : null };
}

function isPrivateIPv4(addr: string): boolean {
  return (
    addr.startsWith('10.') ||
    addr.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(addr) ||
    addr.startsWith('169.254.') ||
    addr === '127.0.0.1'
  );
}

/**
 * Pick a sensible IPv4 to advertise in the magic-link URL when bound to
 * 0.0.0.0. Prefer:
 *   1. PLAYGROUND_PUBLIC_HOST env override (user knows best)
 *   2. First non-loopback, non-private IPv4 (the public address)
 *   3. First non-loopback IPv4 (e.g. private LAN)
 *   4. 'localhost' as last resort
 */
function detectPublicHost(): string {
  const override = process.env.PLAYGROUND_PUBLIC_HOST;
  if (override) return override;

  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
    }
  }
  const publicIp = candidates.find((c) => !isPrivateIPv4(c));
  if (publicIp) return publicIp;
  if (candidates.length > 0) return candidates[0]!;
  return 'localhost';
}

function urlFor(host: string, key: string): string {
  // When bound to 0.0.0.0 we need to advertise an IP browsers can reach.
  // Otherwise (loopback or specific bind), just echo it.
  const display = host === '0.0.0.0' ? detectPublicHost() : host;
  return `http://${display}:${PLAYGROUND_PORT}/auth?key=${encodeURIComponent(key)}`;
}

export async function startPlaygroundServer(
  opts: { userId?: string | null } = {},
): Promise<{ url: string; alreadyRunning: boolean }> {
  if (!PLAYGROUND_ENABLED) {
    throw new Error(
      'PLAYGROUND_ENABLED is not set in env. Add PLAYGROUND_ENABLED=1 to .env or systemd unit and restart.',
    );
  }
  // Always rotate magic token + cookie value on (re)start. Old links die.
  // userId (when supplied) gets associated with the new cookie so role-aware
  // gates can identify who's editing.
  rotateCredentials(opts.userId ?? null);

  if (server) {
    return { url: urlFor(PLAYGROUND_BIND_HOST, magicToken!), alreadyRunning: true };
  }
  if (!setupConfig) {
    throw new Error('Playground adapter setup() was never called — host startup may have failed to register channels.');
  }

  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => handleRequest(req, res));
    httpServer.on('error', (err) => {
      log.error('Playground server error', { err });
      reject(err);
    });
    httpServer.listen(PLAYGROUND_PORT, PLAYGROUND_BIND_HOST, () => {
      server = httpServer;
      const url = urlFor(PLAYGROUND_BIND_HOST, magicToken!);
      log.info('Playground server started', { bind: PLAYGROUND_BIND_HOST, authMode: 'magic-link' });
      resolve({ url, alreadyRunning: false });
    });
  });
}

export async function stopPlaygroundServer(): Promise<void> {
  // Even if the server is somehow null, scrub creds defensively.
  magicToken = null;
  cookieValue = null;
  cookieUserId = null;
  if (!server) return;
  // Close all SSE connections.
  for (const c of sseClients) {
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  log.info('Playground server stopped');
}

// ── Request routing ────────────────────────────────────────────────────────

function send(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Auth model:
 *   - GET /auth?key=<magic>  — single-shot exchange. If <magic> matches
 *     `magicToken` (constant-time), invalidate it, set the session
 *     cookie, redirect to /.
 *   - All other endpoints require a cookie matching `cookieValue`.
 *
 * /playground stop nulls both `magicToken` and `cookieValue`, so all
 * existing browser tabs lose access on the next request.
 */
function handleAuthExchange(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== '/auth') return false;
  const submittedKey = url.searchParams.get('key') || '';
  if (!magicToken || !constantTimeEquals(submittedKey, magicToken)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Invalid or expired magic link. Re-send /playground on Telegram.\n');
    return true;
  }
  // One-shot: kill the magic token immediately. The cookie takes over.
  magicToken = null;
  if (!cookieValue) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('No cookie value initialized.\n');
    return true;
  }
  // 7-day session. HttpOnly + SameSite=Lax. Secure flag omitted because
  // the deployment is plain HTTP — see the security note in the SKILL doc.
  const cookie = `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
  res.writeHead(302, { location: '/', 'set-cookie': cookie });
  res.end();
  return true;
}

function isCookieAuthed(req: http.IncomingMessage): boolean {
  if (checkIdleExpiry()) return false; // also nulls cookieValue if expired
  if (!cookieValue) return false;
  const submitted = parseCookie(req.headers['cookie'], COOKIE_NAME);
  if (!submitted) return false;
  return constantTimeEquals(submitted, cookieValue);
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = req.method || 'GET';

  // /auth is the only unauthenticated endpoint.
  if (method === 'GET' && handleAuthExchange(url, res)) return;

  if (!isCookieAuthed(req)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Authorization required. Send /playground on Telegram for a magic link.\n');
    return;
  }

  // Bump activity for any authed request. SSE long-poll counts — the
  // browser's auto-reconnect on disconnect will keep this fresh.
  lastActivityAt = Date.now();

  // Static UI
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/app.js') {
    return serveStatic(res, 'app.js', 'application/javascript; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/style.css') {
    return serveStatic(res, 'style.css', 'text/css; charset=utf-8');
  }

  // API
  void route(req, res, url, method).catch((err) => {
    log.error('Playground request error', { url: req.url, err });
    if (!res.headersSent) send(res, 500, { error: String(err) });
  });
}

function serveStatic(res: http.ServerResponse, filename: string, contentType: string): void {
  const file = path.join(PUBLIC_DIR, filename);
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, { error: `Not found: ${filename}` });
      return;
    }
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, method: string): Promise<void> {
  // GET /api/groups — list non-draft agent groups
  if (method === 'GET' && url.pathname === '/api/groups') {
    return send(res, 200, listAgentGroups());
  }

  // GET /api/drafts — list drafts with target reference
  if (method === 'GET' && url.pathname === '/api/drafts') {
    return send(res, 200, listDrafts());
  }

  // POST /api/drafts — { targetFolder } → create draft + ensure mg+wiring
  if (method === 'POST' && url.pathname === '/api/drafts') {
    const body = await readJsonBody(req);
    const targetFolder = body.targetFolder as string | undefined;
    if (!targetFolder) return send(res, 400, { error: 'targetFolder required' });
    try {
      const draft = createDraft(targetFolder);
      ensureDraftWiring(draft.folder);
      return send(res, 200, draft);
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // DELETE /api/drafts/:folder
  const draftMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)$/);
  if (method === 'DELETE' && draftMatch) {
    const draftFolder = draftMatch[1]!;
    try {
      discardDraft(draftFolder);
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // POST /api/drafts/:folder/apply — apply to target
  const applyMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/apply$/);
  if (method === 'POST' && applyMatch) {
    const draftFolder = applyMatch[1]!;
    const body = await readJsonBody(req);
    const keepDraft = !!body.keepDraft;
    try {
      applyDraft(draftFolder, { keepDraft });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // POST /api/drafts/:folder/messages — body: { text } → forward to router
  const messagesMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/messages$/);
  if (method === 'POST' && messagesMatch) {
    const draftFolder = messagesMatch[1]!;
    const body = await readJsonBody(req);
    const text = body.text as string | undefined;
    if (!text) return send(res, 400, { error: 'text required' });
    if (!setupConfig) return send(res, 503, { error: 'adapter not ready' });

    try {
      ensureDraftMessagingGroup(draftFolder);
      ensureDraftWiring(draftFolder);
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }

    const platformId = `${PLATFORM_PREFIX}${draftFolder}`;
    const messageId = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event: InboundEvent = {
      channelType: 'playground',
      platformId,
      threadId: null,
      message: {
        id: messageId,
        kind: 'chat',
        content: JSON.stringify({ text, sender: 'You', senderId: 'playground-user' }),
        timestamp: new Date().toISOString(),
        isMention: true, // every playground message engages
        isGroup: false,
      },
    };
    void Promise.resolve(setupConfig.onInboundEvent(event)).catch((err) =>
      log.error('Playground onInboundEvent failed', { draftFolder, err }),
    );
    return send(res, 200, { ok: true, messageId });
  }

  // PUT /api/drafts/:folder/provider — body: { provider: 'claude' | 'codex' }
  // Updates the draft agent_group's provider for permanent change, AND sets
  // the active session's agent_provider so the next container spawn picks
  // it up. Kills any running container so the change applies on the next
  // message immediately.
  const providerMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/provider$/);
  if (method === 'PUT' && providerMatch) {
    const draftFolder = providerMatch[1]!;
    {
      const decision = checkDraftMutation(draftFolder, 'provider_put', cookieUserId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const provider = body.provider as string | undefined;
    if (!provider) return send(res, 400, { error: 'provider required' });

    const draft = getAgentGroupByFolder(draftFolder);
    if (!draft) return send(res, 404, { error: 'draft not found' });

    try {
      updateAgentGroup(draft.id, { agent_provider: provider });
      // Apply to any active session for this draft.
      for (const s of getActiveSessions()) {
        if (s.agent_group_id !== draft.id) continue;
        updateSession(s.id, { agent_provider: provider });
        if (isContainerRunning(s.id)) {
          try {
            killContainer(s.id, `provider switched to ${provider}`);
          } catch {
            /* best-effort */
          }
        }
      }
      return send(res, 200, { ok: true, provider });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/persona — read CLAUDE.local.md
  const personaGet = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/persona$/);
  if (method === 'GET' && personaGet) {
    const draftFolder = personaGet[1]!;
    try {
      const personaPath = path.join(GROUPS_DIR, draftFolder, 'CLAUDE.local.md');
      const text = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf8') : '';
      return send(res, 200, { text });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // PUT /api/drafts/:folder/persona — write CLAUDE.local.md
  if (method === 'PUT' && personaGet) {
    const draftFolder = personaGet[1]!;
    const body = await readJsonBody(req);
    const text = body.text;
    if (typeof text !== 'string') return send(res, 400, { error: 'text (string) required' });
    try {
      const personaPath = path.join(GROUPS_DIR, draftFolder, 'CLAUDE.local.md');
      fs.mkdirSync(path.dirname(personaPath), { recursive: true });
      fs.writeFileSync(personaPath, text);
      return send(res, 200, { ok: true, bytes: Buffer.byteLength(text) });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/diff — diff vs target
  const diffMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/diff$/);
  if (method === 'GET' && diffMatch) {
    const draftFolder = diffMatch[1]!;
    try {
      return send(res, 200, {
        diff: diffDraftAgainstTarget(draftFolder),
        status: getDraftStatus(draftFolder),
      });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/files — list non-hidden files in the draft folder
  const filesListMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/files$/);
  if (method === 'GET' && filesListMatch) {
    const draftFolder = filesListMatch[1]!;
    try {
      const draftDir = path.join(GROUPS_DIR, draftFolder);
      if (!fs.existsSync(draftDir)) return send(res, 404, { error: 'draft folder missing' });
      const files: Array<{ name: string; size: number; mtime: string }> = [];
      const walk = (dir: string, rel: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          const subRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(full, subRel);
          else if (entry.isFile()) {
            const st = fs.statSync(full);
            files.push({ name: subRel, size: st.size, mtime: st.mtime.toISOString() });
          }
        }
      };
      walk(draftDir, '');
      return send(res, 200, { files: files.sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET / PUT /api/drafts/:folder/files/:path — read / write a single file
  const fileMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/files\/(.+)$/);
  if (fileMatch && (method === 'GET' || method === 'PUT')) {
    const draftFolder = fileMatch[1]!;
    const relPath = decodeURIComponent(fileMatch[2]!);
    // Mutation gates (file PUT only — GETs are always allowed). Class
    // feature uses this to lock student drafts down to persona edits.
    if (method === 'PUT') {
      const decision = checkDraftMutation(draftFolder, 'file_put', cookieUserId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    // Path-traversal defense: reject .. or anything that resolves outside.
    if (relPath.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) {
      return send(res, 400, { error: 'invalid path' });
    }
    const draftDir = path.join(GROUPS_DIR, draftFolder);
    const filePath = path.join(draftDir, relPath);
    if (!filePath.startsWith(draftDir + path.sep)) {
      return send(res, 400, { error: 'invalid path' });
    }
    if (method === 'GET') {
      try {
        if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not found' });
        return send(res, 200, { text: fs.readFileSync(filePath, 'utf8') });
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    // PUT
    const body = await readJsonBody(req);
    const text = body.text;
    if (typeof text !== 'string') return send(res, 400, { error: 'text (string) required' });
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, text);
      return send(res, 200, { ok: true, bytes: Buffer.byteLength(text) });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/skills/library — list anthropic/skills cache contents
  if (method === 'GET' && url.pathname === '/api/skills/library') {
    try {
      const refresh = url.searchParams.get('refresh') === '1';
      return send(res, 200, { entries: listLibrary(refresh), cache: getLibraryCacheStat() });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // POST /api/skills/library/refresh — explicit git pull
  if (method === 'POST' && url.pathname === '/api/skills/library/refresh') {
    try {
      return send(res, 200, { entries: listLibrary(true), cache: getLibraryCacheStat() });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/skills — current draft's enabled skills
  // PUT /api/drafts/:folder/skills — set enabled skills (array | 'all')
  const skillsMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/skills$/);
  if (method === 'GET' && skillsMatch) {
    const draftFolder = skillsMatch[1]!;
    try {
      const cfg = readContainerConfig(draftFolder);
      return send(res, 200, { skills: cfg.skills });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }
  if (method === 'PUT' && skillsMatch) {
    const draftFolder = skillsMatch[1]!;
    {
      const decision = checkDraftMutation(draftFolder, 'skills_put', cookieUserId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const skills = body.skills as string[] | 'all' | undefined;
    if (skills === undefined || (skills !== 'all' && !Array.isArray(skills))) {
      return send(res, 400, { error: 'skills must be string[] or "all"' });
    }
    try {
      const cfg = readContainerConfig(draftFolder);
      cfg.skills = skills;
      writeContainerConfig(draftFolder, cfg);
      return send(res, 200, { ok: true, skills });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/stream — Server-Sent Events for outbound messages
  const streamMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/stream$/);
  if (method === 'GET' && streamMatch) {
    const draftFolder = streamMatch[1]!;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: {"draftFolder":"${draftFolder}"}\n\n`);
    const client: SseClient = { draftFolder, res };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  send(res, 404, { error: `No route: ${method} ${url.pathname}` });
}
