/**
 * Baget admin pairing server.
 *
 * One HTTP server, three routes, all behind a constant-time bearer-token
 * check against `BAGET_ADMIN_TOKEN`. Wire contract is documented in
 * BAGET-DEPLOY.md "Pairing contract: baget.ai ↔ baget-channel".
 *
 *   POST   /baget/agent-groups                       — create / refresh + mint pairing token
 *   POST   /baget/agent-groups/:groupId/refresh-prompt — re-render prompt only
 *   DELETE /baget/agent-groups/:groupId              — soft-delete + unbind chat
 *   GET    /healthz                                   — public, no auth
 *   POST   /api/channels/telegram/webhook             — registered by the
 *                                                       Baget Telegram channel
 *                                                       via `registerExtraRoute`
 *
 * Listens on `PORT` (Railway's convention) → falls back to
 * `BAGET_ADMIN_PORT` → 8443. Single HTTP listener for the whole service
 * because Railway routes one public port per service; channel adapters
 * register their webhook routes here via `registerExtraRoute()`.
 *
 * Design notes:
 *
 *   - **Idempotency.** `POST /baget/agent-groups` is idempotent on
 *     `(userId, companyId)` per the contract. The renderer
 *     (`provisionBagetGroup`) is already idempotent on the folder slug;
 *     this server tracks the (userId, companyId, agent_group_id) tuple
 *     in `agent_groups` and re-uses an existing row instead of inserting
 *     a duplicate. Re-pairing a previously-archived group resurrects it
 *     (clears `archived_at`).
 *
 *   - **Pairing token.** HMAC-SHA256 over `<payload>` using
 *     `BAGET_ADMIN_TOKEN` as the key. Payload is URL-safe base64 of
 *     `{ uid, cid, agid, exp }`. The DB stores ONLY the SHA256 of the
 *     concatenated `<payload>.<hmac>` so a leak of the row table doesn't
 *     leak live tokens (forging still requires the HMAC key).
 *
 *   - **Concurrency.** All routes serialize via SQLite — better-sqlite3
 *     is synchronous so two parallel POSTs against the same
 *     (userId, companyId) race only on the partial UNIQUE index, which
 *     rejects the second insert. The retry path catches it and falls
 *     through to the refresh branch.
 *
 *   - **Error format.** All non-2xx responses are
 *     `{ ok: false, error: <code>, message: <human> }` so the baget.ai
 *     bridge can branch on `error` programmatically.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import http from 'http';

import {
  archiveBagetAgentGroup,
  countMessagingGroupBindings,
  createBagetAgentGroup,
  firstBoundChatId,
  getBagetAgentGroup,
  getBagetAgentGroupById,
  unarchiveBagetAgentGroup,
  unbindMessagingGroupsForAgent,
  updateBagetTeamMembers,
} from './db/baget-agent-groups.js';
import { insertPairingToken, sweepExpiredPairingTokens } from './db/baget-pairing-tokens.js';
import { provisionBagetGroup, type BagetTeamMembers } from './baget-pairing.js';
import { log } from './log.js';

// ── Auth ──

/**
 * Constant-time bearer-token check. Returns false on any malformed
 * header — we never log the supplied token (even truncated) because a
 * partial leak narrows brute-force time.
 */
export function verifyAdminBearer(headerValue: string | string[] | undefined, expectedToken: string): boolean {
  if (typeof headerValue !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!m) return false;
  const supplied = m[1];
  // timingSafeEqual requires equal-length buffers — pad both to the
  // longer of the two with constant zeros so we don't leak the expected
  // token's length on a length mismatch.
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  const max = Math.max(a.length, b.length);
  const ap = Buffer.alloc(max);
  const bp = Buffer.alloc(max);
  a.copy(ap);
  b.copy(bp);
  // If lengths differ, force a mismatch even when padded bytes happen
  // to align (zero-padded buffers can collide).
  const sameLen = a.length === b.length ? 1 : 0;
  return timingSafeEqual(ap, bp) && sameLen === 1;
}

