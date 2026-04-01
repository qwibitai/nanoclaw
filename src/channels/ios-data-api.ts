/**
 * Data API endpoints for the iOS channel.
 *
 * Serves family data (calendar, initiatives, ideas/nits) over HTTP so the app
 * works on real devices over LAN — not just in Simulator with filesystem access.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import {
  getMessageHistory,
  getMessageHistoryAllIos,
  upsertDeviceToken,
  getAllTasks as getAllScheduledTasks,
  getTaskById as getScheduledTaskById,
  updateTask as updateScheduledTask,
  deleteTask as deleteScheduledTask,
} from '../db.js';
import { runDailyNudge } from '../daily-nudge.js';
import { sendPushToAll } from '../apns.js';
import { getThisWeekEvents } from '../calendar-service.js';
import {
  createTask as createDevTask,
  deleteTask as deleteDevTask,
  dispatchAndRun,
  listTasks as listDevTasks,
  readTask as readDevTask,
  updateTask as updateDevTask,
  type DevTask,
} from '../dev-tasks.js';

const SIGMA_REPO = path.join(
  process.env.HOME || '/Users/fambot',
  'Projects',
  'Sigma',
);
const INITIATIVES_DIR = path.join(SIGMA_REPO, 'initiatives');
const IDEAS_NITS_FILE = path.join(SIGMA_REPO, 'ideas-and-nits.md');
const TASKS_DIR = path.join(SIGMA_REPO, 'tasks');

const STATUSES = ['doing', 'next', 'later', 'done', 'cancelled'] as const;

/** Validate a slug or status parameter to prevent path traversal. */
function isSafePathSegment(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

/** Validate that a status value is one of the known statuses. */
function isValidStatus(value: string): value is (typeof STATUSES)[number] {
  return (STATUSES as readonly string[]).includes(value);
}

// Module-level broadcast callbacks
let broadcastChange: ((fileType: string) => void) | null = null;
let broadcastDevTasksChange: (() => void) | null = null;
let broadcastScheduledTasksChange: (() => void) | null = null;

/**
 * Watch the initiatives folder tree and ideas-and-nits file for changes.
 * Returns a cleanup function.
 */
export function watchWorkFiles(
  onChanged: (content: string, fileType: string) => void,
): () => void {
  broadcastChange = (fileType: string) => {
    if (fileType === 'initiatives') {
      const payload = JSON.stringify(scanInitiatives());
      onChanged(payload, 'initiatives');
    } else {
      try {
        const content = fs.readFileSync(IDEAS_NITS_FILE, 'utf-8');
        onChanged(content, 'ideas-and-nits');
      } catch {
        // ignore
      }
    }
  };

  const watchers: fs.FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Watch each status folder
  for (const status of STATUSES) {
    const dir = path.join(INITIATIVES_DIR, status);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const watcher = fs.watch(dir, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const payload = JSON.stringify(scanInitiatives());
          onChanged(payload, 'initiatives');
          logger.info('Initiative folder changed, broadcasting update');
        }, 500);
      });
      watchers.push(watcher);
    } catch {
      logger.warn({ dir }, 'Could not watch initiative folder');
    }
  }

  // Also watch individual initiative files for content changes
  // Supports both flat files (idea.md) and folders (idea/initiative.md)
  for (const status of STATUSES) {
    const dir = path.join(INITIATIVES_DIR, status);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        let filePath: string;
        if (entry.isDirectory()) {
          filePath = path.join(dir, entry.name, 'initiative.md');
          if (!fs.existsSync(filePath)) continue;
        } else if (entry.name.endsWith('.md')) {
          filePath = path.join(dir, entry.name);
        } else {
          continue;
        }
        const watcher = fs.watch(filePath, () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const payload = JSON.stringify(scanInitiatives());
            onChanged(payload, 'initiatives');
            logger.info(
              { file: entry.name },
              'Initiative file changed, broadcasting update',
            );
          }, 500);
        });
        watchers.push(watcher);
      }
    } catch {
      // folder might not exist yet
    }
  }

  // Watch ideas-and-nits file
  let inDebounce: ReturnType<typeof setTimeout> | null = null;
  let lastINContent = '';
  try {
    lastINContent = fs.readFileSync(IDEAS_NITS_FILE, 'utf-8');
  } catch {
    // file may not exist
  }
  try {
    const inWatcher = fs.watch(IDEAS_NITS_FILE, () => {
      if (inDebounce) clearTimeout(inDebounce);
      inDebounce = setTimeout(() => {
        try {
          const content = fs.readFileSync(IDEAS_NITS_FILE, 'utf-8');
          if (content !== lastINContent) {
            lastINContent = content;
            onChanged(content, 'ideas-and-nits');
            logger.info('Ideas/nits file changed, broadcasting update');
          }
        } catch {
          // ignore
        }
      }, 500);
    });
    watchers.push(inWatcher);
  } catch {
    logger.warn('Could not watch ideas-and-nits file');
  }

  logger.info('Watching initiatives folder and ideas-and-nits file');

  return () => {
    for (const w of watchers) w.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (inDebounce) clearTimeout(inDebounce);
  };
}

