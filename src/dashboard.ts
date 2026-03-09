/**
 * Dashboard HTTP server for NanoClaw.
 * Serves a web UI on localhost and provides JSON API endpoints.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import {
  getAllChats,
  getAllTasks,
  getAllRegisteredGroups,
  getAllSessions,
} from './db.js';
import { logger } from './logger.js';

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3456', 10);

interface DashboardDeps {
  getActiveContainers: () => Array<{
    group: string;
    containerName: string;
    startedAt: number;
  }>;
}

let deps: DashboardDeps;

function jsonResponse(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function errorResponse(
  res: http.ServerResponse,
  msg: string,
  status = 500,
): void {
  jsonResponse(res, { error: msg }, status);
}

/** Open the companies.db for a group (read-only). */
function openCompaniesDb(groupFolder: string): Database.Database | null {
  const dbPath = path.join(GROUPS_DIR, groupFolder, 'companies.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

// --- API Handlers ---

function handleOverview(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const groups = getAllRegisteredGroups();
  const tasks = getAllTasks();
  const sessions = getAllSessions();
  const chats = getAllChats();
  const active = deps.getActiveContainers();

  // Count messages today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const storeDb = new Database(path.join(STORE_DIR, 'messages.db'), {
    readonly: true,
  });
  const msgCount = storeDb
    .prepare(`SELECT COUNT(*) as count FROM messages WHERE timestamp >= ?`)
    .get(todayStart.toISOString()) as { count: number };
  const totalMessages = storeDb
    .prepare(`SELECT COUNT(*) as count FROM messages`)
    .get() as { count: number };
  storeDb.close();

  jsonResponse(res, {
    assistantName: ASSISTANT_NAME,
    groupCount: Object.keys(groups).length,
    groups: Object.entries(groups).map(([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      isMain: g.isMain,
      requiresTrigger: g.requiresTrigger,
    })),
    activeTasks: tasks.filter((t) => t.status === 'active').length,
    totalTasks: tasks.length,
    sessionCount: Object.keys(sessions).length,
    chatCount: chats.filter((c) => c.jid !== '__group_sync__').length,
    messagesToday: msgCount.count,
    totalMessages: totalMessages.count,
    activeContainers: active,
    timezone:
      process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    uptime: process.uptime(),
  });
}

