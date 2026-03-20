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
import { getMessageHistory, getMessageHistoryAllIos, upsertDeviceToken } from '../db.js';
import { runDailyNudge } from '../daily-nudge.js';
import { sendPushToAll } from '../apns.js';

const SIGMA_DATA = path.join(process.env.HOME || '/Users/fambot', 'sigma-data');
const SIGMA_REPO = path.join(process.env.HOME || '/Users/fambot', 'Projects', 'Sigma');
const SCHEDULES_DIR = path.join(SIGMA_DATA, 'family', 'schedules');
const INITIATIVES_DIR = path.join(SIGMA_REPO, 'initiatives');
const IDEAS_NITS_FILE = path.join(SIGMA_REPO, 'ideas-and-nits.md');

const STATUSES = ['doing', 'next', 'later', 'done', 'cancelled'] as const;

// Module-level broadcast callback
let broadcastChange: ((fileType: string) => void) | null = null;

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
            logger.info({ file: entry.name }, 'Initiative file changed, broadcasting update');
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
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

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
        const completedMatch = content.match(/^completed:\s*(\d{4}-\d{2}-\d{2})/m);
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
function parseSteps(content: string): { title: string; isDone: boolean; phase: string | null }[] {
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
    authGuard(req, res, token, () => handlePutFile(req, res, IDEAS_NITS_FILE, 'ideas-and-nits'));
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

function handleGetInitiativeFile(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    // URL: /api/initiatives/{status}/{slug}
    const parts = (req.url || '').replace('/api/initiatives/', '').split('/');
    if (parts.length !== 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected /api/initiatives/{status}/{slug}' }));
      return;
    }
    const [status, slug] = parts;
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

function handleMoveInitiative(req: http.IncomingMessage, res: http.ServerResponse): void {
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

      // Support both flat files and folders
      const isFolder = fs.existsSync(path.join(INITIATIVES_DIR, from, slug, 'initiative.md'));
      const srcPath = isFolder
        ? path.join(INITIATIVES_DIR, from, slug)
        : path.join(INITIATIVES_DIR, from, `${slug}.md`);
      const dstPath = isFolder
        ? path.join(INITIATIVES_DIR, to, slug)
        : path.join(INITIATIVES_DIR, to, `${slug}.md`);

      if (!fs.existsSync(srcPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Initiative ${slug} not found in ${from}` }));
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
        fileContent = fileContent.replace(/^completed:\s*\d{4}-\d{2}-\d{2}\n/, '');
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

function handleRegisterDeviceToken(req: http.IncomingMessage, res: http.ServerResponse): void {
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
      logger.info({ deviceId, environment: environment || 'production' }, 'Device token registered');

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

function handleTestPush(req: http.IncomingMessage, res: http.ServerResponse): void {
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

interface CalendarEvent {
  id: string;
  summary: string;
  startDate: string;
  endDate: string | null;
  isAllDay: boolean;
  description: string | null;
}

function handleGetCalendar(res: http.ServerResponse): void {
  try {
    const files = fs.readdirSync(SCHEDULES_DIR).filter((f) => f.endsWith('.ics'));
    const allEvents: CalendarEvent[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(SCHEDULES_DIR, file), 'utf-8');
      const events = parseICS(content);
      allEvents.push(...events);
      logger.debug({ file, count: events.length }, 'Parsed ICS file');
    }

    allEvents.sort((a, b) => a.startDate.localeCompare(b.startDate));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: allEvents }));
  } catch (err) {
    logger.error({ err }, 'Failed to read calendar');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read calendar' }));
  }
}

function parseICS(content: string): CalendarEvent[] {
  const unfolded = content
    .replace(/\r\n /g, '')
    .replace(/\r\n\t/g, '')
    .replace(/\n /g, '')
    .replace(/\n\t/g, '');

  const lines = unfolded.split(/\r?\n/);
  const events: CalendarEvent[] = [];

  let inEvent = false;
  let uid = '';
  let summary = '';
  let dtstart = '';
  let dtend = '';
  let description: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      uid = '';
      summary = '';
      dtstart = '';
      dtend = '';
      description = null;
      continue;
    }

    if (trimmed === 'END:VEVENT') {
      inEvent = false;
      const start = parseICSDate(dtstart);
      if (start) {
        const isAllDay = dtstart.includes('VALUE=DATE');
        const end = parseICSDate(dtend);

        events.push({
          id: uid || `gen-${Date.now()}-${Math.random()}`,
          summary: summary.replace(/\\,/g, ',').replace(/\\;/g, ';'),
          startDate: start.toISOString(),
          endDate: end ? end.toISOString() : null,
          isAllDay,
          description: description
            ? description.replace(/\\n/g, '\n').replace(/\\,/g, ',').trim()
            : null,
        });
      }
      continue;
    }

    if (!inEvent) continue;

    if (trimmed.startsWith('UID:')) uid = trimmed.slice(4);
    else if (trimmed.startsWith('SUMMARY:')) summary = trimmed.slice(8);
    else if (trimmed.startsWith('DTSTART')) dtstart = trimmed;
    else if (trimmed.startsWith('DTEND')) dtend = trimmed;
    else if (trimmed.startsWith('DESCRIPTION:')) description = trimmed.slice(12);
  }

  return events;
}

function parseICSDate(raw: string): Date | null {
  if (!raw) return null;

  const colonIdx = raw.lastIndexOf(':');
  if (colonIdx === -1) return null;
  const value = raw.slice(colonIdx + 1);

  if (raw.includes('VALUE=DATE')) {
    const y = parseInt(value.slice(0, 4));
    const m = parseInt(value.slice(4, 6)) - 1;
    const d = parseInt(value.slice(6, 8));
    return new Date(y, m, d);
  } else if (value.endsWith('Z')) {
    const y = parseInt(value.slice(0, 4));
    const m = parseInt(value.slice(4, 6)) - 1;
    const d = parseInt(value.slice(6, 8));
    const h = parseInt(value.slice(9, 11));
    const min = parseInt(value.slice(11, 13));
    const s = parseInt(value.slice(13, 15));
    return new Date(Date.UTC(y, m, d, h, min, s));
  } else {
    const y = parseInt(value.slice(0, 4));
    const m = parseInt(value.slice(4, 6)) - 1;
    const d = parseInt(value.slice(6, 8));
    const h = parseInt(value.slice(9, 11));
    const min = parseInt(value.slice(11, 13));
    const s = parseInt(value.slice(13, 15));
    return new Date(y, m, d, h, min, s);
  }
}

// MARK: - Messages

function handleGetMessages(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const jid = url.searchParams.get('jid');
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);

    const messages = jid ? getMessageHistory(jid, limit) : getMessageHistoryAllIos(limit);

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
