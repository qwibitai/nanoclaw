#!/usr/bin/env node
/**
 * Atlas Mission Control — lightweight status dashboard
 *
 * Server-rendered HTML, auto-refreshes every 10 seconds.
 * Reads from NanoClaw SQLite + Atlas JSONL state files.
 * No React, no build tooling — single file.
 *
 * Usage: node mission-control/server.js
 * Accessible at http://<vps-ip>:8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const PORT = process.env.MC_PORT || 8080;
const ATLAS_DIR = path.join(require('os').homedir(), '.atlas');
const NANOCLAW_DB = path.join(__dirname, '..', 'store', 'messages.db');

// --- Basic auth from .env ---
function loadEnvAuth() {
  const envPath = path.join(__dirname, '..', '.env');
  let user = process.env.MISSION_CONTROL_USER;
  let pass = process.env.MISSION_CONTROL_PASS;
  if (!user || !pass) {
    try {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const [key, ...rest] = line.split('=');
        const val = rest.join('=').trim();
        if (key.trim() === 'MISSION_CONTROL_USER') user = val;
        if (key.trim() === 'MISSION_CONTROL_PASS') pass = val;
      }
    } catch { /* no .env — auth disabled */ }
  }
  return { user, pass };
}

const AUTH = loadEnvAuth();
const AUTH_ENABLED = !!(AUTH.user && AUTH.pass);

function checkAuth(req, res) {
  if (!AUTH_ENABLED) return true;
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Atlas Mission Control"' });
    res.end('Authentication required');
    return false;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const [user, ...passParts] = decoded.split(':');
  const pass = passParts.join(':');
  if (user === AUTH.user && pass === AUTH.pass) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Atlas Mission Control"' });
  res.end('Invalid credentials');
  return false;
}

// --- Data readers ---

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function readJsonl(filePath, maxLines = 50) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    return lines.slice(-maxLines).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getActiveContainers() {
  try {
    const out = execSync('docker ps --format "{{.Names}}\\t{{.Status}}\\t{{.RunningFor}}"', {
      timeout: 5000, encoding: 'utf-8'
    });
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [name, status, running] = line.split('\t');
      return { name, status, running };
    });
  } catch { return []; }
}

function getGraduationStatus() {
  return readJson(path.join(ATLAS_DIR, 'autonomy', 'graduation-status.json'));
}

function getMode() {
  const mode = readJson(path.join(ATLAS_DIR, 'state', 'mode.json'));
  return mode?.mode || mode?.status || 'unknown';
}

function getQuotaToday() {
  const quotaFile = path.join(ATLAS_DIR, 'autonomy', 'quota-tracking.jsonl');
  const entries = readJsonl(quotaFile, 500);
  const today = new Date().toISOString().split('T')[0];

  const weights = { haiku: 0.1, sonnet: 1.0, opus: 5.0 };
  let total = 0, autonomous = 0, ceo = 0, weighted = 0;

  for (const e of entries) {
    if (!e.timestamp?.startsWith(today)) continue;
    total++;
    const model = (e.model || 'sonnet').toLowerCase();
    let w = 1.0;
    for (const [k, v] of Object.entries(weights)) {
      if (model.includes(k)) { w = v; break; }
    }
    weighted += w;
    if (e.type === 'autonomous') autonomous++;
    else ceo++;
  }

  const pct = weighted / 200;
  const level = pct >= 0.9 ? 'PAUSED' : pct >= 0.6 ? 'THROTTLED' : 'NORMAL';
  return { total, autonomous, ceo, weighted: Math.round(weighted * 100) / 100, level, pct: Math.round(pct * 100) };
}

function getRecentTaskRuns(db, limit = 10) {
  try {
    return db.prepare(`
      SELECT trl.task_id, trl.run_at, trl.duration_ms, trl.status, trl.error,
             st.group_folder, st.schedule_type, st.schedule_value
      FROM task_run_logs trl
      LEFT JOIN scheduled_tasks st ON trl.task_id = st.id
      ORDER BY trl.run_at DESC
      LIMIT ?
    `).all(limit);
  } catch { return []; }
}

function getScheduledTasks(db) {
  try {
    return db.prepare(`
      SELECT id, group_folder, schedule_type, schedule_value, status, next_run, last_run, last_result
      FROM scheduled_tasks
      ORDER BY status, next_run
    `).all();
  } catch { return []; }
}