/**
 * Watch the tasks/ directory for changes and broadcast structured JSON updates.
 * Separate from watchWorkFiles because tasks need a different payload shape.
 */
export function watchDevTasks(
  onChanged: (tasks: DevTask[]) => void,
): () => void {
  broadcastDevTasksChange = () => {
    onChanged(listDevTasks());
  };

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    const watcher = fs.watch(TASKS_DIR, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        onChanged(listDevTasks());
        logger.info('Tasks directory changed, broadcasting update');
      }, 500);
    });

    logger.info('Watching tasks directory');

    return () => {
      watcher.close();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  } catch {
    logger.warn('Could not watch tasks directory');
    return () => {};
  }
}

/**
 * Register a broadcast callback for scheduled task changes.
 * Unlike dev tasks (filesystem-based), scheduled tasks live in SQLite,
 * so there's no directory to watch. Instead, the callback is invoked
 * after API mutations and should also be called by the task scheduler
 * after running tasks.
 */
export function watchScheduledTasks(
  onChanged: (tasks: import('../types.js').ScheduledTask[]) => void,
): () => void {
  broadcastScheduledTasksChange = () => {
    onChanged(getAllScheduledTasks());
  };

  return () => {
    broadcastScheduledTasksChange = null;
  };
}

/**
 * Notify connected clients that scheduled tasks have changed.
 * Called by the task scheduler after running tasks so the app stays in sync.
 */
export function notifyScheduledTasksChanged(): void {
  if (broadcastScheduledTasksChange) broadcastScheduledTasksChange();
}

// MARK: - Initiatives folder scanner

interface InitiativeData {
  slug: string;
  id: string | null; // Short identifier like TF, PUSH, MUC
  status: string;
  title: string;
  content: string; // Full markdown content of the file
  isReady: boolean;
  completedDate: string | null; // ISO date when moved to Done
  steps: { title: string; isDone: boolean; phase: string | null }[];
  hasLearnings: boolean;
}

/**
 * Scan the initiatives/ folder structure and return all initiatives
 * grouped by status.
 */
