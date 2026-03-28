import Database from 'better-sqlite3';
import { createServer } from 'http';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = process.cwd();
const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
const DB_PATH = path.join(STORE_DIR, 'messages.db');
const PORT = parseInt(process.env.DASHBOARD_PORT || '3333', 10);

function getDb(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  return new Database(DB_PATH, { readonly: true });
}

function getContainers(): Array<{
  name: string;
  status: string;
  created: string;
}> {
  try {
    const out = execSync(
      'docker ps --filter "ancestor=nanoclaw-agent:latest" --format "{{.Names}}\\t{{.Status}}\\t{{.CreatedAt}}" 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    );
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, status, created] = line.split('\t');
        return { name, status, created };
      });
  } catch {
    return [];
  }
}

function getServiceStatus(): {
  running: boolean;
  pid: number | null;
  uptime: string | null;
} {
  try {
    const out = execSync(
      'launchctl list com.nanoclaw 2>/dev/null || echo "not_found"',
      { encoding: 'utf-8', timeout: 5000 },
    );
    if (out.includes('not_found')) return { running: false, pid: null, uptime: null };
    const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
    let uptime: string | null = null;
    if (pid) {
      try {
        const elapsed = execSync(`ps -o etime= -p ${pid} 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
        uptime = elapsed;
      } catch {
        /* process may have just died */
      }
    }
    return { running: pid !== null, pid, uptime };
  } catch {
    return { running: false, pid: null, uptime: null };
  }
}

function getChannelStatus(): Array<{
  name: string;
  connected: boolean;
  lastEvent: string | null;
  lastEventTime: string | null;
  account: string | null;
}> {
  const LOG_PATH = path.resolve(PROJECT_ROOT, 'logs', 'nanoclaw.log');
  const channels = ['whatsapp', 'telegram', 'outlook', 'gmail', 'discord', 'slack'];
  const status: Record<string, { connected: boolean; lastEvent: string | null; lastEventTime: string | null; account: string | null }> = {};
  for (const ch of channels) {
    status[ch] = { connected: false, lastEvent: null, lastEventTime: null, account: null };
  }

  if (!fs.existsSync(LOG_PATH)) return channels.map(name => ({ name, ...status[name] }));

  try {
    // Read last 500 lines of log for channel events
    const log = execSync(`tail -500 ${JSON.stringify(LOG_PATH)} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const lines = log.split('\n');
    for (const line of lines) {
      const timeMatch = line.match(/\[(\d{2}:\d{2}:\d{2}\.\d{3})\]/);
      const time = timeMatch ? timeMatch[1] : null;

      const lineLower = line.toLowerCase();

      // Channel-specific connect patterns
      const connectPatterns: Record<string, string[]> = {
        whatsapp: ['connected to whatsapp', 'whatsapp channel connected'],
        telegram: ['telegram bot connected', 'telegram channel connected'],
        outlook: ['outlook channel connected'],
        gmail: ['gmail channel connected'],
        discord: ['discord channel connected', 'discord bot connected'],
        slack: ['slack channel connected'],
      };
      const stopPatterns: Record<string, string[]> = {
        whatsapp: ['whatsapp channel stopped', 'whatsapp disconnected', 'connection closed'],
        telegram: ['telegram channel stopped', 'telegram bot stopped'],
        outlook: ['outlook channel stopped'],
        gmail: ['gmail channel stopped'],
        discord: ['discord channel stopped'],
        slack: ['slack channel stopped'],
      };

      for (const ch of channels) {
        if (connectPatterns[ch]?.some(p => lineLower.includes(p))) {
          status[ch] = { connected: true, lastEvent: 'connected', lastEventTime: time };
        } else if (stopPatterns[ch]?.some(p => lineLower.includes(p))) {
          status[ch] = { connected: false, lastEvent: 'stopped', lastEventTime: time };
        } else if (lineLower.includes(ch.toLowerCase()) && lineLower.includes('delivered')) {
          if (!status[ch].connected) {
            status[ch] = { connected: true, lastEvent: 'active', lastEventTime: time };
          } else {
            status[ch].lastEvent = 'active';
            status[ch].lastEventTime = time;
          }
        }
      }
    }
  } catch {
    /* log read failed */
  }

  // Extract account identities from logs (use last match = most recent)
  try {
    const logPath = path.resolve(PROJECT_ROOT, 'logs', 'nanoclaw.log');
    if (fs.existsSync(logPath)) {
      const logTail = execSync(`tail -2000 ${JSON.stringify(logPath)} 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      });

      // Helper: find last match in string
      const lastMatch = (text: string, re: RegExp): RegExpMatchArray | null => {
        const matches = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
        return matches.length > 0 ? matches[matches.length - 1] : null;
      };

      // Telegram: @BotUsername
      const tgMatch = lastMatch(logTail, /Telegram bot: @(\S+)/);
      if (tgMatch) status['telegram'].account = `@${tgMatch[1]}`;

      // Outlook: email from connection log
      const olMatch = lastMatch(logTail, /Outlook channel connected[\s\S]*?email.*?:\s*"([^"]+)"/);
      if (olMatch) status['outlook'].account = olMatch[1];

      // Gmail: email from connection log
      const gmMatch = lastMatch(logTail, /Gmail channel connected[\s\S]*?email.*?:\s*"([^"]+)"/);
      if (gmMatch) status['gmail'].account = gmMatch[1];

      // WhatsApp: phone number from connection
      const waMatch = lastMatch(logTail, /"username":\s*"(\d{10,})"/);
      if (waMatch) status['whatsapp'].account = `+${waMatch[1]}`;
    }
  } catch {
    /* log parsing failed */
  }

  // Fall back to .env / credential files for account info
  try {
    const envPath2 = path.resolve(PROJECT_ROOT, '.env');
    const env2 = fs.existsSync(envPath2) ? fs.readFileSync(envPath2, 'utf-8') : '';
    const msEmail = env2.match(/MS_USER_EMAIL=(.+)/)?.[1]?.trim();
    if (msEmail && !status['outlook'].account) status['outlook'].account = msEmail;
  } catch { /* */ }

  try {
    const gmailCreds = path.join(os.homedir(), '.gmail-mcp', 'credentials.json');
    if (fs.existsSync(gmailCreds) && !status['gmail'].account) {
      const creds = JSON.parse(fs.readFileSync(gmailCreds, 'utf-8'));
      if (creds.email) status['gmail'].account = creds.email;
    }
  } catch { /* */ }

  // Also check for .env credentials to determine which channels are configured
  const envPath = path.resolve(PROJECT_ROOT, '.env');
  let envContent = '';
  try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* no .env */ }

  const configured = new Set<string>();
  if (envContent.includes('MS_TENANT_ID')) configured.add('outlook');
  if (envContent.includes('TELEGRAM_BOT_TOKEN') || fs.existsSync(path.resolve(PROJECT_ROOT, '.claude/channels/telegram/.env'))) configured.add('telegram');
  if (fs.existsSync(path.join(os.homedir(), '.gmail-mcp'))) configured.add('gmail');
  // WhatsApp auth store
  if (fs.existsSync(path.resolve(PROJECT_ROOT, 'store', 'auth')) || fs.existsSync(path.resolve(PROJECT_ROOT, 'auth_info_baileys'))) configured.add('whatsapp');

  return channels
    .filter(name => configured.has(name) || status[name].connected || status[name].lastEvent)
    .map(name => ({ name, ...status[name] }));
}

function getNotionStatus(): {
  connected: boolean;
  account: string | null;
  workspace: string | null;
  error: string | null;
} {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    return { connected: false, account: null, workspace: null, error: 'No NOTION_API_KEY' };
  }
  try {
    const out = execSync(
      `curl -s -m 5 -w "\\n%{http_code}" -H "Authorization: Bearer ${apiKey}" -H "Notion-Version: 2022-06-28" https://api.notion.com/v1/users/me`,
      { encoding: 'utf-8', timeout: 8000 },
    );
    const lines = out.trim().split('\n');
    const httpCode = lines.pop()!.trim();
    const body = lines.join('\n');
    if (httpCode === '200') {
      const parsed = JSON.parse(body);
      return {
        connected: true,
        account: parsed.name || null,
        workspace: null,
        error: null,
      };
    }
    return { connected: false, account: null, workspace: null, error: `HTTP ${httpCode}` };
  } catch {
    return { connected: false, account: null, workspace: null, error: 'Request failed' };
  }
}

// Cache Notion status (re-check every 60s, not every 10s refresh)
let _notionCache: ReturnType<typeof getNotionStatus> | null = null;
let _notionCacheTime = 0;
function getCachedNotionStatus() {
  const now = Date.now();
  if (!_notionCache || now - _notionCacheTime > 60_000) {
    _notionCache = getNotionStatus();
    _notionCacheTime = now;
  }
  return _notionCache;
}

const EMPTY_DATA = {
  service: { running: false, pid: null, uptime: null },
  channels: [] as Array<{ name: string; connected: boolean; lastEvent: string | null; lastEventTime: string | null; account: string | null }>,
  groups: [],
  groupFolders: [],
  tasks: [],
  recentRuns: [],
  chats: [],
  messageStats: { total: 0, last_hour: 0, last_24h: 0, last_7d: 0 },
  hourlyVolume: [],
  channelStats: [],
  containers: [],
  notion: { connected: false, account: null, workspace: null, error: null } as ReturnType<typeof getNotionStatus>,
  timestamp: new Date().toISOString(),
};

function apiData() {
  const db = getDb();
  if (!db) return { ...EMPTY_DATA, channels: getChannelStatus(), containers: getContainers(), service: getServiceStatus(), notion: getCachedNotionStatus(), timestamp: new Date().toISOString() };

  const groups = db
    .prepare(
      `SELECT jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main
       FROM registered_groups ORDER BY is_main DESC, name`,
    )
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    requires_trigger: number;
    is_main: number;
  }>;

  const tasks = db
    .prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
              context_mode, next_run, last_run, last_result, status, created_at
       FROM scheduled_tasks ORDER BY status, next_run`,
    )
    .all() as Array<Record<string, unknown>>;

  const recentRuns = db
    .prepare(
      `SELECT trl.task_id, trl.run_at, trl.duration_ms, trl.status, trl.error,
              st.prompt, st.group_folder
       FROM task_run_logs trl
       LEFT JOIN scheduled_tasks st ON trl.task_id = st.id
       ORDER BY trl.run_at DESC LIMIT 25`,
    )
    .all() as Array<Record<string, unknown>>;

  const chats = db
    .prepare(
      `SELECT jid, name, last_message_time, channel, is_group
       FROM chats WHERE jid != '__group_sync__'
       ORDER BY last_message_time DESC LIMIT 30`,
    )
    .all() as Array<Record<string, unknown>>;

  const messageStats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN timestamp > datetime('now', '-1 hour') THEN 1 ELSE 0 END) as last_hour,
         SUM(CASE WHEN timestamp > datetime('now', '-24 hours') THEN 1 ELSE 0 END) as last_24h,
         SUM(CASE WHEN timestamp > datetime('now', '-7 days') THEN 1 ELSE 0 END) as last_7d
       FROM messages`,
    )
    .get() as { total: number; last_hour: number; last_24h: number; last_7d: number };

  // Message volume by hour (last 24h)
  const hourlyVolume = db
    .prepare(
      `SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
       FROM messages
       WHERE timestamp > datetime('now', '-24 hours')
       GROUP BY hour ORDER BY hour`,
    )
    .all() as Array<{ hour: string; count: number }>;

  // Messages by channel
  const channelStats = db
    .prepare(
      `SELECT c.channel, COUNT(m.id) as count
       FROM messages m
       JOIN chats c ON m.chat_jid = c.jid
       WHERE m.timestamp > datetime('now', '-24 hours')
       GROUP BY c.channel`,
    )
    .all() as Array<{ channel: string; count: number }>;

  // Group folder disk usage
  const groupFolders: Array<{ folder: string; exists: boolean }> = [];
  for (const g of groups) {
    const folderPath = path.join(GROUPS_DIR, g.folder);
    groupFolders.push({ folder: g.folder, exists: fs.existsSync(folderPath) });
  }

  const containers = getContainers();
  const service = getServiceStatus();
  const channels = getChannelStatus();

  db.close();

  return {
    service,
    channels,
    groups,
    groupFolders,
    tasks,
    recentRuns,
    chats,
    messageStats,
    hourlyVolume,
    channelStats,
    containers,
    notion: getCachedNotionStatus(),
    timestamp: new Date().toISOString(),
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NanoClaw Dashboard</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a26;
    --border: #2a2a3a;
    --text: #e0e0e8;
    --text2: #8888a0;
    --accent: #6c5ce7;
    --accent2: #a29bfe;
    --green: #00b894;
    --red: #ff6b6b;
    --orange: #fdcb6e;
    --blue: #74b9ff;
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
  .badge-purple { background: rgba(108,92,231,0.15); color: var(--accent2); }
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
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wide { grid-column: 1 / -1; }
  .bar-chart {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 60px;
    padding-top: 8px;
  }
  .bar {
    flex: 1;
    background: var(--accent);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    position: relative;
    transition: background 0.2s;
  }
  .bar:hover { background: var(--accent2); }
  .bar-label {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--text2);
    margin-top: 4px;
  }
  .channel-pills {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .channel-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 6px;
    background: var(--surface2);
    font-size: 12px;
  }
  .channel-pill .count {
    color: var(--accent2);
    font-weight: 600;
  }
  code {
    background: var(--surface2);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    white-space: nowrap;
  }
  .empty { color: var(--text2); font-style: italic; font-size: 13px; padding: 12px 0; }
  .time-ago { color: var(--text2); }
  @media (max-width: 768px) {
    .grid { grid-template-columns: 1fr; }
    body { padding: 12px; }
  }
</style>
</head>
<body>
<header>
  <h1><span id="status-dot" class="off"></span>NANOCLAW <span>DASHBOARD</span></h1>
  <div class="meta">
    <span id="last-update"></span>
    &middot; auto-refresh 10s
  </div>
</header>

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

function channelIcon(ch) {
  const icons = { whatsapp: '💬', telegram: '✈️', gmail: '📧', outlook: '📮', discord: '🎮', slack: '🔷' };
  return icons[ch] || '📡';
}

function statusBadge(s) {
  if (s === 'active') return badge('active', 'green');
  if (s === 'paused') return badge('paused', 'orange');
  if (s === 'completed') return badge('done', 'blue');
  if (s === 'success') return badge('ok', 'green');
  if (s === 'error') return badge('err', 'red');
  return badge(s, 'purple');
}

function renderTopStats() {
  const d = data;
  const svc = d.service;
  document.getElementById('status-dot').className = svc.running ? 'on' : 'off';

  let html = '';
  // Service status
  html += '<div class="card"><h2>Service</h2>';
  html += '<div class="stat-row"><span>Status</span><span class="stat-value">' + (svc.running ? '🟢 Running' : '🔴 Stopped') + '</span></div>';
  if (svc.pid) html += '<div class="stat-row"><span>PID</span><span class="stat-value">' + svc.pid + '</span></div>';
  if (svc.uptime) html += '<div class="stat-row"><span>Uptime</span><span class="stat-value">' + svc.uptime + '</span></div>';
  html += '<div class="stat-row"><span>Containers</span><span class="stat-value">' + d.containers.length + ' / 5</span></div>';
  html += '</div>';

  // Channels & Integrations
  html += '<div class="card"><h2>Channels &amp; Integrations</h2>';
  if (d.channels.length === 0 && !d.notion) {
    html += '<div class="empty">No channels configured</div>';
  } else {
    d.channels.forEach(ch => {
      const icon = channelIcon(ch.name);
      const connBadge = ch.connected ? badge('connected', 'green') : badge('disconnected', 'red');
      const acct = ch.account ? '<br><span class="time-ago" style="font-size:11px">' + esc(ch.account) + '</span>' : '';
      html += '<div class="stat-row" style="align-items:flex-start"><span>' + icon + ' ' + esc(ch.name) + acct + '</span><span>' + connBadge + '</span></div>';
    });
    // Notion integration status
    if (d.notion) {
      const nConn = d.notion.connected ? badge('connected', 'green') : badge('disconnected', 'red');
      const nAcct = d.notion.account ? '<br><span class="time-ago" style="font-size:11px">' + esc(d.notion.account) + '</span>' : '';
      const nErr = (!d.notion.connected && d.notion.error) ? '<br><span class="time-ago" style="font-size:10px;color:var(--red)">' + esc(d.notion.error) + '</span>' : '';
      html += '<div class="stat-row" style="align-items:flex-start"><span>📝 notion' + nAcct + nErr + '</span><span>' + nConn + '</span></div>';
    }
  }
  html += '</div>';

  // Message stats
  html += '<div class="card"><h2>Messages</h2>';
  html += '<div class="stat-row"><span>Last hour</span><span class="stat-value">' + (d.messageStats.last_hour||0) + '</span></div>';
  html += '<div class="stat-row"><span>Last 24h</span><span class="stat-value">' + (d.messageStats.last_24h||0) + '</span></div>';
  html += '<div class="stat-row"><span>Last 7d</span><span class="stat-value">' + (d.messageStats.last_7d||0) + '</span></div>';
  html += '<div class="stat-row"><span>Total</span><span class="stat-value">' + (d.messageStats.total||0).toLocaleString() + '</span></div>';
  html += '</div>';

  // Hourly chart + channel breakdown
  html += '<div class="card"><h2>24h Activity</h2>';
  if (d.hourlyVolume.length > 0) {
    const max = Math.max(...d.hourlyVolume.map(h => h.count), 1);
    const hours = {};
    d.hourlyVolume.forEach(h => { hours[h.hour] = h.count; });
    html += '<div class="bar-chart">';
    for (let i = 0; i < 24; i++) {
      const h = String(i).padStart(2, '0');
      const c = hours[h] || 0;
      const pct = Math.max((c / max) * 100, 2);
      html += '<div class="bar" style="height:' + pct + '%" title="' + h + ':00 — ' + c + ' msgs"></div>';
    }
    html += '</div>';
    html += '<div class="bar-label"><span>00:00</span><span>12:00</span><span>23:00</span></div>';
  }
  if (d.channelStats.length > 0) {
    html += '<div class="channel-pills" style="margin-top:12px">';
    d.channelStats.forEach(cs => {
      html += '<div class="channel-pill">' + channelIcon(cs.channel) + ' ' + esc(cs.channel || 'unknown') + ' <span class="count">' + cs.count + '</span></div>';
    });
    html += '</div>';
  }
  html += '</div>';

  document.getElementById('top-stats').innerHTML = html;
}

function renderMain() {
  const d = data;
  let html = '';

  // Groups
  html += '<div class="card wide"><h2>Groups (' + d.groups.length + ')</h2>';
  if (d.groups.length === 0) {
    html += '<div class="empty">No registered groups</div>';
  } else {
    html += '<table><tr><th>Name</th><th>Folder</th><th>Channel</th><th>Trigger Required</th><th>Registered</th></tr>';
    d.groups.forEach(g => {
      const ch = g.jid.includes('@g.us') || g.jid.includes('@s.whatsapp') ? 'whatsapp'
        : g.jid.startsWith('tg:') ? 'telegram'
        : g.jid.startsWith('dc:') ? 'discord'
        : g.jid.startsWith('sl:') ? 'slack'
        : g.jid.includes('gmail') ? 'gmail'
        : g.jid.includes('outlook') ? 'outlook'
        : '—';
      const isMain = g.is_main ? ' ' + badge('main', 'purple') : '';
      const trigger = g.requires_trigger ? badge('yes', 'blue') : badge('no', 'green');
      html += '<tr><td>' + esc(g.name) + isMain + '</td><td><code>' + esc(g.folder) + '</code></td><td>' + channelIcon(ch) + ' ' + ch + '</td><td>' + trigger + '</td><td class="time-ago">' + timeAgo(g.added_at) + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div>';

  // Scheduled Tasks
  html += '<div class="card wide"><h2>Scheduled Tasks (' + d.tasks.length + ')</h2>';
  if (d.tasks.length === 0) {
    html += '<div class="empty">No scheduled tasks</div>';
  } else {
    html += '<table><tr><th style="width:40%">Task</th><th>Schedule</th><th>Group</th><th>Status</th><th>Next Run</th><th>Last Run</th></tr>';
    d.tasks.forEach(t => {
      // Extract a short label from the prompt (first sentence or first 80 chars)
      const raw = String(t.prompt || '');
      const label = raw.split(/[.!\\n]/)[0].substring(0, 80) + (raw.length > 80 ? '...' : '');
      const sched = esc(t.schedule_value);
      html += '<tr><td title="' + esc(raw) + '">' + esc(label) + '</td>';
      html += '<td><code>' + sched + '</code></td>';
      html += '<td>' + esc(t.group_folder) + '</td>';
      html += '<td>' + statusBadge(t.status) + '</td>';
      html += '<td class="time-ago">' + (t.next_run ? timeAgo(t.next_run) : '—') + '</td>';
      html += '<td class="time-ago">' + (t.last_run ? timeAgo(t.last_run) : 'never') + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div>';

  // Containers
  html += '<div class="card wide"><h2>Active Containers (' + d.containers.length + ')</h2>';
  if (d.containers.length === 0) {
    html += '<div class="empty">No running containers</div>';
  } else {
    html += '<table><tr><th>Name</th><th>Status</th><th>Created</th></tr>';
    d.containers.forEach(c => {
      html += '<tr><td>' + esc(c.name) + '</td><td>' + badge('running', 'green') + ' ' + esc(c.status) + '</td><td>' + esc(c.created) + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div>';

  // Recent Task Runs
  html += '<div class="card wide"><h2>Recent Task Runs</h2>';
  if (d.recentRuns.length === 0) {
    html += '<div class="empty">No task runs yet</div>';
  } else {
    html += '<table><tr><th>Time</th><th>Group</th><th>Prompt</th><th>Status</th><th>Duration</th><th>Error</th></tr>';
    d.recentRuns.forEach(r => {
      const dur = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '—';
      html += '<tr><td class="time-ago">' + timeAgo(r.run_at) + '</td>';
      html += '<td>' + esc(r.group_folder) + '</td>';
      html += '<td class="truncate" title="' + esc(r.prompt) + '">' + esc(r.prompt) + '</td>';
      html += '<td>' + statusBadge(r.status) + '</td>';
      html += '<td>' + dur + '</td>';
      html += '<td class="truncate">' + (r.error ? esc(r.error) : '—') + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div>';

  // Recent Chats
  html += '<div class="card wide"><h2>Recent Chats</h2>';
  if (d.chats.length === 0) {
    html += '<div class="empty">No chats yet</div>';
  } else {
    html += '<table><tr><th>Name</th><th>Channel</th><th>Type</th><th>Last Activity</th></tr>';
    d.chats.forEach(c => {
      const ch = c.channel || '—';
      const type = c.is_group ? badge('group', 'blue') : badge('dm', 'purple');
      html += '<tr><td>' + esc(c.name) + '</td><td>' + channelIcon(ch) + ' ' + ch + '</td><td>' + type + '</td><td class="time-ago">' + timeAgo(c.last_message_time) + '</td></tr>';
    });
    html += '</table>';
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
  console.log(`NanoClaw Dashboard: http://localhost:${PORT}`);
});
