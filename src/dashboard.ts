import http from 'http';

import { ASSISTANT_NAME } from './config.js';
import { getAllRegisteredGroups, getAllTasks } from './db.js';
import { logger } from './logger.js';
import { TeamManager } from './team-manager.js';

const DASHBOARD_PORT = 3456;

interface DashboardDeps {
  getWhatsAppStatus: () => boolean;
  startedAt: number;
  teamManager?: TeamManager;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function gatherData(deps: DashboardDeps) {
  const groups = getAllRegisteredGroups();
  const tasks = getAllTasks();
  const teamData = deps.teamManager?.getAllTeamData() || [];

  return {
    uptime: formatUptime(Date.now() - deps.startedAt),
    startedAt: new Date(deps.startedAt).toISOString(),
    whatsappConnected: deps.getWhatsAppStatus(),
    registeredGroups: Object.entries(groups).map(([jid, g]: [string, any]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      trigger: g.trigger,
      requiresTrigger: g.requiresTrigger,
    })),
    scheduledTasks: tasks.map((t: any) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt.length > 80 ? t.prompt.slice(0, 80) + '...' : t.prompt,
      scheduleType: t.schedule_type,
      scheduleValue: t.schedule_value,
      status: t.status,
      nextRun: t.next_run,
      lastRun: t.last_run,
    })),
    teams: teamData,
  };
}