function scanInitiatives(): Record<string, InitiativeData[]> {
  const result: Record<string, InitiativeData[]> = {};

  for (const status of STATUSES) {
    const dir = path.join(INITIATIVES_DIR, status);
    const initiatives: InitiativeData[] = [];

    try {
      // Support both flat files (some-idea.md) and folders (some-idea/initiative.md)
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        let filePath: string;
        let slug: string;

        if (entry.isDirectory()) {
          // Folder-based initiative: read initiative.md inside the folder
          filePath = path.join(dir, entry.name, 'initiative.md');
          if (!fs.existsSync(filePath)) continue;
          slug = entry.name;
        } else if (entry.name.endsWith('.md')) {
          // Flat file initiative
          filePath = path.join(dir, entry.name);
          slug = entry.name.replace(/\.md$/, '');
        } else {
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf-8');

        // Extract short ID from first line (backtick-wrapped, e.g. `TF`)
        const idMatch = content.match(/^`([A-Z]+)`/);
        const shortId = idMatch ? idMatch[1] : null;

        // Extract title from first # heading
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1] : slug;

        // Check for [ready] marker
        const isReady = content.includes('[ready]');

        // Extract completed date (format: completed: 2026-03-19)
        const completedMatch = content.match(
          /^completed:\s*(\d{4}-\d{2}-\d{2})/m,
        );
        const completedDate = completedMatch ? completedMatch[1] : null;

        // Check for learnings section
        const hasLearnings = /^##\s+Learnings/m.test(content);

        // Extract steps with phase info
        const steps = parseSteps(content);

        initiatives.push({
          slug,
          id: shortId,
          status,
          title,
          content,
          isReady,
          completedDate,
          steps,
          hasLearnings,
        });
      }
    } catch {
      // folder might not exist
    }

    // Sort done/cancelled by completion date (most recent first)
    if (status === 'done' || status === 'cancelled') {
      initiatives.sort((a, b) => {
        if (!a.completedDate && !b.completedDate) return 0;
        if (!a.completedDate) return 1;
        if (!b.completedDate) return -1;
        return b.completedDate.localeCompare(a.completedDate);
      });
    }

    result[status] = initiatives;
  }

  return result;
}

/**
 * Parse steps from initiative markdown, tracking which phase they belong to.
 */
function parseSteps(
  content: string,
): { title: string; isDone: boolean; phase: string | null }[] {
  const lines = content.split('\n');
  const steps: { title: string; isDone: boolean; phase: string | null }[] = [];
  let currentPhase: string | null = null;

  for (const line of lines) {
    // Phase heading: **Phase N: ...**
    const phaseMatch = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1];
      continue;
    }

    // Step: - [ ] or - [x]
    const stepMatch = line.match(/^-\s+\[([ x])\]\s+(.+)$/);
    if (stepMatch) {
      steps.push({
        isDone: stepMatch[1] === 'x',
        title: stepMatch[2],
        phase: currentPhase,
      });
    }
  }

  return steps;
}

/**
 * Handle data API routes. Returns true if the request was handled.
 */
