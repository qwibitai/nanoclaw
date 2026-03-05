#!/usr/bin/env node

import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = 'true';
    }
  }
  return flags;
}

function resolveRoot(baseDirFlag) {
  if (baseDirFlag) return resolve(baseDirFlag);

  const homieRoot = resolve(__dirname, '..');
  if (existsSync(join(homieRoot, 'mission-control'))) return homieRoot;

  const cwd = process.cwd();
  if (existsSync(join(cwd, 'mission-control'))) return cwd;

  return cwd;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const [, fmRaw, body] = match;
  const frontmatter = {};
  for (const line of fmRaw.split('\n')) {
    if (!line || line.startsWith(' ') || line.startsWith('-')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    frontmatter[key] = parseScalar(line.slice(idx + 1));
  }
  return { frontmatter, body };
}

function safeReadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseTask(path) {
  const raw = readFileSync(path, 'utf8');
  const { frontmatter } = parseFrontmatter(raw);
  return {
    id: String(frontmatter.id ?? ''),
    title: String(frontmatter.title ?? ''),
    status: String(frontmatter.status ?? 'backlog'),
    priority: String(frontmatter.priority ?? 'P2'),
    worker_type: String(frontmatter.worker_type ?? 'ops'),
    initiative: frontmatter.initiative == null || frontmatter.initiative === '' ? null : String(frontmatter.initiative),
    description: frontmatter.description ? String(frontmatter.description) : '',
    outputs: Array.isArray(frontmatter.outputs) ? frontmatter.outputs : [],
    depends_on: Array.isArray(frontmatter.depends_on) ? frontmatter.depends_on : [],
    retry_count: Number(frontmatter.retry_count ?? 0),
    blocked_reason: frontmatter.blocked_reason == null || frontmatter.blocked_reason === '' ? null : String(frontmatter.blocked_reason),
    failure_reason: frontmatter.failure_reason == null || frontmatter.failure_reason === '' ? null : String(frontmatter.failure_reason),
    cancellation_reason: frontmatter.cancellation_reason == null || frontmatter.cancellation_reason === '' ? null : String(frontmatter.cancellation_reason),
    created_at: frontmatter.created_at ? String(frontmatter.created_at) : null,
    started_at: frontmatter.started_at ? String(frontmatter.started_at) : null,
    completed_at: frontmatter.completed_at ? String(frontmatter.completed_at) : null,
    updated_at: frontmatter.updated_at ? String(frontmatter.updated_at) : null,
    due: frontmatter.due ? String(frontmatter.due) : null,
  };
}

function parseInitiative(path) {
  const raw = readFileSync(path, 'utf8');
  const { frontmatter } = parseFrontmatter(raw);
  return {
    id: String(frontmatter.id ?? ''),
    title: String(frontmatter.title ?? ''),
    status: String(frontmatter.status ?? 'active'),
    objective: String(frontmatter.objective ?? 'other'),
    goal: String(frontmatter.goal ?? ''),
    timeframe: String(frontmatter.timeframe ?? ''),
    tasks: Array.isArray(frontmatter.tasks) ? frontmatter.tasks : [],
    created_at: frontmatter.created_at ? String(frontmatter.created_at) : null,
    updated_at: frontmatter.updated_at ? String(frontmatter.updated_at) : null,
  };
}

function readTasks(root) {
  const dir = join(root, 'mission-control', 'tasks');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      try {
        return parseTask(join(dir, name));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
}

function readInitiatives(root) {
  const dir = join(root, 'mission-control', 'initiatives');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      try {
        return parseInitiative(join(dir, name));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
}

function readLock(root) {
  return safeReadJson(join(root, 'mission-control', 'lock.json'), { locked: false });
}

function readActivity(root, limit = 200) {
  const path = join(root, 'mission-control', 'activity.log.ndjson');
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(limit, 5000)));

  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines.
    }
  }
  return events.reverse();
}

