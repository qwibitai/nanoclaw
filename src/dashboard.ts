/**
 * Web Dashboard — lightweight status page and API for Sovereign.
 * Serves an HTML dashboard and JSON API endpoints for monitoring
 * groups, tasks, memory, and system health.
 */
import http from 'http';

import {
  DASHBOARD_AUTH_TOKEN,
  DASHBOARD_PORT,
  GROUPS_DIR,
  STORE_DIR,
  DATA_DIR,
} from './config.js';
import { logger } from './logger.js';
import {
  getAllRegisteredGroups,
  getAllTasks,
  getEmbeddingChunkCount,
  getAllDbRoutines,
  getMessageCountByGroup,
  getLastActivityByGroup,
} from './db.js';

const startTime = Date.now();

/** Exported for tests to verify uptime calculations. */
export const _startTimeForTests = startTime;

// ── Auth Middleware ──────────────────────────────────────────────────

function checkAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!DASHBOARD_AUTH_TOKEN) return true;

  const authHeader = req.headers['authorization'];
  if (authHeader === `Bearer ${DASHBOARD_AUTH_TOKEN}`) return true;

  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

// ── CORS Headers ────────────────────────────────────────────────────

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

// ── Route Handlers ──────────────────────────────────────────────────

function handleHealth(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  setCorsHeaders(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
}

function handleStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  setCorsHeaders(res);
  try {
    const groups = getAllRegisteredGroups();
    const tasks = getAllTasks();
    const mem = process.memoryUsage();

    const payload = {
      uptime: process.uptime(),
      uptimeHuman: formatUptime(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      groups: Object.keys(groups).length,
      tasks: tasks.length,
      activeTasks: tasks.filter((t) => t.status === 'active').length,
      paths: {
        groups: GROUPS_DIR,
        store: STORE_DIR,
        data: DATA_DIR,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (err) {
    logger.error({ err }, 'Dashboard /api/status error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleGroups(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  setCorsHeaders(res);
  try {
    const groups = getAllRegisteredGroups();
    const messageCounts = getMessageCountByGroup();
    const lastActivity = getLastActivityByGroup();

    const payload = Object.entries(groups).map(([jid, group]) => ({
      jid,
      name: group.name,
      folder: group.folder,
      trigger: group.trigger,
      added_at: group.added_at,
      messageCount: messageCounts[jid] || 0,
      lastActivity: lastActivity[jid] || null,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (err) {
    logger.error({ err }, 'Dashboard /api/groups error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleMemory(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  setCorsHeaders(res);
  try {
    const embeddingChunks = getEmbeddingChunkCount();
    const routines = getAllDbRoutines();

    const payload = {
      embeddingChunks,
      routines: routines.length,
      routineDetails: routines.map((r) => ({
        name: r.name,
        group: r.group_name,
        enabled: r.enabled === 1,
        lastRunAt: r.last_run_at,
      })),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (err) {
    logger.error({ err }, 'Dashboard /api/memory error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleDashboardPage(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  setCorsHeaders(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getDashboardHtml());
}

// ── HTML Page ───────────────────────────────────────────────────────

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sovereign Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
      padding: 24px;
    }
    h1 {
      color: #58a6ff;
      font-size: 24px;
      margin-bottom: 24px;
      border-bottom: 1px solid #21262d;
      padding-bottom: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 20px;
    }
    .card h2 {
      color: #8b949e;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .card .value {
      color: #f0f6fc;
      font-size: 28px;
      font-weight: 600;
    }
    .card .sub {
      color: #8b949e;
      font-size: 13px;
      margin-top: 4px;
    }
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #3fb950;
      margin-right: 6px;
    }
    .section {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .section h2 {
      color: #58a6ff;
      font-size: 16px;
      margin-bottom: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid #21262d;
      font-size: 13px;
    }
    th { color: #8b949e; font-weight: 500; }
    td { color: #c9d1d9; }
    .refresh-info {
      color: #484f58;
      font-size: 12px;
      text-align: right;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <h1><span class="status-dot"></span>Sovereign Dashboard</h1>

  <div class="grid">
    <div class="card">
      <h2>Uptime</h2>
      <div class="value" id="uptime">--</div>
      <div class="sub" id="uptime-raw"></div>
    </div>
    <div class="card">
      <h2>Groups</h2>
      <div class="value" id="groups">--</div>
      <div class="sub">registered groups</div>
    </div>
    <div class="card">
      <h2>Tasks</h2>
      <div class="value" id="tasks">--</div>
      <div class="sub" id="tasks-active"></div>
    </div>
    <div class="card">
      <h2>Memory</h2>
      <div class="value" id="memory">--</div>
      <div class="sub" id="memory-heap"></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Embedding Chunks</h2>
      <div class="value" id="embeddings">--</div>
      <div class="sub">vector memory chunks</div>
    </div>
    <div class="card">
      <h2>Routines</h2>
      <div class="value" id="routines">--</div>
      <div class="sub">scheduled routines</div>
    </div>
  </div>

  <div class="section" id="groups-section">
    <h2>Registered Groups</h2>
    <table>
      <thead><tr><th>Name</th><th>Folder</th><th>Messages</th><th>Last Activity</th></tr></thead>
      <tbody id="groups-table"></tbody>
    </table>
  </div>

  <div class="refresh-info">Auto-refreshes every 30s | <span id="last-refresh">--</span></div>

  <script>
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function refresh() {
      Promise.all([
        fetch('/api/status').then(r => r.json()),
        fetch('/api/groups').then(r => r.json()),
        fetch('/api/memory').then(r => r.json()),
      ]).then(([status, groups, memory]) => {
        document.getElementById('uptime').textContent = status.uptimeHuman || '--';
        document.getElementById('uptime-raw').textContent = Math.floor(status.uptime) + 's total';
        document.getElementById('groups').textContent = status.groups;
        document.getElementById('tasks').textContent = status.tasks;
        document.getElementById('tasks-active').textContent = status.activeTasks + ' active';
        document.getElementById('memory').textContent = formatBytes(status.memory.rss);
        document.getElementById('memory-heap').textContent = formatBytes(status.memory.heapUsed) + ' heap';
        document.getElementById('embeddings').textContent = memory.embeddingChunks;
        document.getElementById('routines').textContent = memory.routines;

        var tbody = document.getElementById('groups-table');
        tbody.innerHTML = '';
        groups.forEach(function(g) {
          var tr = document.createElement('tr');
          tr.innerHTML = '<td>' + (g.name || '--') + '</td>'
            + '<td>' + (g.folder || '--') + '</td>'
            + '<td>' + (g.messageCount || 0) + '</td>'
            + '<td>' + (g.lastActivity ? new Date(g.lastActivity).toLocaleString() : '--') + '</td>';
          tbody.appendChild(tr);
        });

        document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
      }).catch(function(err) {
        console.error('Dashboard refresh failed:', err);
      });
    }

    refresh();
    setInterval(refresh, 30000);
  </script>
</body>
</html>`;
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Server ──────────────────────────────────────────────────────────

/**
 * Start the dashboard HTTP server.
 * Returns the http.Server instance for lifecycle management.
 */
export function startDashboard(): http.Server {
  const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    if (!checkAuth(req, res)) return;

    // Route
    const url = req.url?.split('?')[0] || '/';

    switch (url) {
      case '/':
        handleDashboardPage(req, res);
        break;
      case '/api/health':
        handleHealth(req, res);
        break;
      case '/api/status':
        handleStatus(req, res);
        break;
      case '/api/groups':
        handleGroups(req, res);
        break;
      case '/api/memory':
        handleMemory(req, res);
        break;
      default:
        setCorsHeaders(res);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        break;
    }
  });

  server.listen(DASHBOARD_PORT, () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard server started');
  });

  return server;
}