function handleMessages(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const chatJid = url.searchParams.get('chat') || null;

  const storeDb = new Database(path.join(STORE_DIR, 'messages.db'), {
    readonly: true,
  });

  let rows;
  if (chatJid) {
    rows = storeDb
      .prepare(
        `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
       FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      )
      .all(chatJid, limit, offset);
  } else {
    rows = storeDb
      .prepare(
        `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
       FROM messages ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
  }
  storeDb.close();

  jsonResponse(res, { messages: rows, limit, offset });
}

function handleTasks(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const tasks = getAllTasks();

  // Get recent run logs
  const storeDb = new Database(path.join(STORE_DIR, 'messages.db'), {
    readonly: true,
  });
  const recentRuns = storeDb
    .prepare(
      `SELECT task_id, run_at, duration_ms, status, error
     FROM task_run_logs ORDER BY run_at DESC LIMIT 50`,
    )
    .all();
  storeDb.close();

  jsonResponse(res, { tasks, recentRuns });
}

function handleCompanies(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const groupFolder = url.searchParams.get('group') || 'main';
  const db = openCompaniesDb(groupFolder);
  if (!db) {
    jsonResponse(res, {
      companies: [],
      watchlists: [],
      tasks: [],
      message: 'No companies database found',
    });
    return;
  }

  try {
    // Check which tables exist
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    const companies = tableNames.includes('companies')
      ? db
          .prepare(
            `
          SELECT c.*, GROUP_CONCAT(w.name, ', ') as watchlists
          FROM companies c
          LEFT JOIN company_watchlists cw ON c.id = cw.company_id
          LEFT JOIN watchlists w ON cw.watchlist_id = w.id
          GROUP BY c.id ORDER BY c.name
        `,
          )
          .all()
      : [];

    const watchlists = tableNames.includes('watchlists')
      ? db.prepare(`SELECT * FROM watchlists ORDER BY name`).all()
      : [];

    const companyTasks = tableNames.includes('tasks')
      ? db
          .prepare(
            `
          SELECT t.*, c.name as company_name
          FROM tasks t LEFT JOIN companies c ON t.company_id = c.id
          ORDER BY t.completed ASC, t.due_date ASC
        `,
          )
          .all()
      : [];

    const attachments = tableNames.includes('attachments')
      ? db
          .prepare(
            `
          SELECT a.*, c.name as company_name
          FROM attachments a JOIN companies c ON a.company_id = c.id
          ORDER BY a.created_at DESC LIMIT 100
        `,
          )
          .all()
      : [];

    jsonResponse(res, {
      companies,
      watchlists,
      tasks: companyTasks,
      attachments,
    });
  } finally {
    db.close();
  }
}

function handleFiles(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const requestedPath = url.searchParams.get('path') || '';
  const projectRoot = process.cwd();

  // Allowlist of readable paths (relative to project root)
  const allowedPrefixes = ['groups/', 'CLAUDE.md', 'container/skills/'];
  const normalized = path.normalize(requestedPath);
  if (
    normalized.includes('..') ||
    !allowedPrefixes.some((p) => normalized.startsWith(p))
  ) {
    errorResponse(res, 'Path not allowed', 403);
    return;
  }

  const fullPath = path.join(projectRoot, normalized);

  if (!fs.existsSync(fullPath)) {
    errorResponse(res, 'File not found', 404);
    return;
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    // List directory contents
    const entries = fs.readdirSync(fullPath).map((name) => {
      const entryPath = path.join(fullPath, name);
      const entryStat = fs.statSync(entryPath);
      return {
        name,
        path: path.join(normalized, name),
        isDirectory: entryStat.isDirectory(),
        size: entryStat.size,
        modified: entryStat.mtime.toISOString(),
      };
    });
    jsonResponse(res, { type: 'directory', path: normalized, entries });
    return;
  }

  // Read file (max 1MB)
  if (stat.size > 1024 * 1024) {
    errorResponse(res, 'File too large', 413);
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  jsonResponse(res, {
    type: 'file',
    path: normalized,
    content,
    size: stat.size,
  });
}

function handleLogs(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const groupFolder = url.searchParams.get('group') || 'main';
  const logsDir = path.join(GROUPS_DIR, groupFolder, 'logs');

  if (!fs.existsSync(logsDir)) {
    jsonResponse(res, { logs: [] });
    return;
  }

  const files = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, 20);

  const logs = files.map((f) => {
    const content = fs.readFileSync(path.join(logsDir, f), 'utf-8');
    // Parse key fields from the log header
    const lines = content.split('\n');
    const fields: Record<string, string> = {};
    for (const line of lines.slice(0, 10)) {
      const match = line.match(/^(\w[\w\s]+):\s*(.+)$/);
      if (match) fields[match[1].trim()] = match[2].trim();
    }
    return { filename: f, ...fields, preview: content.slice(0, 500) };
  });

  jsonResponse(res, { logs });
}

function handleFileTree(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const projectRoot = process.cwd();

  // Build a tree of important files
  const tree: Array<{ path: string; name: string; type: string }> = [];

  // Project CLAUDE.md
  if (fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))) {
    tree.push({ path: 'CLAUDE.md', name: 'CLAUDE.md (Project)', type: 'file' });
  }

  // Group folders
  if (fs.existsSync(GROUPS_DIR)) {
    for (const group of fs.readdirSync(GROUPS_DIR)) {
      const groupDir = path.join(GROUPS_DIR, group);
      if (!fs.statSync(groupDir).isDirectory()) continue;
      tree.push({ path: `groups/${group}`, name: group, type: 'group' });

      for (const file of fs.readdirSync(groupDir)) {
        const filePath = path.join(groupDir, file);
        if (fs.statSync(filePath).isFile() && !file.endsWith('.db')) {
          tree.push({
            path: `groups/${group}/${file}`,
            name: file,
            type: 'file',
          });
        }
      }
    }
  }

  // Container skills
  const skillsDir = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const skill of fs.readdirSync(skillsDir)) {
      const skillDir = path.join(skillsDir, skill);
      if (fs.statSync(skillDir).isDirectory()) {
        tree.push({
          path: `container/skills/${skill}`,
          name: `skill: ${skill}`,
          type: 'skill',
        });
      }
    }
  }

  jsonResponse(res, { tree });
}