function buildSummary(tasks, initiatives, lock) {
  const statusCounts = {};
  const priorityCounts = {};

  for (const task of tasks) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
    priorityCounts[task.priority] = (priorityCounts[task.priority] ?? 0) + 1;
  }

  return {
    tasks_total: tasks.length,
    initiatives_total: initiatives.length,
    lock,
    status_counts: statusCounts,
    priority_counts: priorityCounts,
    ready_tasks: tasks.filter((task) => task.status === 'ready').length,
    blocked_tasks: tasks.filter((task) => task.status === 'blocked').length,
    in_progress_tasks: tasks.filter((task) => task.status === 'in_progress').length,
  };
}

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function text(res, code, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': contentType });
  res.end(body);
}

function escapeHtml(raw) {
  return String(raw)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function dashboardHtml(baseDir, mcPath) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mission Control</title>
    <style>
      :root {
        --bg: #0d1117;
        --surface: #161b22;
        --card: #1c2333;
        --text: #e6edf3;
        --muted: #8b949e;
        --border: #30363d;
        --ok: #3fb950;
        --warn: #d29922;
        --danger: #f85149;
        --accent: #388bfd;
        --col-radius: 8px;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        color: var(--text);
        background: var(--bg);
        padding: 16px 24px;
      }

      /* Header */
      .header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 16px;
      }
      .header-left h1 {
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .header-left .status {
        font-size: 13px;
        font-weight: 600;
        margin-top: 2px;
      }
      .header-left .status .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 5px;
        vertical-align: middle;
      }
      .header-left .status.active { color: var(--ok); }
      .header-left .status.active .dot { background: var(--ok); }
      .header-left .status.locked { color: var(--danger); }
      .header-left .status.locked .dot { background: var(--danger); }
      .header-right {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .worker-status {
        color: var(--muted);
        font-size: 13px;
      }
      .btn-emergency {
        background: transparent;
        color: var(--danger);
        border: 2px solid var(--danger);
        border-radius: 6px;
        padding: 6px 16px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        letter-spacing: 0.3px;
      }
      .btn-emergency:hover { background: rgba(248,81,73,0.15); }

      /* Tabs */
      .tabs {
        display: flex;
        gap: 0;
        border-bottom: 1px solid var(--border);
        margin-bottom: 8px;
      }
      .tab {
        padding: 8px 16px;
        font-size: 14px;
        color: var(--muted);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
        background: none;
        border-top: none;
        border-left: none;
        border-right: none;
        font-family: inherit;
      }
      .tab:hover { color: var(--text); }
      .tab.active {
        color: var(--text);
        border-bottom-color: var(--text);
        font-weight: 600;
      }

      /* Toolbar */
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .toolbar-label {
        font-size: 13px;
        color: var(--muted);
      }
      .btn-new-task {
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 6px 14px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn-new-task:hover { background: #4d9eff; }

      /* Kanban board */
      .board {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 10px;
        margin-bottom: 16px;
      }
      .column {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--col-radius);
        min-height: 180px;
        display: flex;
        flex-direction: column;
      }
      .column-header {
        padding: 10px 12px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.3px;
        text-transform: uppercase;
        color: var(--text);
      }
      .column-body {
        flex: 1;
        padding: 4px 10px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .task-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 10px;
        font-size: 12px;
      }
      .task-card .task-title {
        font-weight: 600;
        margin-bottom: 3px;
      }
      .task-card .task-meta {
        color: var(--muted);
        font-size: 11px;
      }

      /* Initiatives view */
      .initiatives-view { display: none; }
      .initiatives-view.active { display: block; }
      .tasks-view.active { display: block; }
      .tasks-view { display: none; }
      .initiative-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--col-radius);
        padding: 12px 14px;
        margin-bottom: 8px;
      }
      .initiative-card .init-title {
        font-weight: 700;
        font-size: 14px;
        margin-bottom: 4px;
      }
      .initiative-card .init-meta {
        color: var(--muted);
        font-size: 12px;
      }
      .initiative-card .init-goal {
        font-size: 13px;
        margin-top: 6px;
        color: var(--text);
        opacity: 0.85;
      }

      /* Activity feed */
      .activity-section {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--col-radius);
      }
      .activity-header {
        padding: 10px 14px;
        font-size: 14px;
        font-weight: 700;
      }
      .activity-body {
        padding: 6px 14px 14px;
      }
      .activity-row {
        display: flex;
        gap: 12px;
        padding: 5px 0;
        font-size: 12px;
        border-bottom: 1px solid var(--border);
      }
      .activity-row:last-child { border-bottom: none; }
      .activity-time { color: var(--muted); white-space: nowrap; min-width: 140px; }
      .activity-event { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--accent); min-width: 140px; }
      .activity-target { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--muted); min-width: 120px; }
      .activity-detail { color: var(--text); opacity: 0.8; }

      /* Detail sidebar */
      .sidebar-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.5);
        z-index: 99;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s;
      }
      .sidebar-overlay.open { opacity: 1; pointer-events: auto; }
      .sidebar {
        position: fixed;
        top: 0;
        right: 0;
        width: 420px;
        max-width: 90vw;
        height: 100vh;
        background: var(--surface);
        border-left: 1px solid var(--border);
        z-index: 100;
        transform: translateX(100%);
        transition: transform 0.25s ease;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .sidebar.open { transform: translateX(0); }
      .sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }
      .sidebar-header h2 {
        font-size: 15px;
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sidebar-close {
        background: none;
        border: none;
        color: var(--muted);
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      .sidebar-close:hover { color: var(--text); }
      .sidebar-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px;
      }
      .detail-section {
        margin-bottom: 16px;
      }
      .detail-section-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--muted);
        margin-bottom: 6px;
      }
      .detail-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .detail-field {
        background: var(--card);
        border-radius: 6px;
        padding: 8px 10px;
      }
      .detail-field.full { grid-column: 1 / -1; }
      .detail-field-label {
        font-size: 11px;
        color: var(--muted);
        margin-bottom: 2px;
      }
      .detail-field-value {
        font-size: 13px;
        word-break: break-word;
      }
      .detail-field-value.mono {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
      }
      .badge-status { background: rgba(56,139,253,0.15); color: var(--accent); }
      .badge-priority { background: rgba(210,153,34,0.15); color: var(--warn); }
      .badge-ok { background: rgba(63,185,80,0.15); color: var(--ok); }
      .badge-danger { background: rgba(248,81,73,0.15); color: var(--danger); }
      .task-card, .initiative-card { cursor: pointer; transition: border-color 0.15s; }
      .task-card:hover, .initiative-card:hover { border-color: var(--accent); }

      @media (max-width: 900px) {
        .board { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 500px) {
        .board { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="header-left">
        <h1>Mission Control</h1>
        <div id="system-status" class="status active"><span class="dot"></span>ACTIVE</div>
      </div>
      <div class="header-right">
        <span id="worker-status" class="worker-status">No active worker</span>
        <button class="btn-emergency" id="btn-estop">&#9632; EMERGENCY STOP</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-view="tasks">Tasks</button>
      <button class="tab" data-view="initiatives">Initiatives</button>
    </div>

    <div class="tasks-view active" id="tasks-view">
      <div class="toolbar">
        <span class="toolbar-label">Live board and feed</span>
        <button class="btn-new-task" id="btn-new-task">+ New Task</button>
      </div>

      <div class="board" id="board">
        <div class="column">
          <div class="column-header" id="col-backlog">BACKLOG (0)</div>
          <div class="column-body" id="col-backlog-body"></div>
        </div>
        <div class="column">
          <div class="column-header" id="col-ready">READY (0)</div>
          <div class="column-body" id="col-ready-body"></div>
        </div>
        <div class="column">
          <div class="column-header" id="col-in_progress">IN PROGRESS (0)</div>
          <div class="column-body" id="col-in_progress-body"></div>
        </div>
        <div class="column">
          <div class="column-header" id="col-blocked">BLOCKED (0)</div>
          <div class="column-body" id="col-blocked-body"></div>
        </div>
        <div class="column">
          <div class="column-header" id="col-done">DONE / VERIFIED (0)</div>
          <div class="column-body" id="col-done-body"></div>
        </div>
      </div>
    </div>

    <div class="initiatives-view" id="initiatives-view"></div>

    <div class="activity-section">
      <div class="activity-header">Activity Feed</div>
      <div class="activity-body" id="activity"></div>
    </div>

    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <div class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h2 id="sidebar-title">Details</h2>
        <button class="sidebar-close" id="sidebar-close">&times;</button>
      </div>
      <div class="sidebar-body" id="sidebar-body"></div>
    </div>

    <script>
      const STATUS_COLUMNS = {
        backlog: 'backlog',
        ready: 'ready',
        in_progress: 'in_progress',
        blocked: 'blocked',
        done: 'done',
        verified: 'done',
        failed: 'blocked',
        cancelled: 'done',
      };

      const COLUMN_LABELS = {
        backlog: 'BACKLOG',
        ready: 'READY',
        in_progress: 'IN PROGRESS',
        blocked: 'BLOCKED',
        done: 'DONE / VERIFIED',
      };

      async function fetchJson(path) {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) throw new Error(path + ' -> ' + response.status);
        return response.json();
      }

      function fmtDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
      }

      function fmtShortDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        if (isToday) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }

      function renderTaskCard(task) {
        return '<div class="task-card" data-type="task" data-id="' + task.id + '">' +
          '<div class="task-title">' + task.title + '</div>' +
          '<div class="task-meta">' + task.id + (task.priority ? ' &middot; ' + task.priority : '') + (task.initiative ? ' &middot; ' + task.initiative : '') + '</div>' +
        '</div>';
      }

      async function refresh() {
        const [summary, tasks, initiatives, lock, activity] = await Promise.all([
          fetchJson('/api/summary'),
          fetchJson('/api/tasks'),
          fetchJson('/api/initiatives'),
          fetchJson('/api/lock'),
          fetchJson('/api/activity?limit=25'),
        ]);

        // System status
        const statusEl = document.getElementById('system-status');
        if (lock && lock.locked) {
          statusEl.className = 'status locked';
          statusEl.innerHTML = '<span class="dot"></span>LOCKED';
        } else {
          statusEl.className = 'status active';
          statusEl.innerHTML = '<span class="dot"></span>ACTIVE';
        }

        // Worker status
        const workerEl = document.getElementById('worker-status');
        if (lock && lock.locked) {
          workerEl.textContent = 'Worker: ' + (lock.owner || 'unknown') + ' on ' + (lock.task_id || '?');
        } else {
          workerEl.textContent = 'No active worker';
        }

        // Kanban columns
        const buckets = { backlog: [], ready: [], in_progress: [], blocked: [], done: [] };
        for (const task of tasks) {
          const col = STATUS_COLUMNS[task.status] || 'backlog';
          buckets[col].push(task);
        }
        for (const [key, label] of Object.entries(COLUMN_LABELS)) {
          document.getElementById('col-' + key).textContent = label + ' (' + buckets[key].length + ')';
          document.getElementById('col-' + key + '-body').innerHTML = buckets[key].map(renderTaskCard).join('');
        }

        // Initiatives view
        document.getElementById('initiatives-view').innerHTML = initiatives.length === 0
          ? '<div style="color:var(--muted);padding:16px;font-size:13px;">No initiatives found.</div>'
          : initiatives.map(function(init) {
              const taskCount = init.tasks ? init.tasks.length : 0;
              return '<div class="initiative-card" data-type="initiative" data-id="' + init.id + '">' +
                '<div class="init-title">' + init.title + ' <span style="color:var(--muted);font-weight:400;font-size:12px;">' + init.status + '</span></div>' +
                '<div class="init-meta">' + init.id + ' &middot; ' + init.objective + (init.timeframe ? ' &middot; ' + init.timeframe : '') + ' &middot; ' + taskCount + ' tasks</div>' +
                (init.goal ? '<div class="init-goal">' + init.goal + '</div>' : '') +
              '</div>';
            }).join('');

        // Activity feed
        document.getElementById('activity').innerHTML = activity.length === 0
          ? '<div style="color:var(--muted);font-size:13px;padding:8px 0;">No activity yet.</div>'
          : activity.map(function(event) {
              return '<div class="activity-row">' +
                '<span class="activity-time">' + fmtShortDate(event.ts) + '</span>' +
                '<span class="activity-event">' + (event.event || '') + '</span>' +
                '<span class="activity-target">' + (event.task_id || event.initiative_id || '') + '</span>' +
                '<span class="activity-detail">' + (event.detail || '') + '</span>' +
              '</div>';
            }).join('');
      }

      // Tab switching
      document.querySelectorAll('.tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
          tab.classList.add('active');
          const view = tab.getAttribute('data-view');
          document.getElementById('tasks-view').classList.toggle('active', view === 'tasks');
          document.getElementById('initiatives-view').classList.toggle('active', view === 'initiatives');
        });
      });

      // Sidebar logic
      var sidebarEl = document.getElementById('sidebar');
      var overlayEl = document.getElementById('sidebar-overlay');
      var sidebarTitleEl = document.getElementById('sidebar-title');
      var sidebarBodyEl = document.getElementById('sidebar-body');

      function closeSidebar() {
        sidebarEl.classList.remove('open');
        overlayEl.classList.remove('open');
      }

      document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
      overlayEl.addEventListener('click', closeSidebar);
      document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeSidebar(); });

      function statusBadgeClass(status) {
        if (status === 'done' || status === 'verified' || status === 'complete') return 'badge-ok';
        if (status === 'blocked' || status === 'failed') return 'badge-danger';
        return 'badge-status';
      }

      function field(label, value, opts) {
        opts = opts || {};
        var cls = 'detail-field' + (opts.full ? ' full' : '');
        var valCls = 'detail-field-value' + (opts.mono ? ' mono' : '');
        var rendered = value;
        if (opts.badge) rendered = '<span class="badge ' + opts.badge + '">' + value + '</span>';
        else if (opts.date) rendered = fmtDate(value) || '<span style="color:var(--muted)">—</span>';
        if (!value && !opts.date) rendered = '<span style="color:var(--muted)">—</span>';
        return '<div class="' + cls + '"><div class="detail-field-label">' + label + '</div><div class="' + valCls + '">' + rendered + '</div></div>';
      }

      function renderTaskDetail(task) {
        sidebarTitleEl.textContent = task.title || task.id;
        var html = '';

        html += '<div class="detail-section"><div class="detail-section-title">Overview</div><div class="detail-grid">';
        html += field('ID', task.id, { mono: true, full: true });
        html += field('Status', task.status, { badge: statusBadgeClass(task.status) });
        html += field('Priority', task.priority, { badge: 'badge-priority' });
        html += field('Worker Type', task.worker_type);
        html += field('Initiative', task.initiative, { mono: true });
        html += '</div></div>';

        if (task.description) {
          html += '<div class="detail-section"><div class="detail-section-title">Description</div>';
          html += '<div class="detail-field full"><div class="detail-field-value">' + task.description + '</div></div></div>';
        }

        html += '<div class="detail-section"><div class="detail-section-title">Dates</div><div class="detail-grid">';
        html += field('Created', task.created_at, { date: true });
        html += field('Started', task.started_at, { date: true });
        html += field('Completed', task.completed_at, { date: true });
        html += field('Updated', task.updated_at, { date: true });
        html += field('Due', task.due, { date: true });
        html += '</div></div>';

        if (task.outputs && task.outputs.length > 0) {
          html += '<div class="detail-section"><div class="detail-section-title">Outputs</div>';
          html += '<div class="detail-field full"><div class="detail-field-value mono">' + task.outputs.join('<br>') + '</div></div></div>';
        }

        if (task.depends_on && task.depends_on.length > 0) {
          html += '<div class="detail-section"><div class="detail-section-title">Dependencies</div>';
          html += '<div class="detail-field full"><div class="detail-field-value mono">' + task.depends_on.join(', ') + '</div></div></div>';
        }

        var reasons = [];
        if (task.blocked_reason) reasons.push(['Blocked Reason', task.blocked_reason]);
        if (task.failure_reason) reasons.push(['Failure Reason', task.failure_reason]);
        if (task.cancellation_reason) reasons.push(['Cancellation Reason', task.cancellation_reason]);
        if (reasons.length > 0) {
          html += '<div class="detail-section"><div class="detail-section-title">Notes</div><div class="detail-grid">';
          reasons.forEach(function(r) { html += field(r[0], r[1], { full: true }); });
          html += '</div></div>';
        }

        if (task.retry_count > 0) {
          html += '<div class="detail-section"><div class="detail-grid">';
          html += field('Retry Count', String(task.retry_count));
          html += '</div></div>';
        }

        sidebarBodyEl.innerHTML = html;
      }

      function renderInitiativeDetail(init) {
        sidebarTitleEl.textContent = init.title || init.id;
        var html = '';

        html += '<div class="detail-section"><div class="detail-section-title">Overview</div><div class="detail-grid">';
        html += field('ID', init.id, { mono: true, full: true });
        html += field('Status', init.status, { badge: statusBadgeClass(init.status) });
        html += field('Objective', init.objective);
        html += field('Timeframe', init.timeframe);
        html += '</div></div>';

        if (init.goal) {
          html += '<div class="detail-section"><div class="detail-section-title">Goal</div>';
          html += '<div class="detail-field full"><div class="detail-field-value">' + init.goal + '</div></div></div>';
        }

        html += '<div class="detail-section"><div class="detail-section-title">Dates</div><div class="detail-grid">';
        html += field('Created', init.created_at, { date: true });
        html += field('Updated', init.updated_at, { date: true });
        html += '</div></div>';

        if (init.tasks && init.tasks.length > 0) {
          html += '<div class="detail-section"><div class="detail-section-title">Tasks (' + init.tasks.length + ')</div>';
          html += '<div class="detail-field full"><div class="detail-field-value mono">' + init.tasks.join('<br>') + '</div></div></div>';
        }

        sidebarBodyEl.innerHTML = html;
      }

      function openSidebar(type, id) {
        var endpoint = type === 'task' ? '/api/tasks/' : '/api/initiatives/';
        fetchJson(endpoint + encodeURIComponent(id)).then(function(data) {
          if (type === 'task') renderTaskDetail(data);
          else renderInitiativeDetail(data);
          sidebarEl.classList.add('open');
          overlayEl.classList.add('open');
        }).catch(function(err) {
          sidebarTitleEl.textContent = 'Error';
          sidebarBodyEl.innerHTML = '<div style="color:var(--danger);padding:12px;">Failed to load: ' + err.message + '</div>';
          sidebarEl.classList.add('open');
          overlayEl.classList.add('open');
        });
      }

      document.addEventListener('click', function(e) {
        var card = e.target.closest('[data-type][data-id]');
        if (!card) return;
        openSidebar(card.getAttribute('data-type'), card.getAttribute('data-id'));
      });

      refresh().catch(function(err) {
        document.body.insertAdjacentHTML('afterbegin',
          '<div style="background:var(--card);border:1px solid var(--danger);border-radius:8px;padding:12px;margin-bottom:12px;color:var(--danger);">Dashboard load failed: ' + err.message + '</div>'
        );
      });

      setInterval(function() {
        refresh().catch(function() {});
      }, 5000);
    </script>
  </body>