// ── Pairing token mint ──

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

interface PairingTokenPayload {
  uid: string;
  cid: string;
  agid: string;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a single-use pairing token.
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>`. The HMAC defends
 * against forged tokens (you'd need BAGET_ADMIN_TOKEN to recompute it),
 * the DB row defends against replay (single-use via CAS update).
 *
 * `exp` is encoded into the payload AND stored in the DB row. The DB
 * is the source of truth — `consumePairingToken` checks the row's
 * exp, not the payload's. Encoding exp in the payload is a courtesy to
 * the consume endpoint so it can short-circuit obviously-stale tokens
 * without a DB read.
 */
export function mintPairingToken(args: {
  userId: string;
  companyId: string;
  agentGroupId: string;
  adminToken: string;
  now: number;
}): { rawToken: string; expiresAt: string; expiresAtMs: number } {
  const expiresAtMs = args.now + PAIRING_TOKEN_TTL_MS;
  const payload: PairingTokenPayload = {
    uid: args.userId,
    cid: args.companyId,
    agid: args.agentGroupId,
    exp: expiresAtMs,
  };
  // 16 bytes of nonce keeps tokens distinct even on the millisecond
  // collision case (two pairings in the same tick).
  const nonce = randomBytes(16);
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = b64url(Buffer.concat([nonce, Buffer.from(payloadJson, 'utf8')]));
  const hmac = createHmac('sha256', args.adminToken).update(payloadB64).digest();
  const hmacB64 = b64url(hmac);
  const rawToken = `${payloadB64}.${hmacB64}`;
  return { rawToken, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs };
}

/**
 * Verify a pairing token's HMAC. Used by the Telegram /start handler
 * before consuming the row — defense-in-depth so a tampered token
 * never even hits the DB.
 */
export function verifyPairingTokenHmac(rawToken: string, adminToken: string): boolean {
  const dot = rawToken.lastIndexOf('.');
  if (dot < 0) return false;
  const payloadB64 = rawToken.slice(0, dot);
  const hmacB64 = rawToken.slice(dot + 1);
  if (payloadB64.length === 0 || hmacB64.length === 0) return false;
  const expected = createHmac('sha256', adminToken).update(payloadB64).digest();
  let supplied: Buffer;
  try {
    // Re-pad base64url to base64 so Buffer.from can decode it.
    const padded = hmacB64 + '='.repeat((4 - (hmacB64.length % 4)) % 4);
    supplied = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return false;
  }
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

// ── Request types ──

export interface CreateAgentGroupBody {
  userId: string;
  companyId: string;
  companyName: string;
  teamMembers: BagetTeamMembers;
  channelTokenCredentialName: string;
  /** Default https://app.baget.ai. Must match the founder's environment. */
  bagetApiBaseUrl: string;
}

export interface CreateAgentGroupResponse {
  ok: true;
  agentGroupId: string;
  folder: string;
  telegramDeepLink: string;
  pairingTokenExpiresAt: string;
}

// ── Server ──

export interface BagetAdminServerConfig {
  port: number;
  /** Required — the bearer token baget.ai signs requests with. */
  adminToken: string;
  /** Telegram bot username, e.g. `baget_team_bot`. Used to build the deep link. */
  telegramBotUsername: string;
  /**
   * Function the route handlers use to ULID/UUID a new agent group.
   * Wired as a parameter so tests can inject a deterministic generator.
   */
  generateAgentGroupId: () => string;
  /** Function returning current time. Wired as a parameter so tests can fix the clock. */
  now?: () => number;
}

/**
 * External-route registration. Lets the Baget Telegram channel adapter
 * (and any future adapter) share this server's HTTP listener instead of
 * binding its own port. Required for Railway: a single service has
 * exactly ONE public ingress port, so admin + webhook routes have to
 * land on the same port.
 *
 * The handler is responsible for writing the entire response (status,
 * headers, body). It receives the raw IncomingMessage / ServerResponse.
 * Returning a Promise that rejects is logged but otherwise ignored —
 * the registered handler must not leak the request thread.
 */
export type ExtraRouteMatcher = (method: string, url: string) => boolean;
export type ExtraRouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void;

const extraRoutes: Array<{ matcher: ExtraRouteMatcher; handler: ExtraRouteHandler }> = [];

/**
 * Register an extra route handler that the admin server will dispatch
 * BEFORE its own admin routes (but AFTER the auth check is bypassed —
 * extra routes manage their own auth). Returns an unregister function.
 */
export function registerExtraRoute(matcher: ExtraRouteMatcher, handler: ExtraRouteHandler): () => void {
  const entry = { matcher, handler };
  extraRoutes.push(entry);
  return () => {
    const i = extraRoutes.indexOf(entry);
    if (i >= 0) extraRoutes.splice(i, 1);
  };
}

export type BagetAdminServer = {
  listen(): Promise<void>;
  close(): Promise<void>;
};

export function createBagetAdminServer(config: BagetAdminServerConfig): BagetAdminServer {
  if (!config.adminToken || config.adminToken.length < 16) {
    throw new Error('BAGET_ADMIN_TOKEN must be at least 16 characters');
  }
  if (!config.telegramBotUsername) {
    throw new Error('BAGET_TELEGRAM_BOT_USERNAME is required');
  }

  const now = config.now ?? Date.now;
  let server: http.Server | null = null;

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Reject anything other than the documented routes.
    const method = (req.method || 'GET').toUpperCase();
    const url = req.url || '';

    // /healthz is intentionally public (Railway probes it) and returns
    // a 200 with no DB read so it stays cheap and never leaks state.
    if (method === 'GET' && url === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Extra routes (Baget Telegram webhook, etc.) — dispatched BEFORE
    // the bearer-auth gate because they bring their own auth (e.g. the
    // X-Telegram-Bot-Api-Secret-Token check). Each handler owns the
    // response. First match wins.
    for (const { matcher, handler } of extraRoutes) {
      if (matcher(method, url)) {
        await handler(req, res);
        return;
      }
    }

    // Auth FIRST — before reading the body, before logging the path.
    // Otherwise we'd give an attacker a free request log signal.
    if (!verifyAdminBearer(req.headers.authorization, config.adminToken)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Bearer token missing or invalid' });
      return;
    }

    // Route matching. Order is significant: by-tuple (status) is
    // matched BEFORE the path-style routes since `?userId=…&companyId=…`
    // is a query string, not a `:groupId` path segment, but bare-URL
    // matching of `/baget/agent-groups` (no segment) needs to land on
    // create OR by-tuple depending on method+query-presence.
    const urlNoQuery = url.split('?')[0];
    const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';

    // Status: GET /baget/agent-groups/by-tuple?userId=…&companyId=…
    // Lets the dashboard's pair modal flip from "waiting" to
    // "Connected ✓" once the founder taps the deep link in Telegram.
    if (method === 'GET' && urlNoQuery === '/baget/agent-groups/by-tuple') {
      await handleStatusByTuple(res, queryString);
      return;
    }

    if (method === 'POST' && urlNoQuery === '/baget/agent-groups') {
      await handleCreate(req, res);
      return;
    }
    // Body-keyed DELETE /baget/agent-groups (with body { userId, companyId })
    // — matches the path-style DELETE /baget/agent-groups/:groupId
    // semantically but lets the baget.ai bridge skip the get-then-
    // delete dance (it doesn't track agent_group_id). Both shapes
    // route through the same archive logic.
    if (method === 'DELETE' && urlNoQuery === '/baget/agent-groups') {
      await handleDeleteByTuple(req, res);
      return;
    }
    const refreshMatch = /^\/baget\/agent-groups\/([^/]+)\/refresh-prompt$/.exec(urlNoQuery);
    if (method === 'POST' && refreshMatch) {
      await handleRefresh(req, res, refreshMatch[1]);
      return;
    }
    const deleteMatch = /^\/baget\/agent-groups\/([^/]+)$/.exec(urlNoQuery);
    if (method === 'DELETE' && deleteMatch) {
      await handleDelete(res, deleteMatch[1]);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found', message: `No route for ${method} ${url}` });
  }

  async function handleCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson<CreateAgentGroupBody>(req);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: body.error });
      return;
    }
    const validation = validateCreateBody(body.value);
    if (validation) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: validation });
      return;
    }
    const { userId, companyId, companyName, teamMembers, bagetApiBaseUrl, channelTokenCredentialName } = body.value;

    // 1. Idempotent provision: render CLAUDE.local.md + write
    //    container_config.json under groups/<folder>/. Pure file IO,
    //    safe to re-run.
    let provisioned: ReturnType<typeof provisionBagetGroup>;
    try {
      provisioned = provisionBagetGroup({
        userId,
        companyId,
        companyName,
        teamMembers,
        bagetApiBaseUrl,
        channelTokenCredentialName,
      });
    } catch (err) {
      log.error('Baget provision failed', { userId, companyId, err });
      sendJson(res, 500, {
        ok: false,
        error: 'provision_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // 2. Insert / resurrect the agent_groups row. Idempotent on
    //    (userId, companyId) per the partial UNIQUE index.
    const teamMembersJson = JSON.stringify(teamMembers);
    const existing = getBagetAgentGroup(userId, companyId);
    let agentGroupId: string;
    if (existing) {
      agentGroupId = existing.id;
      if (existing.archived_at) {
        unarchiveBagetAgentGroup(existing.id);
      }
      // Always refresh team names — a re-pair after a rename should
      // pick up the new names without requiring a separate
      // refresh-prompt call.
      updateBagetTeamMembers(existing.id, teamMembersJson);
    } else {
      agentGroupId = config.generateAgentGroupId();
      try {
        createBagetAgentGroup({
          id: agentGroupId,
          name: companyName,
          folder: provisioned.folder,
          user_id: userId,
          company_id: companyId,
          baget_team_members: teamMembersJson,
          created_at: new Date(now()).toISOString(),
        });
      } catch (err) {
        // Race with a concurrent create — re-read and use the winner.
        const winner = getBagetAgentGroup(userId, companyId);
        if (!winner) {
          log.error('Baget create race had no winner', { userId, companyId, err });
          sendJson(res, 500, {
            ok: false,
            error: 'create_failed',
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        agentGroupId = winner.id;
      }
    }

    // 3. Mint pairing token + store SHA256.
    const minted = mintPairingToken({
      userId,
      companyId,
      agentGroupId,
      adminToken: config.adminToken,
      now: now(),
    });
    insertPairingToken({
      rawToken: minted.rawToken,
      userId,
      companyId,
      agentGroupId,
      expiresAt: minted.expiresAt,
      createdAt: new Date(now()).toISOString(),
    });

    // 4. Opportunistic cleanup of expired tokens (fire and forget).
    sweepExpiredPairingTokens(new Date(now()).toISOString());

    const response: CreateAgentGroupResponse = {
      ok: true,
      agentGroupId,
      folder: provisioned.folder,
      telegramDeepLink: `https://t.me/${config.telegramBotUsername}?start=${minted.rawToken}`,
      pairingTokenExpiresAt: minted.expiresAt,
    };
    sendJson(res, 200, response);
  }

  async function handleRefresh(req: http.IncomingMessage, res: http.ServerResponse, groupId: string): Promise<void> {
    const body = await readJson<CreateAgentGroupBody>(req);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: body.error });
      return;
    }
    const validation = validateCreateBody(body.value);
    if (validation) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: validation });
      return;
    }
    // Refresh requires the row to already exist for this groupId.
    const existing = getBagetAgentGroup(body.value.userId, body.value.companyId);
    if (!existing || existing.id !== groupId) {
      sendJson(res, 404, {
        ok: false,
        error: 'group_not_found',
        message: `No Baget agent_group ${groupId} for the supplied (userId, companyId)`,
      });
      return;
    }
    try {
      provisionBagetGroup({
        userId: body.value.userId,
        companyId: body.value.companyId,
        companyName: body.value.companyName,
        teamMembers: body.value.teamMembers,
        bagetApiBaseUrl: body.value.bagetApiBaseUrl,
        channelTokenCredentialName: body.value.channelTokenCredentialName,
      });
    } catch (err) {
      log.error('Baget refresh failed', { groupId, err });
      sendJson(res, 500, {
        ok: false,
        error: 'refresh_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    updateBagetTeamMembers(groupId, JSON.stringify(body.value.teamMembers));
    sendJson(res, 200, { ok: true, agentGroupId: groupId, folder: existing.folder });
  }

  async function handleDelete(res: http.ServerResponse, groupId: string): Promise<void> {
    // Tenant guard: only Baget-provisioned rows (user_id IS NOT NULL)
    // can be archived through this endpoint. A baget.ai bug or
    // compromise that points DELETE at an unrelated agent_group_id
    // (e.g. a non-Baget legacy group) will get a 404 instead of
    // silently stamping `archived_at` on someone else's row.
    const existing = getBagetAgentGroupById(groupId);
    if (!existing || !existing.user_id) {
      sendJson(res, 404, {
        ok: false,
        error: 'group_not_found',
        message: `No Baget agent_group with id ${groupId}`,
      });
      return;
    }

    // Soft-delete the row + drop every chat→agent wiring it owns.
    // The rendered prompt + container_config.json stay on disk so a
    // future re-pair (POST /baget/agent-groups for the same user/co)
    // resurrects them. Without the unbind, post-archive DMs would
    // continue waking a runner against an archived group.
    archiveBagetAgentGroup(groupId, new Date(now()).toISOString());
    const unbound = unbindMessagingGroupsForAgent(groupId);
    sendJson(res, 200, { ok: true, agentGroupId: groupId, archived: true, unboundChats: unbound });
  }

  /**
   * GET /baget/agent-groups/by-tuple?userId=…&companyId=…
   *
   * Status check for the dashboard's pair modal. Returns whether an
   * agent_group exists for this (user, company), and whether it's
   * been chat-bound (i.e., the founder completed `/start` on
   * Telegram). The modal polls this every ~2s during the 5-min
   * pairing window.
   *
   * Shape:
   *   { ok: true, paired: boolean, agentGroupId?: string,
   *     platformChatId?: string }
   *
   * - `paired: true` requires BOTH agent_group exists AND has at least
   *   one binding in `messaging_group_agents`. Just provisioning the
   *   group (POST /baget/agent-groups) is NOT pairing — only `/start`
   *   creates the binding.
   * - Archived groups return `paired: false` even if they have
   *   leftover binding rows (the unbind in handleDelete is best-
   *   effort; a stale row here would falsely show "paired" forever).
   */
  async function handleStatusByTuple(res: http.ServerResponse, queryString: string): Promise<void> {
    const params = new URLSearchParams(queryString);
    const userId = params.get('userId') ?? '';
    const companyId = params.get('companyId') ?? '';
    if (!userId || !companyId) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_query',
        message: 'userId and companyId query params are required',
      });
      return;
    }
    const existing = getBagetAgentGroup(userId, companyId);
    if (!existing || existing.archived_at) {
      sendJson(res, 200, { ok: true, paired: false });
      return;
    }
    const bindingCount = countMessagingGroupBindings(existing.id);
    if (bindingCount === 0) {
      sendJson(res, 200, {
        ok: true,
        paired: false,
        agentGroupId: existing.id,
      });
      return;
    }
    const platformChatId = firstBoundChatId(existing.id);
    sendJson(res, 200, {
      ok: true,
      paired: true,
      agentGroupId: existing.id,
      ...(platformChatId ? { platformChatId } : {}),
    });
  }

  /**
   * DELETE /baget/agent-groups (body: { userId, companyId })
   *
   * Tuple-keyed sibling of `DELETE /baget/agent-groups/:groupId`. The
   * dashboard tracks (user, company) but not agent_group_id; this
   * shape lets the bridge call DELETE in one round-trip instead of
   * the get-then-delete dance (re-provision to fetch the id, then
   * DELETE by id). Same archive logic, same response shape.
   *
   * Returns 200 with `archived: false` when there's no group for the
   * tuple (idempotent — the founder's intent is satisfied trivially
   * when there's nothing to disconnect).
   */
  async function handleDeleteByTuple(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson<{ userId?: string; companyId?: string }>(req);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: body.error });
      return;
    }
    const { userId, companyId } = body.value;
    if (!userId || !companyId) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_body',
        message: 'userId and companyId are required',
      });
      return;
    }
    const existing = getBagetAgentGroup(userId, companyId);
    if (!existing) {
      // Idempotent no-op — matches the path-style DELETE's 404 only
      // when the row never existed; here we return 200 because the
      // dashboard's intent ("disconnect this binding") is met when
      // there's nothing to disconnect.
      sendJson(res, 200, { ok: true, archived: false, unboundChats: 0 });
      return;
    }
    if (existing.archived_at) {
      // Already archived — also a no-op success.
      sendJson(res, 200, {
        ok: true,
        agentGroupId: existing.id,
        archived: false,
        unboundChats: 0,
      });
      return;
    }
    archiveBagetAgentGroup(existing.id, new Date(now()).toISOString());
    const unbound = unbindMessagingGroupsForAgent(existing.id);
    sendJson(res, 200, {
      ok: true,
      agentGroupId: existing.id,
      archived: true,
      unboundChats: unbound,
    });
  }

  return {
    async listen(): Promise<void> {
      if (server) return;
      server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          log.error('Baget admin handler threw', { err, url: req.url });
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: 'internal_error', message: 'See server logs' });
          } else {
            try {
              res.end();
            } catch {
              // socket already gone
            }
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server!.once('error', onError);
        server!.listen(config.port, () => {
          server!.off('error', onError);
          log.info('Baget admin server listening', { port: config.port });
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    },
  };
}

