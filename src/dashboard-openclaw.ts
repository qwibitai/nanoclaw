import { createServer } from 'http';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

const OC_DIR = path.join(os.homedir(), '.openclaw');
const CONFIG_PATH = path.join(OC_DIR, 'openclaw.json');
const LOG_PATH = path.join(OC_DIR, 'logs', 'gateway.log');
const CRON_PATH = path.join(OC_DIR, 'cron', 'jobs.json');
const SESSIONS_DIR = path.join(OC_DIR, 'agents', 'main', 'sessions');
const PORT = parseInt(process.env.DASHBOARD_PORT || '3334', 10);

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function getServiceStatus(): {
  running: boolean;
  pid: number | null;
  uptime: string | null;
  version: string | null;
} {
  try {
    const out = execSync(
      'launchctl list ai.openclaw.gateway 2>/dev/null || echo "not_found"',
      { encoding: 'utf-8', timeout: 5000 },
    );
    if (out.includes('not_found'))
      return { running: false, pid: null, uptime: null, version: null };
    const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
    let uptime: string | null = null;
    let version: string | null = null;
    if (pid) {
      try {
        uptime = execSync(`ps -o etime= -p ${pid} 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
      } catch {}
      try {
        const env = execSync(`ps -o command= -p ${pid} 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
        const vMatch = env.match(/OPENCLAW_SERVICE_VERSION=(\S+)/);
        if (vMatch) version = vMatch[1];
      } catch {}
    }
    // Try to get version from env
    if (!version) {
      try {
        const envOut = execSync('pgrep -fl openclaw 2>/dev/null', {
          encoding: 'utf-8',
          timeout: 3000,
        });
        const vMatch = envOut.match(/OPENCLAW_SERVICE_VERSION=(\S+)/);
        if (vMatch) version = vMatch[1];
      } catch {}
    }
    if (!version) {
      try {
        version = execSync('openclaw --version 2>/dev/null', {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
      } catch {}
    }
    return { running: pid !== null, pid, uptime, version };
  } catch {
    return { running: false, pid: null, uptime: null, version: null };
  }
}

function getChannelStatus(): {
  telegram: { enabled: boolean; bot: string | null; connected: boolean; lastEvent: string | null };
} {
  const config = readJson(CONFIG_PATH);
  const tgConfig = config?.channels?.telegram;
  const enabled = tgConfig?.enabled ?? false;
  let bot: string | null = null;
  let connected = false;
  let lastEvent: string | null = null;

  if (fs.existsSync(LOG_PATH)) {
    try {
      const logTail = execSync(`tail -200 ${JSON.stringify(LOG_PATH)} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const botMatch = logTail.match(/@(\w+Bot)/g);
      if (botMatch) bot = botMatch[botMatch.length - 1];
      // Check for connection
      if (logTail.includes('starting provider')) connected = true;
      // Last telegram event
      const tgLines = logTail.split('\n').filter((l) => l.includes('[telegram]'));
      if (tgLines.length > 0) {
        const last = tgLines[tgLines.length - 1];
        const timeMatch = last.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        lastEvent = timeMatch ? timeMatch[1] : null;
      }
    } catch {}
  }

  return {
    telegram: { enabled, bot, connected, lastEvent },
  };
}

function getRecentLogs(): Array<{
  time: string;
  subsystem: string;
  message: string;
  level: string;
}> {
  const logs: Array<{ time: string; subsystem: string; message: string; level: string }> = [];

  // Read gateway.log (human-readable format)
  if (fs.existsSync(LOG_PATH)) {
    try {
      const tail = execSync(`tail -100 ${JSON.stringify(LOG_PATH)} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      for (const line of tail.split('\n').filter(Boolean)) {
        const match = line.match(
          /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[-+]\d{2}:\d{2})\s+\[(\w[^\]]*)\]\s+(.+)/,
        );
        if (match) {
          const msg = match[3];
          const level = msg.includes('error') || msg.includes('Error') ? 'error' : msg.includes('warn') ? 'warn' : 'info';
          logs.push({ time: match[1], subsystem: match[2], message: msg, level });
        }
      }
    } catch {}
  }

  // Also check today's daily log
  const today = new Date().toISOString().split('T')[0];
  const dailyLog = `/tmp/openclaw/openclaw-${today}.log`;
  if (fs.existsSync(dailyLog)) {
    try {
      const tail = execSync(`tail -50 ${JSON.stringify(dailyLog)} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      for (const line of tail.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line);
          if (j.time && j['0']) {
            const level = j._meta?.logLevelName?.toLowerCase() || 'info';
            logs.push({ time: j.time, subsystem: 'agent', message: j['0'], level });
          }
        } catch {}
      }
    } catch {}
  }

  return logs.slice(-30);
}

function getCronJobs(): any[] {
  const data = readJson(CRON_PATH);
  return data?.jobs || [];
}

function getSessions(): Array<{ id: string; modified: string }> {
  const sessions: Array<{ id: string; modified: string }> = [];
  try {
    const indexPath = path.join(SESSIONS_DIR, 'sessions.json');
    if (fs.existsSync(indexPath)) {
      const data = readJson(indexPath);
      if (data && typeof data === 'object') {
        for (const [id, meta] of Object.entries(data as Record<string, any>)) {
          sessions.push({
            id: id.substring(0, 12),
            modified: meta?.lastModified || meta?.createdAt || '',
          });
        }
      }
    }
    // Also check session files
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const f of fs.readdirSync(SESSIONS_DIR)) {
        if (f.endsWith('.jsonl') && !sessions.find((s) => f.startsWith(s.id))) {
          const stat = fs.statSync(path.join(SESSIONS_DIR, f));
          sessions.push({
            id: f.replace('.jsonl', '').substring(0, 12),
            modified: stat.mtime.toISOString(),
          });
        }
      }
    }
  } catch {}
  return sessions;
}

function getUpdateInfo(currentVersion: string | null): { available: boolean; latest: string | null; current: string | null } {
  try {
    const updateCheck = readJson(path.join(OC_DIR, 'update-check.json'));
    const latest = updateCheck?.lastAvailableVersion || null;
    const current = currentVersion || updateCheck?.currentVersion || null;
    return {
      available: !!(latest && current && latest !== current),
      latest,
      current,
    };
  } catch {
    return { available: false, latest: null, current: null };
  }
}

function apiData() {
  const config = readJson(CONFIG_PATH);
  const service = getServiceStatus();
  const channels = getChannelStatus();
  const logs = getRecentLogs();
  const cronJobs = getCronJobs();
  const sessions = getSessions();
  const update = getUpdateInfo(service.version);

  const model = config?.agents?.defaults?.model?.primary || 'unknown';
  const fallbacks = config?.agents?.defaults?.model?.fallbacks || [];
  const skills = config?.skills?.entries ? Object.keys(config.skills.entries) : [];
  const plugins = config?.plugins?.entries ? Object.keys(config.plugins.entries) : [];

  return {
    service,
    config: { model, fallbacks, skills, plugins },
    channels,
    logs,
    cronJobs,
    sessions,
    update,
    timestamp: new Date().toISOString(),
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Dashboard</title>
<style>
  :root {
    --bg: #0a0f0a;
    --surface: #121a12;
    --surface2: #1a261a;
    --border: #2a3a2a;
    --text: #e0e8e0;
    --text2: #88a088;
    --accent: #5ce76c;
    --accent2: #9bfea2;
    --green: #00b894;
    --red: #ff6b6b;
    --orange: #fdcb6e;
    --blue: #74b9ff;
    --purple: #a29bfe;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 20px;
    max-width: 1400px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
  }
  header h1 {
    font-size: 20px;
    font-weight: 600;
    color: var(--accent2);
    letter-spacing: 1px;
  }
  header h1 span { color: var(--text2); font-weight: 400; }
  #status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 8px;
    animation: pulse 2s infinite;
  }
  #status-dot.on { background: var(--green); }
  #status-dot.off { background: var(--red); }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .meta { color: var(--text2); font-size: 12px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .card h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text2);
    margin-bottom: 12px;
  }
  .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    align-items: flex-start;
  }
  .stat-row:last-child { border-bottom: none; }
  .stat-value { color: var(--accent2); font-weight: 600; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-green { background: rgba(0,184,148,0.15); color: var(--green); }
  .badge-red { background: rgba(255,107,107,0.15); color: var(--red); }
  .badge-orange { background: rgba(253,203,110,0.15); color: var(--orange); }
  .badge-blue { background: rgba(116,185,255,0.15); color: var(--blue); }
  .badge-purple { background: rgba(162,155,254,0.15); color: var(--purple); }
  code {
    background: var(--surface2);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    white-space: nowrap;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    text-align: left;
    color: var(--text2);
    font-weight: 500;
    padding: 8px 6px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  td {
    padding: 8px 6px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  tr:last-child td { border-bottom: none; }
  .truncate {
    max-width: 500px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wide { grid-column: 1 / -1; }
  .log-line {
    font-size: 11px;
    padding: 3px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 8px;
  }
  .log-line:last-child { border-bottom: none; }
  .log-time { color: var(--text2); white-space: nowrap; min-width: 80px; }
  .log-sub { color: var(--accent); white-space: nowrap; min-width: 80px; }
  .log-msg { word-break: break-word; }
  .log-msg.error { color: var(--red); }
  .log-msg.warn { color: var(--orange); }
  .empty { color: var(--text2); font-style: italic; font-size: 13px; padding: 12px 0; }
  .time-ago { color: var(--text2); }
  .update-banner {
    background: rgba(253,203,110,0.1);
    border: 1px solid var(--orange);
    border-radius: 6px;
    padding: 8px 12px;
    margin-bottom: 16px;
    font-size: 12px;
    color: var(--orange);
  }
  @media (max-width: 768px) {
    .grid { grid-template-columns: 1fr; }
    body { padding: 12px; }
  }
</style>
</head>
<body>
<header>
  <h1><span id="status-dot" class="off"></span>OPENCLAW <span>DASHBOARD</span></h1>
  <div class="meta">
    <span id="last-update"></span>
    &middot; auto-refresh 10s
  </div>
</header>

<div id="update-banner"></div>
<div class="grid" id="top-stats"></div>
<div class="grid" id="main-content"></div>

<script>
const API = '/api/data';
let data = null;

function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

function badge(text, color) {
  return '<span class="badge badge-' + color + '">' + text + '</span>';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderTopStats() {
  const d = data;
  const svc = d.service;
  document.getElementById('status-dot').className = svc.running ? 'on' : 'off';

  // Update banner
  if (d.update.available) {
    document.getElementById('update-banner').innerHTML =
      '<div class="update-banner">Update available: <strong>' + esc(d.update.latest) + '</strong> (current: ' + esc(d.update.current || svc.version) + '). Run: <code>openclaw update</code></div>';
  }

  let html = '';

  // Service
  html += '<div class="card"><h2>Service</h2>';
  html += '<div class="stat-row"><span>Status</span><span class="stat-value">' + (svc.running ? '🟢 Running' : '🔴 Stopped') + '</span></div>';
  if (svc.pid) html += '<div class="stat-row"><span>PID</span><span class="stat-value">' + svc.pid + '</span></div>';
  if (svc.uptime) html += '<div class="stat-row"><span>Uptime</span><span class="stat-value">' + svc.uptime + '</span></div>';
  if (svc.version) html += '<div class="stat-row"><span>Version</span><span class="stat-value">' + esc(svc.version) + '</span></div>';
  html += '</div>';

  // Channel
  html += '<div class="card"><h2>Channels</h2>';
  const tg = d.channels.telegram;
  if (tg.enabled) {
    const connBadge = tg.connected ? badge('connected', 'green') : badge('disconnected', 'red');
    const acct = tg.bot ? '<br><span class="time-ago" style="font-size:11px">' + esc(tg.bot) + '</span>' : '';
    html += '<div class="stat-row"><span>✈️ telegram' + acct + '</span><span>' + connBadge + '</span></div>';
  } else {
    html += '<div class="empty">No channels enabled</div>';
  }
  html += '</div>';

  // Model config
  html += '<div class="card"><h2>Agent Config</h2>';
  html += '<div class="stat-row"><span>Model</span><span class="stat-value"><code>' + esc(d.config.model) + '</code></span></div>';
  if (d.config.fallbacks.length > 0) {
    html += '<div class="stat-row"><span>Fallbacks</span><span class="stat-value">' + d.config.fallbacks.map(f => '<code>' + esc(f) + '</code>').join(', ') + '</span></div>';
  }
  if (d.config.skills.length > 0) {
    html += '<div class="stat-row"><span>Skills</span><span class="stat-value">' + d.config.skills.map(s => badge(s, 'blue')).join(' ') + '</span></div>';
  }
  if (d.config.plugins.length > 0) {
    html += '<div class="stat-row"><span>Plugins</span><span class="stat-value">' + d.config.plugins.map(p => badge(p, 'purple')).join(' ') + '</span></div>';
  }
  html += '</div>';

  // Sessions
  html += '<div class="card"><h2>Sessions (' + d.sessions.length + ')</h2>';
  if (d.sessions.length === 0) {
    html += '<div class="empty">No sessions</div>';
  } else {
    d.sessions.forEach(s => {
      html += '<div class="stat-row"><span><code>' + esc(s.id) + '...</code></span><span class="time-ago">' + timeAgo(s.modified) + '</span></div>';
    });
  }
  html += '</div>';

  document.getElementById('top-stats').innerHTML = html;
}

function renderMain() {
  const d = data;
  let html = '';

  // Cron jobs
  html += '<div class="card wide"><h2>Cron Jobs (' + d.cronJobs.length + ')</h2>';
  if (d.cronJobs.length === 0) {
    html += '<div class="empty">No cron jobs configured</div>';
  } else {
    html += '<table><tr><th>Schedule</th><th>Command</th><th>Status</th></tr>';
    d.cronJobs.forEach(j => {
      html += '<tr><td><code>' + esc(j.schedule || j.cron) + '</code></td>';
      html += '<td class="truncate">' + esc(j.command || j.prompt || j.name) + '</td>';
      html += '<td>' + badge(j.status || 'active', j.status === 'active' ? 'green' : 'orange') + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div>';

  // Recent logs
  html += '<div class="card wide"><h2>Recent Logs</h2>';
  if (d.logs.length === 0) {
    html += '<div class="empty">No recent logs</div>';
  } else {
    d.logs.slice(-25).forEach(l => {
      const time = l.time.split('T')[1]?.substring(0, 8) || l.time;
      html += '<div class="log-line">';
      html += '<span class="log-time">' + esc(time) + '</span>';
      html += '<span class="log-sub">' + esc(l.subsystem) + '</span>';
      html += '<span class="log-msg ' + l.level + '">' + esc(l.message) + '</span>';
      html += '</div>';
    });
  }
  html += '</div>';

  document.getElementById('main-content').innerHTML = html;
}

async function refresh() {
  try {
    const res = await fetch(API);
    data = await res.json();
    document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
    renderTopStats();
    renderMain();
  } catch (e) {
    console.error('Refresh failed:', e);
  }
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      res.end(JSON.stringify(apiData()));
    } catch (err) {
      res.end(JSON.stringify({ error: String(err) }));
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  }
});

server.listen(PORT, () => {
  console.log(`OpenClaw Dashboard: http://localhost:${PORT}`);
});