function renderHtml(deps: DashboardDeps): string {
  const data = gatherData(deps);

  const groupRows = data.registeredGroups
    .map(
      (g: any) =>
        `<tr><td>${esc(g.name)}</td><td><code>${esc(g.folder)}</code></td><td><code>${esc(g.trigger)}</code></td><td>${g.requiresTrigger === false ? 'No' : 'Yes'}</td></tr>`,
    )
    .join('');

  const taskRows = data.scheduledTasks
    .map(
      (t: any) =>
        `<tr><td><code>${esc(t.id.slice(0, 8))}</code></td><td>${esc(t.groupFolder)}</td><td>${esc(t.prompt)}</td><td>${esc(t.scheduleType)}: ${esc(t.scheduleValue)}</td><td><span class="badge ${t.status}">${t.status}</span></td><td>${t.nextRun ? esc(t.nextRun) : '-'}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${esc(ASSISTANT_NAME)} Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:1.5rem;max-width:1200px;margin:0 auto}
h1{font-size:1.5rem;margin-bottom:1rem;color:#f8fafc}
h2{font-size:1.1rem;margin:1.5rem 0 .75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;font-weight:500}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin-bottom:1rem}
.card{background:#1e293b;border-radius:8px;padding:1rem}
.card .label{font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em}
.card .value{font-size:1.5rem;font-weight:600;margin-top:.25rem}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.green{background:#22c55e}
.dot.red{background:#ef4444}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;margin-bottom:.5rem}
th{text-align:left;padding:.5rem .75rem;background:#334155;color:#94a3b8;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;font-weight:500}
td{padding:.5rem .75rem;border-top:1px solid #334155;font-size:.85rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
code{background:#334155;padding:1px 4px;border-radius:3px;font-size:.8rem}
.badge{padding:2px 8px;border-radius:10px;font-size:.75rem;font-weight:500}
.badge.active{background:#166534;color:#86efac}
.badge.paused{background:#713f12;color:#fde047}
.badge.completed{background:#1e3a5f;color:#7dd3fc}
.empty{color:#475569;padding:1rem;text-align:center;font-size:.85rem}
footer{margin-top:2rem;text-align:center;color:#475569;font-size:.75rem}
</style>
</head>
<body>
<h1>${esc(ASSISTANT_NAME)} Dashboard</h1>

<div class="cards">
  <div class="card">
    <div class="label">Uptime</div>
    <div class="value">${esc(data.uptime)}</div>
  </div>
  <div class="card">
    <div class="label">WhatsApp</div>
    <div class="value"><span class="dot ${data.whatsappConnected ? 'green' : 'red'}"></span>${data.whatsappConnected ? 'Connected' : 'Disconnected'}</div>
  </div>
  <div class="card">
    <div class="label">Groups</div>
    <div class="value">${data.registeredGroups.length}</div>
  </div>
  <div class="card">
    <div class="label">Tasks</div>
    <div class="value">${data.scheduledTasks.filter((t: any) => t.status === 'active').length}</div>
  </div>
  <div class="card">
    <div class="label">Teams</div>
    <div class="value"><a href="/teams" style="color:inherit;text-decoration:none">${data.teams.length}</a></div>
  </div>
  <div class="card">
    <div class="label">Team Members</div>
    <div class="value"><a href="/teams" style="color:inherit;text-decoration:none">${data.teams.reduce((sum: number, t: any) => sum + t.memberCount, 0)}</a></div>
  </div>
</div>

<h2>Registered Groups</h2>
${
  groupRows
    ? `<table><thead><tr><th>Name</th><th>Folder</th><th>Trigger</th><th>Requires Trigger</th></tr></thead><tbody>${groupRows}</tbody></table>`
    : '<div class="empty">No groups registered</div>'
}

<h2>Scheduled Tasks</h2>
${
  taskRows
    ? `<table><thead><tr><th>ID</th><th>Group</th><th>Prompt</th><th>Schedule</th><th>Status</th><th>Next Run</th></tr></thead><tbody>${taskRows}</tbody></table>`
    : '<div class="empty">No scheduled tasks</div>'
}

<footer>Auto-refreshes every 30s &middot; <a href="/teams" style="color:#64748b">Teams</a> &middot; <a href="/api/status" style="color:#64748b">JSON API</a></footer>
</body>
</html>`;
}

function renderTeamsHtml(deps: DashboardDeps): string {
  const teamData = deps.teamManager?.getAllTeamData() || [];

  const teamSections = teamData.map((team) => {
    const memberRows = team.members.map((m) => {
      const msgBadge = m.unreadCount > 0
        ? `<span class="badge active">${m.unreadCount} new</span>`
        : m.totalMessages > 0
          ? `<span class="msg-count">${m.totalMessages} msgs</span>`
          : '<span class="msg-count idle">idle</span>';

      const lastAct = m.lastActivity
        ? esc(m.lastActivity.replace('T', ' ').slice(0, 16))
        : '-';

      const roleBadge = m.agentType === 'team-lead'
        ? '<span class="badge role-lead">Team Lead</span>'
        : '<span class="badge role-analyst">Analyst</span>';

      return `<tr>
        <td><span class="color-dot" style="background:${esc(m.color || '#64748b')}"></span> ${esc(m.name)}</td>
        <td><code>${esc(m.model)}</code></td>
        <td>${roleBadge}</td>
        <td>${msgBadge}</td>
        <td>${lastAct}</td>
      </tr>`;
    }).join('');

    const messageRows = team.recentMessages.map((msg) => {
      const readIcon = msg.read ? '' : '<span class="unread-dot"></span>';
      return `<tr>
        <td>${readIcon}${esc(msg.from)}</td>
        <td>${esc(msg.to)}</td>
        <td title="${esc(msg.summary)}">${esc(msg.summary)}</td>
        <td>${esc(msg.timestamp.replace('T', ' ').slice(0, 16))}</td>
      </tr>`;
    }).join('');

    const createdDate = team.createdAt
      ? new Date(team.createdAt).toISOString().slice(0, 10)
      : '-';

    return `<div class="team-section">
  <div class="team-header">
    <h2>${esc(team.name)}</h2>
    <span class="team-meta">Created: ${esc(createdDate)} | Members: ${team.memberCount}</span>
  </div>
  <p class="team-desc">${esc(team.description || '')}</p>
  <table>
    <thead><tr><th>Member</th><th>Model</th><th>Role</th><th>Inbox</th><th>Last Activity</th></tr></thead>
    <tbody>${memberRows}</tbody>
  </table>
  ${messageRows ? `
  <h3>Recent Messages</h3>
  <table>
    <thead><tr><th>From</th><th>To</th><th>Summary</th><th>Time</th></tr></thead>
    <tbody>${messageRows}</tbody>
  </table>` : '<div class="empty">No messages yet</div>'}
</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${esc(ASSISTANT_NAME)} — Team Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:1.5rem;max-width:1200px;margin:0 auto}
h1{font-size:1.5rem;margin-bottom:1rem;color:#f8fafc}
h2{font-size:1.1rem;color:#f8fafc;margin:0}
h3{font-size:.9rem;color:#94a3b8;margin:1rem 0 .5rem;text-transform:uppercase;letter-spacing:.05em;font-weight:500}
a{color:#60a5fa;text-decoration:none}
a:hover{text-decoration:underline}
.top-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem}
.team-section{background:#1e293b;border-radius:8px;padding:1.25rem;margin-bottom:1rem}
.team-header{display:flex;align-items:center;gap:1rem;margin-bottom:.5rem}
.team-meta{font-size:.75rem;color:#64748b}
.team-desc{font-size:.85rem;color:#94a3b8;margin-bottom:1rem}
table{width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;margin-bottom:.5rem}
th{text-align:left;padding:.5rem .75rem;background:#334155;color:#94a3b8;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;font-weight:500}
td{padding:.5rem .75rem;border-top:1px solid #334155;font-size:.85rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
code{background:#334155;padding:1px 4px;border-radius:3px;font-size:.8rem}
.badge{padding:2px 8px;border-radius:10px;font-size:.75rem;font-weight:500}
.badge.active{background:#166534;color:#86efac}
.badge.role-lead{background:#1e3a5f;color:#7dd3fc}
.badge.role-analyst{background:#3b0764;color:#d8b4fe}
.color-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.msg-count{font-size:.8rem;color:#64748b}
.msg-count.idle{color:#475569;font-style:italic}
.unread-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#22c55e;margin-right:4px;vertical-align:middle}
.empty{color:#475569;padding:1rem;text-align:center;font-size:.85rem}
footer{margin-top:2rem;text-align:center;color:#475569;font-size:.75rem}
</style>
</head>
<body>
<div class="top-bar">
  <h1>${esc(ASSISTANT_NAME)} Team Dashboard</h1>
  <a href="/">&larr; Back to Main</a>
</div>

${teamSections || '<div class="empty">No teams configured</div>'}

<footer>Auto-refreshes every 30s &middot; <a href="/" style="color:#64748b">Main Dashboard</a> &middot; <a href="/api/teams" style="color:#64748b">Teams JSON API</a></footer>
</body>
</html>`;
}

export function startDashboard(deps: DashboardDeps): void {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/api/status') {
      const data = gatherData(deps);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === '/api/teams') {
      const teamData = deps.teamManager?.getAllTeamData() || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(teamData));
      return;
    }

    if (url.pathname === '/') {
      const html = renderHtml(deps);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname === '/teams') {
      try {
        const html = renderTeamsHtml(deps);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        logger.error({ err }, 'Failed to render teams page');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard started (localhost only)');
  });
}