function validateCreateBody(body: CreateAgentGroupBody): string | null {
  const required: Array<keyof CreateAgentGroupBody> = [
    'userId',
    'companyId',
    'companyName',
    'teamMembers',
    'channelTokenCredentialName',
    'bagetApiBaseUrl',
  ];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || (typeof body[k] === 'string' && body[k] === '')) {
      return `Missing required field: ${k}`;
    }
  }
  const tm = body.teamMembers;
  if (!tm || typeof tm !== 'object') return 'teamMembers must be an object';
  for (const role of ['cos', 'developer', 'marketing', 'analyst', 'design', 'ops'] as const) {
    if (typeof tm[role] !== 'string' || tm[role].trim().length === 0) {
      return `teamMembers.${role} must be a non-empty string`;
    }
  }
  // Cap user-controlled strings on the way in so a 10MB body doesn't
  // OOM us before we even start rendering.
  if (body.userId.length > 64 || body.companyId.length > 64) {
    return 'userId / companyId too long (max 64 chars)';
  }
  if (body.companyName.length > 200) return 'companyName too long (max 200 chars)';
  return null;
}

async function readJson<T>(req: http.IncomingMessage): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 64 * 1024; // 64KB — pairing bodies are tiny
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        req.destroy();
        resolve({ ok: false, error: 'body too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve({ ok: true, value: JSON.parse(raw) as T });
      } catch (err) {
        resolve({ ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

// Helper for callers (Telegram channel adapter) that need the same
// hash function the DB layer uses internally. Re-exported so callers
// don't reach into baget-pairing-tokens.ts directly.
export function tokenHash(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}