export function handleDataApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): boolean {
  const url = req.url || '';

  if (req.method === 'GET' && url === '/api/calendar') {
    authGuard(req, res, token, () => handleGetCalendar(res));
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/api/messages')) {
    authGuard(req, res, token, () => handleGetMessages(req, res));
    return true;
  }

  if (req.method === 'GET' && url === '/api/initiatives') {
    authGuard(req, res, token, () => handleGetInitiatives(res));
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/api/initiatives/')) {
    authGuard(req, res, token, () => handleGetInitiativeFile(req, res));
    return true;
  }

  if (req.method === 'GET' && url === '/api/ideas-and-nits') {
    authGuard(req, res, token, () => handleGetFile(res, IDEAS_NITS_FILE));
    return true;
  }

  if (req.method === 'PUT' && url === '/api/ideas-and-nits') {
    authGuard(req, res, token, () =>
      handlePutFile(req, res, IDEAS_NITS_FILE, 'ideas-and-nits'),
    );
    return true;
  }

  // Create new initiative: POST /api/initiatives
  if (req.method === 'POST' && url === '/api/initiatives') {
    authGuard(req, res, token, () => handleCreateInitiative(req, res));
    return true;
  }

  // Move initiative between statuses: POST /api/initiatives/move
  if (req.method === 'POST' && url === '/api/initiatives/move') {
    authGuard(req, res, token, () => handleMoveInitiative(req, res));
    return true;
  }

  // Register APNs device token: POST /api/device-token
  if (req.method === 'POST' && url === '/api/device-token') {
    authGuard(req, res, token, () => handleRegisterDeviceToken(req, res));
    return true;
  }

  // Test push endpoint: POST /api/push/test
  if (req.method === 'POST' && url === '/api/push/test') {
    authGuard(req, res, token, () => handleTestPush(req, res));
    return true;
  }

  // --- DevTask endpoints ---

  // List tasks: GET /api/dev-tasks?status=open
  if (
    req.method === 'GET' &&
    url.startsWith('/api/dev-tasks') &&
    !url.includes('/api/dev-tasks/')
  ) {
    authGuard(req, res, token, () => handleListDevTasks(req, res));
    return true;
  }

  // Get single task: GET /api/dev-tasks/:id
  const getTaskMatch =
    req.method === 'GET' && url.match(/^\/api\/dev-tasks\/(\d+)$/);
  if (getTaskMatch) {
    authGuard(req, res, token, () =>
      handleGetDevTask(res, parseInt(getTaskMatch[1], 10)),
    );
    return true;
  }

  // Create task: POST /api/dev-tasks
  if (req.method === 'POST' && url === '/api/dev-tasks') {
    authGuard(req, res, token, () => handleCreateDevTask(req, res));
    return true;
  }

  // Update task: PUT /api/dev-tasks/:id
  const putTaskMatch =
    req.method === 'PUT' && url.match(/^\/api\/dev-tasks\/(\d+)$/);
  if (putTaskMatch) {
    authGuard(req, res, token, () =>
      handleUpdateDevTask(req, res, parseInt(putTaskMatch[1], 10)),
    );
    return true;
  }

  // Delete task: DELETE /api/dev-tasks/:id
  const deleteTaskMatch =
    req.method === 'DELETE' && url.match(/^\/api\/dev-tasks\/(\d+)$/);
  if (deleteTaskMatch) {
    authGuard(req, res, token, () =>
      handleDeleteDevTask(res, parseInt(deleteTaskMatch[1], 10)),
    );
    return true;
  }

  // Dispatch task: POST /api/dev-tasks/:id/dispatch
  const dispatchMatch =
    req.method === 'POST' && url.match(/^\/api\/dev-tasks\/(\d+)\/dispatch$/);
  if (dispatchMatch) {
    authGuard(req, res, token, () =>
      handleDispatchDevTask(res, parseInt(dispatchMatch[1], 10)),
    );
    return true;
  }

  // --- Pip Tasks (scheduled tasks) endpoints ---

  // List scheduled tasks: GET /api/pip-tasks
  if (
    req.method === 'GET' &&
    url.startsWith('/api/pip-tasks') &&
    !url.includes('/api/pip-tasks/')
  ) {
    authGuard(req, res, token, () => handleListPipTasks(res));
    return true;
  }

  // Get single scheduled task: GET /api/pip-tasks/:id
  const getPipTaskMatch =
    req.method === 'GET' && url.match(/^\/api\/pip-tasks\/([a-zA-Z0-9_-]+)$/);
  if (getPipTaskMatch) {
    authGuard(req, res, token, () =>
      handleGetPipTask(res, getPipTaskMatch[1]),
    );
    return true;
  }

  // Update scheduled task status: PATCH /api/pip-tasks/:id
  const patchPipTaskMatch =
    req.method === 'PATCH' && url.match(/^\/api\/pip-tasks\/([a-zA-Z0-9_-]+)$/);
  if (patchPipTaskMatch) {
    authGuard(req, res, token, () =>
      handleUpdatePipTask(req, res, patchPipTaskMatch[1]),
    );
    return true;
  }

  // Delete scheduled task: DELETE /api/pip-tasks/:id
  const deletePipTaskMatch =
    req.method === 'DELETE' && url.match(/^\/api\/pip-tasks\/([a-zA-Z0-9_-]+)$/);
  if (deletePipTaskMatch) {
    authGuard(req, res, token, () =>
      handleDeletePipTask(res, deletePipTaskMatch[1]),
    );
    return true;
  }

  return false;
}

// MARK: - Auth