function getRegisteredGroups(db) {
  try {
    return db.prepare('SELECT jid, name, folder, is_main FROM registered_groups').all();
  } catch { return []; }
}

function getRecentLearning() {
  const logFile = path.join(ATLAS_DIR, 'autonomy', 'learning-log.jsonl');
  return readJsonl(logFile, 10);
}

function getHostTaskResults() {
  const dir = path.join(ATLAS_DIR, 'host-tasks', 'completed');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort().reverse().slice(0, 10)
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
        catch { return null; }
      }).filter(Boolean);
  } catch { return []; }
}

function getApprovalQueue() {
  const dir = path.join(ATLAS_DIR, 'approval-queue', 'pending');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
        catch { return null; }
      }).filter(Boolean);
  } catch { return []; }
}

// --- HTML rendering ---

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function statusBadge(status) {
  const colors = {
    active: '#22c55e', paused: '#f59e0b', completed: '#6b7280',
    success: '#22c55e', error: '#ef4444', pending: '#3b82f6',
    NORMAL: '#22c55e', THROTTLED: '#f59e0b', PAUSED: '#ef4444',
  };
  const color = colors[status] || '#6b7280';
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">${esc(status)}</span>`;
}

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = new Date(iso) - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  const mins = Math.floor(abs / 60000);
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return past ? `${hrs}h ago` : `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}

function renderPage(data) {
  const { mode, containers, quota, graduation, tasks, runs, groups, learning, hostResults, approvals } = data;
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const graduationRows = graduation?.milestones
    ? Object.entries(graduation.milestones).map(([k, m]) => {
        const prog = m.progress || {};
        const detail = Object.entries(prog)
          .filter(([pk]) => pk !== 'target')
          .map(([pk, pv]) => `${pk.replace(/_/g, ' ')}: ${pv}${prog.target ? '/' + prog.target : ''}`)
          .join(', ');
        return `<tr><td>${k}</td><td>${statusBadge(m.status)}</td><td>${esc(detail)}</td></tr>`;
      }).join('')
    : '<tr><td colspan="3">No graduation data</td></tr>';

  const taskRows = tasks.map(t =>
    `<tr>
      <td style="font-family:monospace;font-size:12px">${esc(t.id).slice(0, 25)}</td>
      <td>${esc(t.group_folder)}</td>
      <td>${esc(t.schedule_type)} ${esc(t.schedule_value)}</td>
      <td>${statusBadge(t.status)}</td>
      <td>${relativeTime(t.next_run)}</td>
      <td>${relativeTime(t.last_run)}</td>
    </tr>`
  ).join('');

  const runRows = runs.map(r =>
    `<tr>
      <td style="font-size:12px">${esc(r.task_id).slice(0, 25)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '—'}</td>
      <td>${relativeTime(r.run_at)}</td>
      <td style="font-size:12px;color:#ef4444">${esc(r.error || '').slice(0, 60)}</td>
    </tr>`
  ).join('');

  const containerRows = containers.length > 0
    ? containers.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.status)}</td><td>${esc(c.running)}</td></tr>`).join('')
    : '<tr><td colspan="3" style="color:#6b7280">No active containers</td></tr>';

  const hostRows = hostResults.map(h =>
    `<tr>
      <td style="font-size:12px">${esc(h.task_id).slice(0, 25)}</td>
      <td>${esc(h.entity)}</td>
      <td>${statusBadge(h.status)}</td>
      <td>${h.commits?.length || 0}</td>
      <td>${h.pushed ? '✓' : '—'}</td>
      <td>${relativeTime(h.completed_at)}</td>
    </tr>`
  ).join('') || '<tr><td colspan="6" style="color:#6b7280">No host-executor tasks yet</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="10">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Atlas Mission Control</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border-radius: 8px; padding: 16px; }
    .card h3 { font-size: 12px; text-transform: uppercase; color: #94a3b8; margin-bottom: 8px; }
    .card .value { font-size: 28px; font-weight: 700; }
    .section { background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .section h2 { font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 6px 8px; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155; }
    td { padding: 6px 8px; border-bottom: 1px solid #1e293b; }
    tr:hover td { background: #334155; }
    .quota-bar { height: 8px; background: #334155; border-radius: 4px; margin-top: 8px; overflow: hidden; }
    .quota-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  </style>
</head>
<body>
  <h1>Atlas Mission Control</h1>
  <div class="subtitle">${esc(now)} ET &middot; Auto-refreshes every 10s</div>

  <div class="grid">
    <div class="card">
      <h3>Mode</h3>
      <div class="value">${statusBadge(mode)}</div>
    </div>
    <div class="card">
      <h3>Containers</h3>
      <div class="value">${containers.length}</div>
    </div>
    <div class="card">
      <h3>Today's Tasks</h3>
      <div class="value">${quota.total}</div>
      <div style="font-size:12px;color:#94a3b8">${quota.autonomous} auto / ${quota.ceo} CEO</div>
    </div>
    <div class="card">
      <h3>Quota</h3>
      <div class="value">${quota.pct}%</div>
      <div class="quota-bar">
        <div class="quota-fill" style="width:${Math.min(quota.pct, 100)}%;background:${quota.level === 'NORMAL' ? '#22c55e' : quota.level === 'THROTTLED' ? '#f59e0b' : '#ef4444'}"></div>
      </div>
      <div style="font-size:12px;color:#94a3b8;margin-top:4px">${statusBadge(quota.level)} &middot; ${quota.weighted} weighted</div>
    </div>
    <div class="card">
      <h3>Approvals</h3>
      <div class="value">${approvals.length}</div>
      <div style="font-size:12px;color:#94a3b8">pending</div>
    </div>
  </div>

  <div class="section">
    <h2>Active Containers</h2>
    <table><thead><tr><th>Name</th><th>Status</th><th>Running</th></tr></thead>
    <tbody>${containerRows}</tbody></table>
  </div>

  <div class="section">
    <h2>Graduation Progress</h2>
    <table><thead><tr><th>Milestone</th><th>Status</th><th>Progress</th></tr></thead>
    <tbody>${graduationRows}</tbody></table>
  </div>

  <div class="section">
    <h2>Scheduled Tasks</h2>
    <table><thead><tr><th>ID</th><th>Group</th><th>Schedule</th><th>Status</th><th>Next Run</th><th>Last Run</th></tr></thead>
    <tbody>${taskRows}</tbody></table>
  </div>

  <div class="section">
    <h2>Recent Task Runs</h2>
    <table><thead><tr><th>Task</th><th>Status</th><th>Duration</th><th>When</th><th>Error</th></tr></thead>
    <tbody>${runRows}</tbody></table>
  </div>

  <div class="section">
    <h2>Host-Executor Results</h2>
    <table><thead><tr><th>Task</th><th>Entity</th><th>Status</th><th>Commits</th><th>Pushed</th><th>When</th></tr></thead>
    <tbody>${hostRows}</tbody></table>
  </div>

  <div class="section">
    <h2>Registered Groups</h2>
    <table><thead><tr><th>Name</th><th>Folder</th><th>JID</th><th>Main</th></tr></thead>
    <tbody>${groups.map(g => `<tr><td>${esc(g.name)}</td><td>${esc(g.folder)}</td><td style="font-size:11px">${esc(g.jid)}</td><td>${g.is_main ? '★' : ''}</td></tr>`).join('')}</tbody></table>
  </div>
</body>
</html>`;
}

// --- Server ---

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;

  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let db;
  try {
    db = new Database(NANOCLAW_DB, { readonly: true });
  } catch (err) {
    res.writeHead(500);
    res.end(`Database error: ${err.message}`);
    return;
  }

  try {
    const data = {
      mode: getMode(),
      containers: getActiveContainers(),
      quota: getQuotaToday(),
      graduation: getGraduationStatus(),
      tasks: getScheduledTasks(db),
      runs: getRecentTaskRuns(db),
      groups: getRegisteredGroups(db),
      learning: getRecentLearning(),
      hostResults: getHostTaskResults(),
      approvals: getApprovalQueue(),
    };

    const html = renderPage(data);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500);
    res.end(`Render error: ${err.message}`);
  } finally {
    db.close();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Atlas Mission Control running at http://0.0.0.0:${PORT} (auth: ${AUTH_ENABLED ? 'enabled' : 'DISABLED — set MISSION_CONTROL_USER and MISSION_CONTROL_PASS in .env'})`);
});
