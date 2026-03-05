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
    <title>NanoClaw Mission Control</title>
    <style>
      :root {
        --bg: #f6f7f8;
        --card: #ffffff;
        --text: #1e2329;
        --muted: #6b737d;
        --border: #d9dee4;
        --ok: #1a7f37;
        --warn: #9a6700;
        --danger: #cf222e;
        --accent: #0969da;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 20px;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background: radial-gradient(circle at 20% 0%, #e8eef8, #f6f7f8 45%);
      }
      h1 { margin: 0 0 8px; font-size: 26px; }
      .sub { color: var(--muted); margin-bottom: 16px; font-size: 14px; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
        margin-bottom: 12px;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
      }
      .metric { font-size: 24px; font-weight: 700; }
      .label { color: var(--muted); font-size: 13px; }
      .status-ok { color: var(--ok); }
      .status-warn { color: var(--warn); }
      .status-danger { color: var(--danger); }
      table {
        width: 100%;
        border-collapse: collapse;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
      }
      th, td {
        text-align: left;
        font-size: 13px;
        border-bottom: 1px solid var(--border);
        padding: 8px;
        vertical-align: top;
      }
      th { background: #f3f5f8; font-weight: 600; }
      tr:last-child td { border-bottom: 0; }
      .row {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: 12px;
      }
      @media (max-width: 1000px) {
        .row { grid-template-columns: 1fr; }
      }
      .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
      .dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-right: 6px;
      }
      .dot.green { background: var(--ok); }
      .dot.red { background: var(--danger); }
      a { color: var(--accent); }
    </style>
  </head>
  <body>
    <h1>NanoClaw Mission Control</h1>
    <div class="sub">Base dir: <span class="mono">${escapeHtml(baseDir)}</span> | Endpoint root: <span class="mono">${escapeHtml(mcPath)}</span></div>

    <div id="metrics" class="grid"></div>

    <div class="row">
      <div class="card">
        <h3>Tasks</h3>
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Title</th><th>Status</th><th>Priority</th><th>Initiative</th><th>Updated</th>
            </tr>
          </thead>
          <tbody id="tasks"></tbody>
        </table>
      </div>

      <div class="card">
        <h3>Recent Activity</h3>
        <table>
          <thead>
            <tr><th>Time</th><th>Event</th><th>Target</th><th>Detail</th></tr>
          </thead>
          <tbody id="activity"></tbody>
        </table>
      </div>
    </div>

    <script>
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

      function statusClass(lock) {
        if (lock && lock.locked) return 'status-danger';
        return 'status-ok';
      }

      async function refresh() {
        const [summary, tasks, activity] = await Promise.all([
          fetchJson('/api/summary'),
          fetchJson('/api/tasks'),
          fetchJson('/api/activity?limit=25'),
        ]);

        const lockLabel = summary.lock && summary.lock.locked
          ? '<span class="dot red"></span>Locked'
          : '<span class="dot green"></span>Unlocked';

        document.getElementById('metrics').innerHTML =
          '<div class=\"card\"><div class=\"metric\">' + summary.tasks_total + '</div><div class=\"label\">Total tasks</div></div>' +
          '<div class=\"card\"><div class=\"metric\">' + summary.ready_tasks + '</div><div class=\"label\">Ready tasks</div></div>' +
          '<div class=\"card\"><div class=\"metric\">' + summary.in_progress_tasks + '</div><div class=\"label\">In progress</div></div>' +
          '<div class=\"card\"><div class=\"metric\">' + summary.blocked_tasks + '</div><div class=\"label\">Blocked</div></div>' +
          '<div class=\"card\"><div class=\"metric\">' + summary.initiatives_total + '</div><div class=\"label\">Initiatives</div></div>' +
          '<div class=\"card\"><div class=\"metric ' + statusClass(summary.lock) + '\">' + lockLabel + '</div><div class=\"label\">Worker lock</div></div>';

        document.getElementById('tasks').innerHTML = tasks.slice(0, 80).map((task) =>
          '<tr>' +
            '<td class=\"mono\">' + task.id + '</td>' +
            '<td>' + task.title + '</td>' +
            '<td>' + task.status + '</td>' +
            '<td>' + task.priority + '</td>' +
            '<td class=\"mono\">' + (task.initiative ?? '') + '</td>' +
            '<td>' + fmtDate(task.updated_at) + '</td>' +
          '</tr>'
        ).join('');

        document.getElementById('activity').innerHTML = activity.map((event) =>
          '<tr>' +
            '<td>' + fmtDate(event.ts) + '</td>' +
            '<td class=\"mono\">' + (event.event ?? '') + '</td>' +
            '<td class=\"mono\">' + (event.task_id ?? event.initiative_id ?? '') + '</td>' +
            '<td>' + (event.detail ?? '') + '</td>' +
          '</tr>'
        ).join('');
      }

      refresh().catch((err) => {
        const message = document.createElement('div');
        message.className = 'card';
        message.textContent = 'Dashboard load failed: ' + err.message;
        document.body.prepend(message);
      });

      setInterval(() => {
        refresh().catch(() => {});
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