function authGuard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  handler: () => void,
): void {
  const authHeader = req.headers.authorization || '';
  const reqToken = authHeader.replace('Bearer ', '');
  if (reqToken !== token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  handler();
}

// MARK: - Initiatives

function handleGetInitiatives(res: http.ServerResponse): void {
  try {
    const data = scanInitiatives();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    logger.error({ err }, 'Failed to scan initiatives');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to scan initiatives' }));
  }
}

function handleGetInitiativeFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  try {
    // URL: /api/initiatives/{status}/{slug}
    const parts = (req.url || '').replace('/api/initiatives/', '').split('/');
    if (parts.length !== 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'Expected /api/initiatives/{status}/{slug}' }),
      );
      return;
    }
    const [status, slug] = parts;
    if (!isValidStatus(status) || !isSafePathSegment(slug)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid status or slug' }));
      return;
    }
    const filePath = resolveInitiativePath(status, slug);

    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Initiative not found' }));
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(content);
  } catch (err) {
    logger.error({ err }, 'Failed to read initiative file');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read initiative' }));
  }
}

/**
 * Resolve the path to an initiative file, supporting both formats:
 * - Flat file: initiatives/{status}/{slug}.md
 * - Folder: initiatives/{status}/{slug}/initiative.md
 */
function resolveInitiativePath(status: string, slug: string): string | null {
  const folderPath = path.join(INITIATIVES_DIR, status, slug, 'initiative.md');
  if (fs.existsSync(folderPath)) return folderPath;
  const flatPath = path.join(INITIATIVES_DIR, status, `${slug}.md`);
  if (fs.existsSync(flatPath)) return flatPath;
  return null;
}

function handleCreateInitiative(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const { slug, status, content } = JSON.parse(body);
      if (!slug || !content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing slug or content' }));
        return;
      }

      const targetStatus = status || 'next';
      if (!isSafePathSegment(slug) || !isValidStatus(targetStatus)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid slug or status' }));
        return;
      }

      const dir = path.join(INITIATIVES_DIR, targetStatus);
      fs.mkdirSync(dir, { recursive: true });

      const filePath = path.join(dir, `${slug}.md`);
      fs.writeFileSync(filePath, content, 'utf-8');
      logger.info({ slug, status: targetStatus }, 'Initiative created');

      if (broadcastChange) broadcastChange('initiatives');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'created' }));
    } catch (err) {
      logger.error({ err }, 'Failed to create initiative');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create initiative' }));
    }
  });
}

function handleMoveInitiative(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const { slug, from, to } = JSON.parse(body);
      if (!slug || !from || !to) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing slug, from, or to' }));
        return;
      }
      if (
        !isSafePathSegment(slug) ||
        !isValidStatus(from) ||
        !isValidStatus(to)
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid slug, from, or to status' }));
        return;
      }

      // Support both flat files and folders
      const isFolder = fs.existsSync(
        path.join(INITIATIVES_DIR, from, slug, 'initiative.md'),
      );
      const srcPath = isFolder
        ? path.join(INITIATIVES_DIR, from, slug)
        : path.join(INITIATIVES_DIR, from, `${slug}.md`);
      const dstPath = isFolder
        ? path.join(INITIATIVES_DIR, to, slug)
        : path.join(INITIATIVES_DIR, to, `${slug}.md`);

      if (!fs.existsSync(srcPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: `Initiative ${slug} not found in ${from}` }),
        );
        return;
      }

      fs.mkdirSync(path.join(INITIATIVES_DIR, to), { recursive: true });

      // The initiative.md file for completion timestamp operations
      const initFilePath = isFolder
        ? path.join(srcPath, 'initiative.md')
        : srcPath;

      // Add completion timestamp when moving to done (prepend to file)
      if (to === 'done') {
        let fileContent = fs.readFileSync(initFilePath, 'utf-8');
        if (!/^completed:/m.test(fileContent)) {
          const today = new Date().toISOString().slice(0, 10);
          fileContent = `completed: ${today}\n${fileContent}`;
          fs.writeFileSync(initFilePath, fileContent, 'utf-8');
        }
      }

      // Remove completion timestamp when moving out of done
      if (from === 'done' && to !== 'done') {
        let fileContent = fs.readFileSync(initFilePath, 'utf-8');
        fileContent = fileContent.replace(
          /^completed:\s*\d{4}-\d{2}-\d{2}\n/,
          '',
        );
        fs.writeFileSync(initFilePath, fileContent, 'utf-8');
      }

      fs.renameSync(srcPath, dstPath);
      logger.info({ slug, from, to }, 'Initiative moved');

      // Broadcast change
      if (broadcastChange) broadcastChange('initiatives');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'moved' }));
    } catch (err) {
      logger.error({ err }, 'Failed to move initiative');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to move initiative' }));
    }
  });
}

