/**
 * REST route handlers for the NanoClaw Web UI API gateway.
 *
 * All list endpoints use paginated DB functions and return
 * { data, total, limit, offset }. Group-scoped endpoints require ?group=.
 */
import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

import crypto from 'crypto';

import {
  countMemoriesKeyword,
  createMcpServer,
  createTaskFromApi,
  createUser,
  deleteTask,
  deleteMcpServer,
  deleteUser,
  getAllSessionsV2Full,
  getAllTasksPaginated,
  getBacklogPaginated,
  getGatesPaginated,
  getGateById,
  getPendingGate,
  getRecentMessages,
  getThreadMessagesByTrigger,
  getSessionsV2Full,
  getSessionV2ByKey,
  getShipLogPaginated,
  getTaskById,
  getTaskRunLogs,
  getTasksForGroupPaginated,
  getUserById,
  getUserByUsername,
  getUserGroups,
  hasAnyUsers,
  listMcpServers,
  listMemoriesPaginated,
  listUsers,
  resolveGate,
  searchMemoriesKeyword,
  setUserGroups,
  updateTask,
  updateUser,
} from '../db.js';
import {
  clearAuthCookie,
  getOrCreateJwtSecret,
  hashPassword,
  parseCookieToken,
  setAuthCookie,
  signJwt,
  verifyJwt,
  verifyPassword,
} from '../auth.js';
import { logger } from '../logger.js';
import { searchThreads } from '../thread-search.js';
import { BodyParseError, parseJsonBody } from './cors.js';
import {
  getInstalledSkills,
  getInstallJob,
  getSkillDetail,
  searchMarketplace,
  startSkillInstall,
} from './skills.js';
import type { ActiveSession, AuthUser, Capabilities } from './types.js';

// --- Deps ---

export interface RouteDeps {
  sendMessage: (
    groupJid: string,
    threadId: string | undefined,
    text: string,
  ) => boolean;
  getRegisteredGroups: () => Array<{
    jid: string;
    name: string;
    folder: string;
  }>;
  startSession: (groupJid: string, text: string) => boolean;
  getCapabilities: () => Capabilities;
  activeSessions: () => Map<string, ActiveSession>;
  addSseClient: (res: ServerResponse, req: IncomingMessage) => void;
  onSkillInstallProgress: (jobId: string, output: string) => void;
  onSkillInstallComplete: (jobId: string, success: boolean) => void;
  resumeGateApproval?: (gateId: string) => Promise<void>;
}

// --- Auth helpers ---

function isAdmin(auth: AuthUser | true): boolean {
  if (auth === true) return true;
  return auth.role === 'admin';
}

function hasGroupAccess(auth: AuthUser | true, groupFolder: string): boolean {
  if (auth === true) return true;
  if (auth.role === 'admin') return true;
  return auth.groups.includes(groupFolder);
}