</html>`;
}

const flags = parseArgs(process.argv.slice(2));
const root = resolveRoot(flags['base-dir']);
const host = flags.host || process.env.DASHBOARD_HOST || '127.0.0.1';
const port = Number(flags.port || process.env.DASHBOARD_PORT || 4377);
const missionControlPath = join(root, 'mission-control');

if (!existsSync(missionControlPath) || !statSync(missionControlPath).isDirectory()) {
  process.stderr.write(`dashboard error: mission-control directory not found at ${missionControlPath}\n`);
  process.exit(1);
}

if (flags['dry-run'] === 'true') {
  const tasks = readTasks(root);
  const initiatives = readInitiatives(root);
  const lock = readLock(root);
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        mode: 'dry-run',
        root,
        mission_control: missionControlPath,
        summary: buildSummary(tasks, initiatives, lock),
        samples: {
          tasks: tasks.slice(0, 3).map((task) => ({ id: task.id, status: task.status, priority: task.priority })),
          initiatives: initiatives.slice(0, 3).map((initiative) => ({ id: initiative.id, status: initiative.status })),
          activity_count: readActivity(root, 25).length,
        },
      },
      null,
      2
    ) + '\n'
  );
  process.exit(0);
}

const server = createServer((req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
    const { pathname, searchParams } = requestUrl;

    if (pathname === '/health' || pathname === '/api/health') {
      const tasks = readTasks(root);
      const initiatives = readInitiatives(root);
      return json(res, 200, {
        ok: true,
        root,
        mission_control: missionControlPath,
        tasks: tasks.length,
        initiatives: initiatives.length,
      });
    }

    if (pathname === '/api/tasks') {
      let tasks = readTasks(root);
      const status = searchParams.get('status');
      const priority = searchParams.get('priority');
      const initiative = searchParams.get('initiative');
      const query = (searchParams.get('q') || '').trim().toLowerCase();

      if (status) tasks = tasks.filter((task) => task.status === status);
      if (priority) tasks = tasks.filter((task) => task.priority === priority);
      if (initiative) tasks = tasks.filter((task) => task.initiative === initiative);
      if (query) {
        tasks = tasks.filter((task) => {
          return task.id.toLowerCase().includes(query) ||
            task.title.toLowerCase().includes(query) ||
            task.description.toLowerCase().includes(query);
        });
      }

      return json(res, 200, tasks);
    }

    if (pathname.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(pathname.slice('/api/tasks/'.length));
      const task = readTasks(root).find((item) => item.id === id);
      if (!task) return json(res, 404, { error: `Task not found: ${id}` });
      return json(res, 200, task);
    }

    if (pathname === '/api/initiatives') {
      let initiatives = readInitiatives(root);
      const status = searchParams.get('status');
      if (status) initiatives = initiatives.filter((item) => item.status === status);
      return json(res, 200, initiatives);
    }

    if (pathname.startsWith('/api/initiatives/')) {
      const id = decodeURIComponent(pathname.slice('/api/initiatives/'.length));
      const initiative = readInitiatives(root).find((item) => item.id === id);
      if (!initiative) return json(res, 404, { error: `Initiative not found: ${id}` });
      return json(res, 200, initiative);
    }

    if (pathname === '/api/lock') {
      return json(res, 200, readLock(root));
    }

    if (pathname === '/api/activity') {
      const limit = Number(searchParams.get('limit') || 200);
      return json(res, 200, readActivity(root, Number.isFinite(limit) ? limit : 200));
    }

    if (pathname === '/api/summary') {
      const tasks = readTasks(root);
      const initiatives = readInitiatives(root);
      const lock = readLock(root);
      return json(res, 200, buildSummary(tasks, initiatives, lock));
    }

    if (pathname === '/api/output') {
      const relativePath = searchParams.get('path');
      if (!relativePath) return json(res, 400, { error: 'Query param "path" is required' });

      const cleaned = relativePath.replace(/^\/+/, '');
      if (cleaned.includes('..')) return json(res, 400, { error: 'Invalid path' });
      if (!cleaned.startsWith('mission-control/outputs/')) {
        return json(res, 400, { error: 'Path must be under mission-control/outputs/' });
      }

      const absolute = join(root, cleaned);
      if (!existsSync(absolute)) return json(res, 404, { error: `Output file not found: ${cleaned}` });
      return text(res, 200, readFileSync(absolute, 'utf8'));
    }

    if (pathname === '/' || pathname === '/dashboard') {
      return text(res, 200, dashboardHtml(root, missionControlPath), 'text/html; charset=utf-8');
    }

    return json(res, 404, { error: 'Not found', path: pathname });
  } catch (error) {
    return json(res, 500, {
      error: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`NanoClaw dashboard listening on http://${host}:${port}\n`);
  process.stdout.write(`Base dir: ${root}\n`);
  process.stdout.write(`Mission control: ${missionControlPath}\n`);
});