// MARK: - Device Token Registration

function handleRegisterDeviceToken(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const { deviceId, token, environment } = JSON.parse(body);
      if (!deviceId || !token) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing deviceId or token' }));
        return;
      }

      upsertDeviceToken(deviceId, token, environment || 'production');
      logger.info(
        { deviceId, environment: environment || 'production' },
        'Device token registered',
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      logger.error({ err }, 'Failed to register device token');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to register device token' }));
    }
  });
}

// MARK: - Test Push

function handleTestPush(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', async () => {
    try {
      let title: string | undefined;
      let bodyText: string | undefined;

      if (body.trim()) {
        const parsed = JSON.parse(body);
        title = parsed.title;
        bodyText = parsed.body;
      }

      let sent: number;
      if (title && bodyText) {
        // Custom message
        sent = await sendPushToAll(title, bodyText);
      } else {
        // Default: run the daily nudge content
        const result = await runDailyNudge();
        sent = result.sent;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent }));
    } catch (err) {
      logger.error({ err }, 'Failed to send test push');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to send test push' }));
    }
  });
}

// MARK: - Calendar

async function handleGetCalendar(res: http.ServerResponse): Promise<void> {
  try {
    const events = await getThisWeekEvents();

    // Preserve the same response shape the iOS app expects
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events }));
  } catch (err) {
    logger.error({ err }, 'Failed to get calendar events');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get calendar events' }));
  }
}

// MARK: - Messages

function handleGetMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const jid = url.searchParams.get('jid');
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);

    const messages = jid
      ? getMessageHistory(jid, limit)
      : getMessageHistoryAllIos(limit);

    const cleaned = messages.map((m) => ({
      id: m.id,
      sender: m.sender_name,
      content: m.content.replace(/^@\S+\s*/, ''),
      timestamp: m.timestamp,
      isFromMe: m.is_from_me ? true : false,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: cleaned }));
  } catch (err) {
    logger.error({ err }, 'Failed to get messages');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get messages' }));
  }
}

// MARK: - File read/write (ideas-and-nits)

function handleGetFile(res: http.ServerResponse, filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(content);
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to read file');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read file' }));
  }
}

// MARK: - DevTask handlers

function handleListDevTasks(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const status = url.searchParams.get('status') || undefined;
    const filter = status ? { status: status as DevTask['status'] } : undefined;
    const tasks = listDevTasks(filter);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks }));
  } catch (err) {
    logger.error({ err }, 'Failed to list dev tasks');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to list tasks' }));
  }
}

function handleGetDevTask(res: http.ServerResponse, id: number): void {
  try {
    const task = readDevTask(id);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Task ${id} not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
  } catch (err) {
    logger.error({ err, taskId: id }, 'Failed to get dev task');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get task' }));
  }
}

function handleCreateDevTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const { title, description, source } = JSON.parse(body);
      if (!title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing title' }));
        return;
      }

      const validSources = ['fambot', 'chat', 'claude-code', 'claude'] as const;
      const resolvedSource = validSources.includes(source) ? source : 'fambot';

      const task = createDevTask({
        title,
        description: description || undefined,
        source: resolvedSource,
      });

      if (broadcastDevTasksChange) broadcastDevTasksChange();

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (err) {
      logger.error({ err }, 'Failed to create dev task');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create task' }));
    }
  });
}

function handleUpdateDevTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: number,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const raw = JSON.parse(body);
      // Runtime allowlist — strip disallowed fields and undefined values
      const allowed: Record<string, unknown> = {};
      for (const key of [
        'title',
        'description',
        'status',
        'pr_url',
        'branch',
        'session_notes',
      ]) {
        if (raw[key] !== undefined) allowed[key] = raw[key];
      }
      const task = updateDevTask(id, allowed);

      if (broadcastDevTasksChange) broadcastDevTasksChange();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (err.message?.includes('Invalid status transition')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      logger.error({ err, taskId: id }, 'Failed to update dev task');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update task' }));
    }
  });
}

function handleDeleteDevTask(res: http.ServerResponse, id: number): void {
  try {
    const deleted = deleteDevTask(id);
    if (!deleted) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Task ${id} not found` }));
      return;
    }

    if (broadcastDevTasksChange) broadcastDevTasksChange();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'deleted' }));
  } catch (err) {
    logger.error({ err, taskId: id }, 'Failed to delete dev task');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to delete task' }));
  }
}

async function handleDispatchDevTask(
  res: http.ServerResponse,
  id: number,
): Promise<void> {
  try {
    const task = await dispatchAndRun(id, {
      onProgress: () => {
        if (broadcastDevTasksChange) broadcastDevTasksChange();
      },
      onComplete: () => {
        if (broadcastDevTasksChange) broadcastDevTasksChange();
      },
    });

    if (broadcastDevTasksChange) broadcastDevTasksChange();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'dispatched', task }));
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    if (
      err.message?.includes('must be') ||
      err.message?.includes('already being') ||
      err.message?.includes('Maximum concurrent')
    ) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    logger.error({ err, taskId: id }, 'Failed to dispatch dev task');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to dispatch task' }));
  }
}

// MARK: - Pip Tasks (Scheduled Tasks)

function handleListPipTasks(res: http.ServerResponse): void {
  try {
    const tasks = getAllScheduledTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks }));
  } catch (err) {
    logger.error({ err }, 'Failed to list pip tasks');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to list tasks' }));
  }
}

function handleGetPipTask(res: http.ServerResponse, id: string): void {
  try {
    const task = getScheduledTaskById(id);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Task ${id} not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
  } catch (err) {
    logger.error({ err, taskId: id }, 'Failed to get pip task');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get task' }));
  }
}

function handleUpdatePipTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const task = getScheduledTaskById(id);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Task ${id} not found` }));
        return;
      }

      const raw = JSON.parse(body);
      // Only allow status updates (pause/resume)
      const validStatuses = ['active', 'paused'] as const;
      if (!raw.status || !(validStatuses as readonly string[]).includes(raw.status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing status. Must be "active" or "paused".' }));
        return;
      }

      updateScheduledTask(id, { status: raw.status });

      if (broadcastScheduledTasksChange) broadcastScheduledTasksChange();

      const updated = getScheduledTaskById(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (err) {
      logger.error({ err, taskId: id }, 'Failed to update pip task');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update task' }));
    }
  });
}

function handleDeletePipTask(res: http.ServerResponse, id: string): void {
  try {
    const task = getScheduledTaskById(id);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Task ${id} not found` }));
      return;
    }

    deleteScheduledTask(id);

    if (broadcastScheduledTasksChange) broadcastScheduledTasksChange();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'deleted' }));
  } catch (err) {
    logger.error({ err, taskId: id }, 'Failed to delete pip task');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to delete task' }));
  }
}

function handlePutFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  fileType: string,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      fs.writeFileSync(filePath, body, 'utf-8');
      logger.info({ fileType }, 'File updated via API');

      if (broadcastChange) broadcastChange(fileType);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'saved' }));
    } catch (err) {
      logger.error({ err, fileType }, 'Failed to write file');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to write file' }));
    }
  });
}