// --- Helpers ---

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parsePagination(url: URL): { limit: number; offset: number } {
  let limit = parseInt(url.searchParams.get('limit') || '50', 10);
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (isNaN(limit) || limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  if (isNaN(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

function requireGroup(url: URL, res: ServerResponse): string | null {
  const group = url.searchParams.get('group');
  if (!group) {
    json(res, 400, { error: 'Missing required parameter: group' });
    return null;
  }
  return group;
}

/** Handle body parse errors. Legacy endpoints include `ok` in the response. */
function handleBodyError(
  res: ServerResponse,
  err: unknown,
  includeOk?: boolean,
): void {
  if (err instanceof BodyParseError) {
    json(
      res,
      err.status,
      includeOk ? { ok: false, error: err.message } : { error: err.message },
    );
  } else {
    json(
      res,
      400,
      includeOk
        ? { ok: false, error: 'Invalid JSON' }
        : { error: 'Invalid JSON' },
    );
  }
}

// Valid values for task fields — keep in sync with ScheduledTask type in types.ts
const VALID_STATUSES = ['active', 'paused', 'completed'];
const VALID_SCHEDULE_TYPES = ['cron', 'interval', 'once'];

// --- Route handler ---

/**
 * Handle an API route request. Returns true if the route was handled,
 * false if no matching route was found (404 fallthrough).
 */
export async function handleRoute(
  pathname: string,
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
  auth: AuthUser | true = true,
): Promise<boolean> {
  // --- Existing endpoints (migrated from web-ui.ts) ---

  if (pathname === '/events' && method === 'GET') {
    deps.addSseClient(res, req);
    return true;
  }

  if (pathname === '/api/groups' && method === 'GET') {
    json(res, 200, { groups: deps.getRegisteredGroups() });
    return true;
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    json(res, 200, {
      sessions: Object.fromEntries(deps.activeSessions()),
    });
    return true;
  }

  if (pathname === '/api/intervene' && method === 'POST') {
    try {
      const body = await parseJsonBody<{
        groupJid?: string;
        threadId?: string;
        text?: string;
      }>(req);
      if (!body.groupJid || !body.text) {
        json(res, 400, { ok: false, error: 'Missing groupJid or text' });
        return true;
      }
      const ok = deps.sendMessage(body.groupJid, body.threadId, body.text);
      json(res, ok ? 200 : 404, { ok });
    } catch (err) {
      handleBodyError(res, err, true);
    }
    return true;
  }

  if (pathname === '/api/send' && method === 'POST') {
    try {
      const body = await parseJsonBody<{
        groupJid?: string;
        text?: string;
      }>(req);
      if (!body.groupJid || !body.text) {
        json(res, 400, { ok: false, error: 'Missing groupJid or text' });
        return true;
      }
      const ok = deps.startSession(body.groupJid, body.text);
      json(res, ok ? 200 : 404, { ok });
    } catch (err) {
      handleBodyError(res, err, true);
    }
    return true;
  }

  // --- New endpoints ---

  // GET /api/capabilities
  if (pathname === '/api/capabilities' && method === 'GET') {
    json(res, 200, deps.getCapabilities());
    return true;
  }

  // GET /api/sessions/history?group= (group optional — omit for cross-group view)
  if (pathname === '/api/sessions/history' && method === 'GET') {
    const group = url.searchParams.get('group');
    const { limit, offset } = parsePagination(url);
    const result = group
      ? getSessionsV2Full(group, limit, offset)
      : getAllSessionsV2Full(limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/sessions/:key/messages
  const sessKeyMsgMatch = pathname.match(/^\/api\/sessions\/(.+)\/messages$/);
  if (sessKeyMsgMatch && method === 'GET') {
    const sessionKey = decodeURIComponent(sessKeyMsgMatch[1]);
    const { limit } = parsePagination(url);

    // Check active sessions first
    const active = deps.activeSessions();
    const session = active.get(sessionKey);
    if (session) {
      const messages = getRecentMessages(session.groupJid, limit);
      json(res, 200, { data: messages, sessionKey });
      return true;
    }

    // Fall back to DB lookup by session_key
    const dbSession = getSessionV2ByKey(sessionKey);
    if (dbSession?.chat_jid) {
      if (dbSession.thread_id) {
        // Try thread-specific JID first (e.g., dc:guild:thread:id or slack:team:thread:ts)
        const threadJid = `${dbSession.chat_jid}:thread:${dbSession.thread_id}`;
        const threadMessages = getRecentMessages(threadJid, limit);
        if (threadMessages.length > 0) {
          json(res, 200, { data: threadMessages, sessionKey });
          return true;
        }
        // Fall back to extracting thread messages from parent chat_jid
        const extracted = getThreadMessagesByTrigger(
          dbSession.chat_jid,
          dbSession.thread_id,
          limit,
        );
        if (extracted.length > 0) {
          json(res, 200, { data: extracted, sessionKey });
          return true;
        }
      }
      const messages = getRecentMessages(dbSession.chat_jid, limit);
      json(res, 200, { data: messages, sessionKey });
      return true;
    }

    json(res, 404, { error: 'Session not found' });
    return true;
  }

  // GET /api/tasks
  if (pathname === '/api/tasks' && method === 'GET') {
    const { limit, offset } = parsePagination(url);
    const group = url.searchParams.get('group');
    const result = group
      ? getTasksForGroupPaginated(group, limit, offset)
      : getAllTasksPaginated(limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // Match /api/tasks/:id patterns (but not /api/tasks/:id/logs, /pause, /resume)
  let taskIdMatch: RegExpMatchArray | null = null;
  let taskLogsMatch: RegExpMatchArray | null = null;
  let taskPauseMatch: RegExpMatchArray | null = null;
  let taskResumeMatch: RegExpMatchArray | null = null;
  if (pathname.startsWith('/api/tasks/')) {
    taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    taskLogsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    taskPauseMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/pause$/);
    taskResumeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
  }

  // GET /api/tasks/:id/logs
  if (taskLogsMatch && method === 'GET') {
    const taskId = decodeURIComponent(taskLogsMatch[1]);
    const { limit, offset } = parsePagination(url);
    const result = getTaskRunLogs(taskId, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // POST /api/tasks/:id/pause
  if (taskPauseMatch && method === 'POST') {
    const taskId = decodeURIComponent(taskPauseMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    updateTask(taskId, { status: 'paused' });
    json(res, 200, { ok: true, task: getTaskById(taskId) });
    return true;
  }

  // POST /api/tasks/:id/resume
  if (taskResumeMatch && method === 'POST') {
    const taskId = decodeURIComponent(taskResumeMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    // Recalculate next_run based on current time
    const nextRun = new Date().toISOString();
    updateTask(taskId, { status: 'active', next_run: nextRun });
    json(res, 200, { ok: true, task: getTaskById(taskId) });
    return true;
  }

  // GET /api/tasks/:id
  if (taskIdMatch && method === 'GET') {
    const taskId = decodeURIComponent(taskIdMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    json(res, 200, { data: task });
    return true;
  }

  // PATCH /api/tasks/:id
  if (taskIdMatch && method === 'PATCH') {
    const taskId = decodeURIComponent(taskIdMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      // Only allow specific fields
      const allowedFields = [
        'prompt',
        'schedule_type',
        'schedule_value',
        'schedule_tz',
        'status',
      ];
      const updates: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (field in body) {
          updates[field] = body[field];
        }
      }
      if (Object.keys(updates).length === 0) {
        json(res, 400, { error: 'No valid fields to update' });
        return true;
      }

      // Validate prompt field type
      if (updates.prompt !== undefined && typeof updates.prompt !== 'string') {
        json(res, 400, { error: 'Invalid prompt: must be a string' });
        return true;
      }

      // Validate field values
      if (
        updates.status !== undefined &&
        (typeof updates.status !== 'string' ||
          !VALID_STATUSES.includes(updates.status))
      ) {
        json(res, 400, {
          error: `Invalid status: must be one of ${VALID_STATUSES.join(', ')}`,
        });
        return true;
      }
      if (
        updates.schedule_type !== undefined &&
        (typeof updates.schedule_type !== 'string' ||
          !VALID_SCHEDULE_TYPES.includes(updates.schedule_type))
      ) {
        json(res, 400, {
          error: `Invalid schedule_type: must be one of ${VALID_SCHEDULE_TYPES.join(', ')}`,
        });
        return true;
      }
      // Determine the effective schedule_type for cron validation
      const effectiveScheduleType =
        (updates.schedule_type as string) || task.schedule_type;
      if (
        updates.schedule_value !== undefined &&
        effectiveScheduleType === 'cron'
      ) {
        if (
          typeof updates.schedule_value !== 'string' ||
          updates.schedule_value.trim() === ''
        ) {
          json(res, 400, {
            error:
              'Invalid schedule_value: cron expression must be a non-empty string',
          });
          return true;
        }
      }
      if (updates.schedule_tz !== undefined && updates.schedule_tz !== null) {
        if (
          typeof updates.schedule_tz !== 'string' ||
          updates.schedule_tz.trim() === ''
        ) {
          json(res, 400, {
            error: 'Invalid schedule_tz: must be a non-empty string',
          });
          return true;
        }
      }

      updateTask(taskId, updates as Parameters<typeof updateTask>[1]);
      json(res, 200, { ok: true, task: getTaskById(taskId) });
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // GET /api/memories
  if (pathname === '/api/memories' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const { limit, offset } = parsePagination(url);
    const result = listMemoriesPaginated(group, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/memories/search
  if (pathname === '/api/memories/search' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const q = url.searchParams.get('q') || '';
    if (!q) {
      json(res, 400, { error: 'Missing required parameter: q' });
      return true;
    }
    const { limit, offset } = parsePagination(url);
    const total = countMemoriesKeyword(group, q);
    const data = searchMemoriesKeyword(group, q, limit, offset);
    json(res, 200, { data, total, limit, offset });
    return true;
  }

  // GET /api/backlog
  if (pathname === '/api/backlog' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const { limit, offset } = parsePagination(url);
    const status = url.searchParams.get('status') || undefined;
    const result = getBacklogPaginated(group, status, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/ship-log
  if (pathname === '/api/ship-log' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const { limit, offset } = parsePagination(url);
    const result = getShipLogPaginated(group, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/threads/search
  if (pathname === '/api/threads/search' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    const q = url.searchParams.get('q') || '';
    if (!q) {
      json(res, 400, { error: 'Missing required parameter: q' });
      return true;
    }
    const { limit, offset } = parsePagination(url);
    try {
      // 10-second timeout with cleanup on success
      let timer: NodeJS.Timeout;
      const data = await Promise.race([
        searchThreads(group, q).finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Thread search timeout')),
            10_000,
          );
        }),
      ]);
      json(res, 200, { data, total: data.length, limit, offset });
    } catch (err) {
      logger.warn({ err, group, query: q }, 'Thread search failed/timed out');
      json(res, 200, {
        data: [],
        total: 0,
        limit,
        offset,
        error: 'search_timeout',
      });
    }
    return true;
  }

  // GET /api/skills/installed
  if (pathname === '/api/skills/installed' && method === 'GET') {
    const { limit, offset } = parsePagination(url);
    const all = getInstalledSkills();
    const data = all.slice(offset, offset + limit);
    json(res, 200, { data, total: all.length, limit, offset });
    return true;
  }

  // GET /api/skills/:name/detail
  const skillDetailMatch = pathname.match(/^\/api\/skills\/([^/]+)\/detail$/);
  if (skillDetailMatch && method === 'GET') {
    const skillName = decodeURIComponent(skillDetailMatch[1]);
    const detail = getSkillDetail(skillName);
    if (!detail) {
      json(res, 404, { error: 'Skill not found' });
      return true;
    }
    json(res, 200, detail);
    return true;
  }

  // GET /api/skills/marketplace
  if (pathname === '/api/skills/marketplace' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (!q) {
      json(res, 400, { error: 'Missing required parameter: q' });
      return true;
    }
    const result = await searchMarketplace(q);
    json(res, 200, result);
    return true;
  }

  // POST /api/skills/install
  if (pathname === '/api/skills/install' && method === 'POST') {
    try {
      const body = await parseJsonBody<{ repo?: string }>(req);
      if (!body.repo) {
        json(res, 400, { error: 'Missing required field: repo' });
        return true;
      }
      const result = startSkillInstall(
        body.repo,
        (jobId, output) => deps.onSkillInstallProgress(jobId, output),
        (jobId, success) => deps.onSkillInstallComplete(jobId, success),
      );
      if ('error' in result) {
        json(res, result.status, { error: result.error });
      } else {
        json(res, 202, {
          status: 'installing',
          jobId: result.jobId,
          requires_restart: result.requires_restart,
        });
      }
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // GET /api/skills/install/:jobId
  const installJobMatch = pathname.match(/^\/api\/skills\/install\/([^/]+)$/);
  if (installJobMatch && method === 'GET') {
    const jobId = decodeURIComponent(installJobMatch[1]);
    const job = getInstallJob(jobId);
    if (!job) {
      json(res, 404, { error: 'Install job not found' });
      return true;
    }
    json(res, 200, job);
    return true;
  }

  // --- Auth endpoints (A4) — setup and login do NOT require prior auth ---

  // GET /api/auth/setup-status — check if first-time setup is needed
  if (pathname === '/api/auth/setup-status' && method === 'GET') {
    json(res, 200, { needsSetup: !hasAnyUsers() });
    return true;
  }

  // POST /api/auth/setup — first-user registration (only when no users exist)
  if (pathname === '/api/auth/setup' && method === 'POST') {
    if (hasAnyUsers()) {
      json(res, 409, { error: 'Setup already completed' });
      return true;
    }
    try {
      const body = await parseJsonBody<{
        username?: string;
        password?: string;
        displayName?: string;
      }>(req);
      if (!body.username || !body.password) {
        json(res, 400, {
          error: 'Missing required fields: username, password',
        });
        return true;
      }
      const hash = await hashPassword(body.password);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      createUser({
        id,
        username: body.username,
        password_hash: hash,
        display_name: body.displayName ?? null,
        role: 'admin',
        created_at: now,
        updated_at: now,
      });
      const user = getUserById(id)!;
      const secret = getOrCreateJwtSecret();
      const token = signJwt({ userId: id, role: 'admin' }, secret);
      setAuthCookie(res, token);
      json(res, 201, {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
      });
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // POST /api/auth/login
  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const body = await parseJsonBody<{
        username?: string;
        password?: string;
      }>(req);
      if (!body.username || !body.password) {
        json(res, 400, {
          error: 'Missing required fields: username, password',
        });
        return true;
      }
      const user = getUserByUsername(body.username);
      if (!user) {
        json(res, 401, { error: 'Invalid credentials' });
        return true;
      }
      const valid = await verifyPassword(body.password, user.password_hash);
      if (!valid) {
        json(res, 401, { error: 'Invalid credentials' });
        return true;
      }
      const secret = getOrCreateJwtSecret();
      const token = signJwt({ userId: user.id, role: user.role }, secret);
      setAuthCookie(res, token);
      json(res, 200, {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
      });
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // POST /api/auth/logout
  if (pathname === '/api/auth/logout' && method === 'POST') {
    clearAuthCookie(res);
    json(res, 200, { ok: true });
    return true;
  }

  // GET /api/auth/me — returns current user from JWT cookie
  if (pathname === '/api/auth/me' && method === 'GET') {
    const cookieToken = parseCookieToken(req.headers.cookie);
    if (!cookieToken) {
      json(res, 401, { error: 'Not authenticated' });
      return true;
    }
    const secret = getOrCreateJwtSecret();
    const payload = verifyJwt(cookieToken, secret);
    if (!payload) {
      json(res, 401, { error: 'Invalid or expired token' });
      return true;
    }
    const user = getUserById(payload.userId);
    if (!user) {
      json(res, 401, { error: 'User not found' });
      return true;
    }
    const groups = getUserGroups(user.id);
    json(res, 200, {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      groups,
    });
    return true;
  }

  // Admin-only user management endpoints

  // GET /api/auth/users — list all users
  if (pathname === '/api/auth/users' && method === 'GET') {
    if (!isAdmin(auth)) {
      json(res, 403, { error: 'Admin access required' });
      return true;
    }
    const users = listUsers();
    json(res, 200, {
      data: users.map((u) => ({
        ...u,
        groups: getUserGroups(u.id),
      })),
    });
    return true;
  }

  // POST /api/auth/users — create user
  if (pathname === '/api/auth/users' && method === 'POST') {
    if (!isAdmin(auth)) {
      json(res, 403, { error: 'Admin access required' });
      return true;
    }
    try {
      const body = await parseJsonBody<{
        username?: string;
        password?: string;
        displayName?: string;
        role?: string;
        groups?: string[];
      }>(req);
      if (!body.username || !body.password) {
        json(res, 400, {
          error: 'Missing required fields: username, password',
        });
        return true;
      }
      const role = body.role === 'admin' ? 'admin' : 'member';
      const hash = await hashPassword(body.password);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      createUser({
        id,
        username: body.username,
        password_hash: hash,
        display_name: body.displayName ?? null,
        role,
        created_at: now,
        updated_at: now,
      });
      if (body.groups && Array.isArray(body.groups)) {
        setUserGroups(id, body.groups);
      }
      const user = getUserById(id)!;
      json(res, 201, {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        groups: getUserGroups(id),
      });
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // PATCH /api/auth/users/:id — update user
  const userIdMatch = pathname.match(/^\/api\/auth\/users\/([^/]+)$/);
  if (userIdMatch && method === 'PATCH') {
    if (!isAdmin(auth)) {
      json(res, 403, { error: 'Admin access required' });
      return true;
    }
    const userId = decodeURIComponent(userIdMatch[1]);
    const existing = getUserById(userId);
    if (!existing) {
      json(res, 404, { error: 'User not found' });
      return true;
    }
    try {
      const body = await parseJsonBody<{
        displayName?: string;
        role?: string;
        password?: string;
        groups?: string[];
      }>(req);
      const updates: Parameters<typeof updateUser>[1] = {};
      if (body.displayName !== undefined)
        updates.display_name = body.displayName;
      if (body.role === 'admin' || body.role === 'member')
        updates.role = body.role;
      if (body.password)
        updates.password_hash = await hashPassword(body.password);
      updateUser(userId, updates);
      if (body.groups !== undefined && Array.isArray(body.groups)) {
        setUserGroups(userId, body.groups);
      }
      const updated = getUserById(userId)!;
      json(res, 200, {
        id: updated.id,
        username: updated.username,
        display_name: updated.display_name,
        role: updated.role,
        groups: getUserGroups(userId),
      });
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // DELETE /api/auth/users/:id — delete user
  if (userIdMatch && method === 'DELETE') {
    if (!isAdmin(auth)) {
      json(res, 403, { error: 'Admin access required' });
      return true;
    }
    const userId = decodeURIComponent(userIdMatch[1]);
    const deleted = deleteUser(userId);
    if (!deleted) {
      json(res, 404, { error: 'User not found' });
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  // --- Gate endpoints (A5) — admin only ---

  // GET /api/gates — list gates with optional ?status= filter, paginated
  if (pathname === '/api/gates' && method === 'GET') {
    if (!isAdmin(auth)) {
      json(res, 403, { error: 'Admin access required' });
      return true;
    }
    const { limit, offset } = parsePagination(url);
    const status = url.searchParams.get('status') || undefined;
    const result = getGatesPaginated(status, limit, offset);
    json(res, 200, { ...result, limit, offset });
    return true;
  }

  // GET /api/gates/history — resolved gates, paginated
  if (pathname === '/api/gates/history' && method === 'GET') {
    if (!isAdmin(auth)) {
      json(res, 403, { error: 'Admin access required' });
      return true;
    }
    const { limit, offset } = parsePagination(url);
    // History = non-pending gates
    const result = getGatesPaginated('approved', limit, offset);
    const cancelled = getGatesPaginated('cancelled', 50, 0);
    // Combine both resolved statuses
    const combined = [...result.data, ...cancelled.data].sort((a, b) =>
      (b.resolved_at ?? b.created_at).localeCompare(
        a.resolved_at ?? a.created_at,
      ),
    );
    json(res, 200, {
      data: combined.slice(offset, offset + limit),
      total: result.total + cancelled.total,
      limit,
      offset,
    });
    return true;
  }

  // Gate ID route patterns
  const gateApproveMatch = pathname.match(/^\/api\/gates\/([^/]+)\/approve$/);
  const gateCancelMatch = pathname.match(/^\/api\/gates\/([^/]+)\/cancel$/);

  // POST /api/gates/:id/approve
  if (gateApproveMatch && method === 'POST') {
    if (!isAdmin(auth)) {
      json(res, 403, { error: 'Admin access required' });
      return true;
    }
    const gateId = decodeURIComponent(gateApproveMatch[1]);
    const gate = getGateById(gateId);
    if (!gate) {
      json(res, 404, { error: 'Gate not found' });
      return true;
    }
    if (gate.status !== 'pending') {
      json(res, 409, { error: 'Gate is not pending' });
      return true;
    }
    // Use resumeGateApproval if available (full agent resume), else just resolve
    if (deps.resumeGateApproval) {
      try {
        await deps.resumeGateApproval(gateId);
        json(res, 200, { ok: true });
      } catch (err) {
        logger.error({ err, gateId }, 'resumeGateApproval failed');
        json(res, 500, { error: 'Failed to resume gate' });
      }
    } else {
      resolveGate(gateId, 'approved');
      json(res, 200, { ok: true });
    }
    return true;
  }

  // POST /api/gates/:id/cancel
  if (gateCancelMatch && method === 'POST') {
    if (!isAdmin(auth)) {
      json(res, 403, { error: 'Admin access required' });
      return true;
    }
    const gateId = decodeURIComponent(gateCancelMatch[1]);
    const gate = getGateById(gateId);
    if (!gate) {
      json(res, 404, { error: 'Gate not found' });
      return true;
    }
    if (gate.status !== 'pending') {
      json(res, 409, { error: 'Gate is not pending' });
      return true;
    }
    resolveGate(gateId, 'cancelled');
    json(res, 200, { ok: true });
    return true;
  }

  // --- Dashboard endpoint (A6) ---

  // GET /api/dashboard?group=
  if (pathname === '/api/dashboard' && method === 'GET') {
    const groupParam = url.searchParams.get('group') || undefined;
    if (groupParam && !hasGroupAccess(auth, groupParam)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }
    const recentSessions = groupParam
      ? getSessionsV2Full(groupParam, 5, 0).data
      : getAllSessionsV2Full(5, 0).data;
    const pendingGatesResult = getGatesPaginated('pending', 50, 0);
    const activeTasks = groupParam
      ? getTasksForGroupPaginated(groupParam, 20, 0).data.filter(
          (t) => t.status === 'active',
        )
      : getAllTasksPaginated(20, 0).data.filter((t) => t.status === 'active');
    const recentShipLog = groupParam
      ? getShipLogPaginated(groupParam, 5, 0).data
      : [];
    json(res, 200, {
      recentSessions,
      pendingGates: pendingGatesResult.data,
      activeTasks,
      recentShipLog,
    });
    return true;
  }

  // POST /api/tasks — create task from API (A6)
  if (pathname === '/api/tasks' && method === 'POST') {
    try {
      const body = await parseJsonBody<{
        group?: string;
        prompt?: string;
        schedule?: string;
        schedule_tz?: string;
        description?: string;
      }>(req);
      if (!body.group || !body.prompt || !body.schedule) {
        json(res, 400, {
          error: 'Missing required fields: group, prompt, schedule',
        });
        return true;
      }
      if (!hasGroupAccess(auth, body.group)) {
        json(res, 403, { error: 'Access denied to group' });
        return true;
      }
      // Resolve group folder to chat_jid
      const groups = deps.getRegisteredGroups();
      const groupInfo = groups.find((g) => g.folder === body.group);
      if (!groupInfo) {
        json(res, 404, { error: `Group not found: ${body.group}` });
        return true;
      }
      const now = new Date().toISOString();
      const taskId = crypto.randomUUID();
      createTaskFromApi({
        id: taskId,
        group_folder: body.group,
        chat_jid: groupInfo.jid,
        prompt: body.prompt,
        schedule_type: 'cron',
        schedule_value: body.schedule,
        context_mode: 'isolated',
        task_type: 'container',
        schedule_tz: body.schedule_tz ?? null,
        next_run: now,
        status: 'active',
        created_at: now,
      });
      json(res, 201, { ok: true, task: getTaskById(taskId) });
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // DELETE /api/tasks/:id (A6 — override the existing task match pattern for DELETE)
  // Note: taskIdMatch is already declared above. Re-check here for DELETE.
  if (taskIdMatch && method === 'DELETE') {
    const taskId = decodeURIComponent(taskIdMatch[1]);
    const task = getTaskById(taskId);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    if (!hasGroupAccess(auth, task.group_folder)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }
    deleteTask(taskId);
    json(res, 200, { ok: true });
    return true;
  }

  // --- MCP server endpoints (A8) ---

  // GET /api/mcp-servers?group=
  if (pathname === '/api/mcp-servers' && method === 'GET') {
    const group = requireGroup(url, res);
    if (!group) return true;
    if (!hasGroupAccess(auth, group)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }
    const servers = listMcpServers(group);
    json(res, 200, { data: servers });
    return true;
  }

  // POST /api/mcp-servers
  if (pathname === '/api/mcp-servers' && method === 'POST') {
    try {
      const body = await parseJsonBody<{
        group?: string;
        name?: string;
        url?: string;
        type?: string;
      }>(req);
      if (!body.group || !body.name || !body.url) {
        json(res, 400, { error: 'Missing required fields: group, name, url' });
        return true;
      }
      if (!hasGroupAccess(auth, body.group)) {
        json(res, 403, { error: 'Access denied to group' });
        return true;
      }
      const serverType =
        body.type === 'stdio' || body.type === 'streamable-http'
          ? body.type
          : 'sse';
      const id = crypto.randomUUID();
      createMcpServer({
        id,
        group_folder: body.group,
        name: body.name,
        url: body.url,
        server_type: serverType,
      });
      json(res, 201, {
        data: {
          id,
          group_folder: body.group,
          name: body.name,
          url: body.url,
          server_type: serverType,
        },
      });
    } catch (err) {
      handleBodyError(res, err);
    }
    return true;
  }

  // DELETE /api/mcp-servers/:id
  const mcpServerIdMatch = pathname.match(/^\/api\/mcp-servers\/([^/]+)$/);
  if (mcpServerIdMatch && method === 'DELETE') {
    const serverId = decodeURIComponent(mcpServerIdMatch[1]);
    // Find the server first to check group access
    const allServers = deps
      .getRegisteredGroups()
      .flatMap((g) => listMcpServers(g.folder));
    const server = allServers.find((s) => s.id === serverId);
    if (!server) {
      json(res, 404, { error: 'MCP server not found' });
      return true;
    }
    if (!hasGroupAccess(auth, server.group_folder)) {
      json(res, 403, { error: 'Access denied to group' });
      return true;
    }
    deleteMcpServer(serverId);
    json(res, 200, { ok: true });
    return true;
  }

  // No match
  return false;
}