function handleTrace(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  const groupFolder = url.searchParams.get('group') || 'main';
  const sessionsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );

  if (!fs.existsSync(sessionsDir)) {
    jsonResponse(res, { entries: [], error: 'No sessions directory found' });
    return;
  }

  // Find the most recent session transcript (or a specific one)
  const sessionId = url.searchParams.get('session') || null;
  let targetFile: string | null = null;

  if (sessionId) {
    const candidate = path.join(sessionsDir, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) targetFile = candidate;
  } else {
    // Find most recently modified .jsonl
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({
        name: f,
        mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) targetFile = path.join(sessionsDir, files[0].name);
  }

  if (!targetFile) {
    jsonResponse(res, { entries: [], error: 'No session transcripts found' });
    return;
  }

  const sessionName = path.basename(targetFile, '.jsonl');
  const raw = fs.readFileSync(targetFile, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());

  // Parse JSONL entries into a simplified trace
  interface TraceEntry {
    type: string;
    timestamp?: string;
    role?: string;
    model?: string;
    text?: string;
    toolName?: string;
    toolInput?: string;
    toolResult?: string;
    stopReason?: string;
  }
  const entries: TraceEntry[] = [];

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      const t = d.type;

      if (t === 'user') {
        const content = d.message?.content;
        const text =
          typeof content === 'string' ? content : JSON.stringify(content);
        entries.push({
          type: 'user',
          timestamp: d.timestamp,
          text: text?.slice(0, 5000),
        });
      } else if (t === 'assistant') {
        const msg = d.message;
        if (!msg?.content) continue;
        const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
        for (const block of blocks) {
          if (typeof block === 'string') {
            entries.push({
              type: 'assistant_text',
              model: msg.model,
              text: block.slice(0, 5000),
              stopReason: msg.stop_reason,
            });
          } else if (block.type === 'text') {
            entries.push({
              type: 'assistant_text',
              model: msg.model,
              text: block.text?.slice(0, 5000),
              stopReason: msg.stop_reason,
            });
          } else if (block.type === 'tool_use') {
            const input =
              typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input, null, 2);
            entries.push({
              type: 'tool_use',
              toolName: block.name,
              toolInput: input?.slice(0, 10000),
            });
          } else if (block.type === 'tool_result') {
            const content = Array.isArray(block.content)
              ? block.content
                  .map((c: { text?: string }) => c.text || '')
                  .join('\n')
              : typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
            entries.push({
              type: 'tool_result',
              toolName: block.tool_use_id,
              toolResult: content?.slice(0, 10000),
            });
          }
        }
      } else if (t === 'progress') {
        const pd = d.data;
        if (pd?.type === 'mcp_progress') {
          entries.push({
            type: 'mcp_progress',
            toolName: `${pd.serverName}.${pd.toolName}`,
            text: pd.status + (pd.elapsed_ms ? ` (${pd.elapsed_ms}ms)` : ''),
          });
        }
      }
    } catch {
      // skip unparseable lines
    }
  }

  // List available sessions
  const availableSessions = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      id: f.replace('.jsonl', ''),
      modified: fs.statSync(path.join(sessionsDir, f)).mtime.toISOString(),
      size: fs.statSync(path.join(sessionsDir, f)).size,
    }))
    .sort((a, b) => b.modified.localeCompare(a.modified));

  jsonResponse(res, { sessionId: sessionName, entries, availableSessions });
}

// --- Server ---

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url || '/', `http://localhost:${DASHBOARD_PORT}`);
  const pathname = url.pathname;

  // API routes
  if (pathname === '/api/overview') return handleOverview(req, res);
  if (pathname === '/api/messages') return handleMessages(req, res, url);
  if (pathname === '/api/tasks') return handleTasks(req, res);
  if (pathname === '/api/companies') return handleCompanies(req, res, url);
  if (pathname === '/api/files') return handleFiles(req, res, url);
  if (pathname === '/api/file-tree') return handleFileTree(req, res);
  if (pathname === '/api/logs') return handleLogs(req, res, url);
  if (pathname === '/api/trace') return handleTrace(req, res, url);

  // Serve static files from public/
  const publicDir = path.join(process.cwd(), 'public');
  let filePath = path.join(
    publicDir,
    pathname === '/' ? 'index.html' : pathname,
  );

  // Security: prevent path traversal
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath)) {
    // SPA fallback
    filePath = path.join(publicDir, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
  res.end(content);
}

export function startDashboard(d: DashboardDeps): void {
  deps = d;
  const server = http.createServer(handleRequest);

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard running');
    console.log(`  Dashboard: http://localhost:${DASHBOARD_PORT}\n`);
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Dashboard server error');
  });
}
