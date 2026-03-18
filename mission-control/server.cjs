#!/usr/bin/env node
/**
 * Atlas Mission Control — CEO glance dashboard
 *
 * Server-rendered HTML, dark theme, auto-refreshes every 10s.
 * Reads from NanoClaw SQLite + Atlas state files.
 * No React, no build tooling — single file.
 *
 * Usage: node mission-control/server.cjs
 * Accessible at http://<host>:8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const PORT = process.env.MC_PORT || 8080;
const ATLAS_DIR = path.join(require('os').homedir(), '.atlas');
const NANOCLAW_DB = path.join(__dirname, '..', 'store', 'messages.db');

// ─── Basic Auth ──────────────────────────────────────────────────────────────

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

// ─── Utility ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

function relativeTime(iso) {
  if (!iso) return '\u2014';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const past = diff > 0;
  const mins = Math.floor(abs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return past ? `${hrs}h ago` : `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}

function truncate(str, len = 200) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '\u2026' : str;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// ─── Data Readers ────────────────────────────────────────────────────────────

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

function getMode() {
  const mode = readJson(path.join(ATLAS_DIR, 'state', 'mode.json'));
  return mode?.mode || mode?.status || 'unknown';
}

function getGraduationStatus() {
  const grad = readJson(path.join(ATLAS_DIR, 'autonomy', 'graduation-status.json'));
  if (!grad || !grad.milestones) {
    return {
      milestones: {
        M0: { name: 'Build complete', status: 'complete' },
        M1: { name: 'Tier 1 cron activated', status: 'locked' },
        M2: { name: 'Tier 1 LLM reasoning', status: 'locked' },
        M3: { name: 'Tier 2 fully autonomous', status: 'locked' },
        M4: { name: 'Tier 3 auto-drafting', status: 'locked' },
        M5: { name: 'Full v10 autonomy', status: 'locked' },
      }
    };
  }
  return grad;
}

function getQuotaToday() {
  const quotaFile = path.join(ATLAS_DIR, 'autonomy', 'quota-tracking.jsonl');
  const entries = readJsonl(quotaFile, 500);
  const today = todayISO();

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

  const maxQuota = 200;
  const pct = Math.round((weighted / maxQuota) * 100);
  const level = pct >= 90 ? 'PAUSED' : pct >= 60 ? 'THROTTLED' : 'NORMAL';
  return { total, autonomous, ceo, weighted: Math.round(weighted * 100) / 100, level, pct: Math.min(pct, 100) };
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

function getRegisteredGroups(db) {
  try {
    return db.prepare('SELECT jid, name, folder, trigger_pattern, requires_trigger, is_main FROM registered_groups').all();
  } catch { return []; }
}

function getScheduledTasks(db) {
  try {
    return db.prepare(`
      SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
             next_run, last_run, last_result, status, context_mode
      FROM scheduled_tasks
      ORDER BY status, next_run
    `).all();
  } catch { return []; }
}

function getRecentMessages(db, limit = 50) {
  const today = todayISO();
  try {
    return db.prepare(`
      SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content,
             m.timestamp, m.is_from_me, m.is_bot_message
      FROM messages m
      WHERE m.timestamp >= ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(today, limit);
  } catch { return []; }
}

function getHostTasks() {
  const completed = [];
  const pending = [];
  const completedDir = path.join(ATLAS_DIR, 'host-tasks', 'completed');
  const pendingDir = path.join(ATLAS_DIR, 'host-tasks', 'pending');

  try {
    if (fs.existsSync(completedDir)) {
      const files = fs.readdirSync(completedDir).filter(f => f.endsWith('.json'));
      for (const f of files.sort().reverse().slice(0, 10)) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(completedDir, f), 'utf-8'));
          completed.push(data);
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* dir missing */ }

  try {
    if (fs.existsSync(pendingDir)) {
      const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(pendingDir, f), 'utf-8'));
          pending.push(data);
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* dir missing */ }

  return { completed, pending };
}

function getSharedWorkspaceActivity() {
  const depts = ['marketing', 'operations', 'property-management', 'field-ops', 'executive'];
  const today = todayISO();
  const results = [];

  for (const dept of depts) {
    const deptDir = path.join(ATLAS_DIR, 'shared', dept);
    if (!fs.existsSync(deptDir)) continue;

    const activity = { dept, files: [], escalations: 0, totalToday: 0 };

    try {
      const subdirs = fs.readdirSync(deptDir, { withFileTypes: true });
      for (const entry of subdirs) {
        const subPath = path.join(deptDir, entry.name);
        if (entry.isDirectory()) {
          // Check for escalations
          if (entry.name === 'escalations') {
            try {
              const escFiles = fs.readdirSync(subPath);
              activity.escalations = escFiles.length;
            } catch { /* skip */ }
            continue;
          }
          // Check files modified today in subdirectory
          try {
            const files = fs.readdirSync(subPath);
            for (const file of files) {
              try {
                const stat = fs.statSync(path.join(subPath, file));
                if (stat.mtime.toISOString().startsWith(today)) {
                  activity.totalToday++;
                  if (activity.files.length < 5) {
                    // Strip date prefix for readability (e.g., 2026-03-18-filename.md -> filename.md)
                    const displayName = file.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '');
                    activity.files.push({ name: displayName || file, dir: entry.name });
                  }
                }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(subPath);
            if (stat.mtime.toISOString().startsWith(today)) {
              activity.totalToday++;
              if (activity.files.length < 5) {
                const displayName = entry.name.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '');
                activity.files.push({ name: displayName || entry.name, dir: dept });
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip entire dept */ }

    if (activity.totalToday > 0 || activity.escalations > 0) {
      results.push(activity);
    }
  }

  return results;
}

// ─── Department & Task Name Mapping ──────────────────────────────────────────

const FOLDER_DEPARTMENT_MAP = {
  'atlas_main': 'CEO Control',
  'atlas_gpg': 'GPG Entity',
  'atlas_crownscape': 'Crownscape Entity',
  'telegram_atlas-marketing': 'Marketing Dept',
};

function folderToDepartment(folder) {
  if (FOLDER_DEPARTMENT_MAP[folder]) return FOLDER_DEPARTMENT_MAP[folder];
  // Derive from folder name: telegram_atlas-ops -> Atlas Ops
  const clean = folder.replace(/^telegram_/, '').replace(/^atlas[_-]/, '').replace(/[-_]/g, ' ');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

const TASK_FRIENDLY_NAMES = {
  'atlas-orchestrator-daily': 'Morning Briefing (6AM)',
  'atlas-marketing-weekly': 'Marketing Weekly Report',
  'atlas-ops-daily': 'Operations Daily Check',
};

function taskFriendlyName(taskId) {
  return TASK_FRIENDLY_NAMES[taskId] || taskId;
}

function scheduleHuman(type, value) {
  if (type === 'cron') {
    // Basic cron parsing for common patterns
    const parts = value.split(' ');
    if (parts.length >= 5) {
      const [min, hour] = parts;
      if (hour !== '*' && min !== '*') {
        const h = parseInt(hour);
        const m = parseInt(min);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `Daily at ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
      }
    }
    return `Cron: ${value}`;
  }
  if (type === 'interval') return `Every ${value}`;
  return `${type}: ${value}`;
}

// ─── HTML Rendering ──────────────────────────────────────────────────────────

function badge(text, color) {
  return `<span style="display:inline-block;background:${color};color:#fff;padding:2px 10px;border-radius:4px;font-size:12px;font-weight:600;letter-spacing:0.3px">${esc(text)}</span>`;
}

function statusBadge(status) {
  const colors = {
    active: '#22c55e', complete: '#22c55e', success: '#22c55e', NORMAL: '#22c55e',
    pending: '#3b82f6', in_progress: '#3b82f6', 'in-progress': '#3b82f6',
    paused: '#f59e0b', THROTTLED: '#f59e0b', warning: '#f59e0b',
    error: '#ef4444', failed: '#ef4444', PAUSED: '#ef4444',
    locked: '#6b7280', completed: '#6b7280', unknown: '#6b7280',
  };
  const color = colors[status] || '#6b7280';
  return badge(String(status).toUpperCase(), color);
}

function progressBar(pct, color, height = 12) {
  const clamped = Math.max(0, Math.min(100, pct));
  return `<div style="height:${height}px;background:#334155;border-radius:${height / 2}px;overflow:hidden;flex:1">
    <div style="height:100%;width:${clamped}%;background:${color};border-radius:${height / 2}px;transition:width 0.3s"></div>
  </div>`;
}

function renderConversations(messages, groups) {
  if (!messages.length) {
    return `<div style="color:#6b7280;padding:16px;text-align:center">No activity today</div>`;
  }

  // Build JID -> group name map
  const jidMap = {};
  for (const g of groups) {
    jidMap[g.jid] = g.name;
  }

  // Group messages by chat_jid, keeping order
  const grouped = {};
  const order = [];
  for (const msg of messages) {
    if (!grouped[msg.chat_jid]) {
      grouped[msg.chat_jid] = [];
      order.push(msg.chat_jid);
    }
    grouped[msg.chat_jid].push(msg);
  }

  // Build conversation pairs within each group
  const groupColors = ['#1e293b', '#172033'];
  let html = '';

  for (let gi = 0; gi < order.length; gi++) {
    const jid = order[gi];
    const msgs = grouped[jid];
    const groupName = jidMap[jid] || jid.split('@')[0] || 'Unknown';
    const bgColor = groupColors[gi % 2];

    html += `<div style="background:${bgColor};border-radius:8px;padding:12px 16px;margin-bottom:8px">`;
    html += `<div style="font-weight:700;color:#e2e8f0;margin-bottom:8px;font-size:14px">${esc(groupName)}</div>`;

    // Show messages in chronological order (reverse since they come DESC)
    const chronological = [...msgs].reverse();

    for (const msg of chronological) {
      const isUser = msg.is_from_me === 0 && msg.is_bot_message === 0;
      const isAtlas = msg.is_from_me === 1;

      if (!isUser && !isAtlas) continue; // skip system messages

      const senderLabel = isUser ? (msg.sender_name || 'User') : 'Atlas';
      const senderColor = isUser ? '#3b82f6' : '#22c55e';
      const content = truncate(msg.content || '', 200);
      const time = relativeTime(msg.timestamp);

      html += `<div style="margin-bottom:6px;display:flex;gap:8px;align-items:flex-start">`;
      html += `<span style="color:${senderColor};font-weight:600;font-size:12px;min-width:60px;flex-shrink:0">${esc(senderLabel)}</span>`;
      html += `<span style="color:#cbd5e1;font-size:13px;flex:1">${esc(content)}</span>`;
      html += `<span style="color:#64748b;font-size:11px;flex-shrink:0;white-space:nowrap">${esc(time)}</span>`;
      html += `</div>`;
    }

    html += `</div>`;
  }

  return html;
}

function renderGraduationProgress(graduation) {
  const milestones = graduation.milestones || {};
  let html = '';

  for (const [key, m] of Object.entries(milestones)) {
    let pct = 0;
    let color = '#6b7280';
    let detail = '';

    if (m.status === 'complete') {
      pct = 100;
      color = '#22c55e';
      detail = m.met_at ? `Completed ${relativeTime(m.met_at)}` : 'Complete';
    } else if (m.status === 'pending' || m.status === 'in_progress') {
      color = '#3b82f6';
      const prog = m.progress || {};
      // Figure out progress percentage from available fields
      if (prog.required_sessions) {
        pct = Math.round((prog.instrumented_sessions / prog.required_sessions) * 100);
        const entitiesNeeded = prog.required_entities || 2;
        const entitiesHave = prog.entities_seen?.length || 0;
        detail = `Sessions: ${prog.instrumented_sessions}/${prog.required_sessions}, Entities: ${entitiesHave}/${entitiesNeeded}`;
      } else if (prog.required !== undefined) {
        const current = prog.consecutive_clean_runs ?? prog.total_cycles ?? 0;
        pct = Math.round((current / prog.required) * 100);
        detail = `${current}/${prog.required}`;
      } else if (prog.required_actions) {
        pct = Math.round((prog.total_actions / prog.required_actions) * 100);
        detail = `Actions: ${prog.total_actions}/${prog.required_actions}, Override: ${Math.round(prog.override_rate * 100)}%`;
      } else if (prog.required_drafts) {
        pct = Math.round((prog.total_drafts / prog.required_drafts) * 100);
        detail = `Drafts: ${prog.total_drafts}/${prog.required_drafts}, Approval: ${Math.round(prog.approve_rate * 100)}%`;
      }
    } else {
      // locked
      pct = 0;
      color = '#6b7280';
      detail = 'Locked';
    }

    html += `<div style="margin-bottom:12px">`;
    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">`;
    html += `<span style="font-weight:600;font-size:13px;color:#e2e8f0">${esc(key)}: ${esc(m.name || '')}</span>`;
    html += `<span style="font-size:12px;color:#94a3b8">${esc(detail)}</span>`;
    html += `</div>`;
    html += progressBar(pct, color, 10);
    html += `</div>`;
  }

  return html;
}

function renderHostTasks(hostData) {
  const { completed, pending } = hostData;

  if (!completed.length && !pending.length) {
    return `<div style="color:#6b7280;padding:16px;text-align:center">No host-executor tasks</div>`;
  }

  let html = '<table><thead><tr><th>Task</th><th>Entity</th><th>Status</th><th>When</th></tr></thead><tbody>';

  for (const t of pending) {
    const desc = truncate(t.prompt || t.description || t.task_id || 'Unknown task', 80);
    html += `<tr>`;
    html += `<td style="font-size:13px">${esc(desc)}</td>`;
    html += `<td>${esc(t.entity || '\u2014')}</td>`;
    html += `<td>${statusBadge('in_progress')}</td>`;
    html += `<td>${relativeTime(t.created_at)}</td>`;
    html += `</tr>`;
  }

  for (const t of completed) {
    const desc = truncate(t.prompt || t.description || t.task_id || 'Unknown task', 80);
    const status = t.status || (t.error ? 'failed' : 'success');
    html += `<tr>`;
    html += `<td style="font-size:13px">${esc(desc)}</td>`;
    html += `<td>${esc(t.entity || '\u2014')}</td>`;
    html += `<td>${statusBadge(status)}</td>`;
    html += `<td>${relativeTime(t.completed_at)}</td>`;
    html += `</tr>`;
  }

  html += '</tbody></table>';
  return html;
}

function renderSharedWorkspace(workspaceData) {
  if (!workspaceData.length) {
    return `<div style="color:#6b7280;padding:16px;text-align:center">No workspace activity today</div>`;
  }

  let html = '';

  for (const dept of workspaceData) {
    const deptLabel = dept.dept.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    html += `<div style="margin-bottom:12px;padding:10px 14px;background:#0f172a;border-radius:6px">`;
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">`;
    html += `<span style="font-weight:700;font-size:14px;color:#e2e8f0">${esc(deptLabel)}</span>`;
    html += `<span style="color:#94a3b8;font-size:12px">${dept.totalToday} file${dept.totalToday !== 1 ? 's' : ''} today</span>`;
    if (dept.escalations > 0) {
      html += badge(`${dept.escalations} ESCALATION${dept.escalations !== 1 ? 'S' : ''}`, '#ef4444');
    }
    html += `</div>`;

    if (dept.files.length > 0) {
      html += `<div style="padding-left:8px">`;
      for (const file of dept.files) {
        html += `<div style="font-size:12px;color:#94a3b8;margin-bottom:2px">`;
        html += `<span style="color:#64748b">${esc(file.dir)}/</span>${esc(file.name)}`;
        html += `</div>`;
      }
      if (dept.totalToday > dept.files.length) {
        html += `<div style="font-size:11px;color:#64748b">+${dept.totalToday - dept.files.length} more</div>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
  }

  return html;
}

function renderScheduledTasks(tasks) {
  if (!tasks.length) {
    return `<div style="color:#6b7280;padding:16px;text-align:center">No scheduled tasks</div>`;
  }

  let html = '<table><thead><tr><th>Task</th><th>Schedule</th><th>Status</th><th>Next Run</th><th>Last Run</th><th>Last Result</th></tr></thead><tbody>';

  for (const t of tasks) {
    const name = taskFriendlyName(t.id);
    const schedule = scheduleHuman(t.schedule_type, t.schedule_value);
    const lastResult = t.last_result ? truncate(t.last_result, 40) : '\u2014';

    html += `<tr>`;
    html += `<td style="font-weight:600;font-size:13px">${esc(name)}</td>`;
    html += `<td style="font-size:12px;color:#94a3b8">${esc(schedule)}</td>`;
    html += `<td>${statusBadge(t.status)}</td>`;
    html += `<td style="font-size:12px">${relativeTime(t.next_run)}</td>`;
    html += `<td style="font-size:12px">${relativeTime(t.last_run)}</td>`;
    html += `<td style="font-size:12px;color:#94a3b8">${esc(lastResult)}</td>`;
    html += `</tr>`;
  }

  html += '</tbody></table>';
  return html;
}

function renderRegisteredGroups(groups) {
  if (!groups.length) {
    return `<div style="color:#6b7280;padding:16px;text-align:center">No registered groups</div>`;
  }

  let html = '<table><thead><tr><th>Group</th><th>Department</th><th>Trigger</th><th>JID</th></tr></thead><tbody>';

  for (const g of groups) {
    const dept = folderToDepartment(g.folder);
    const triggerMode = g.requires_trigger === 0 ? 'Always' : 'On Mention';
    const mainBadge = g.is_main ? ` ${badge('MAIN', '#3b82f6')}` : '';

    html += `<tr>`;
    html += `<td style="font-weight:600">${esc(g.name)}${mainBadge}</td>`;
    html += `<td style="font-size:12px;color:#94a3b8">${esc(dept)}</td>`;
    html += `<td>${badge(triggerMode, triggerMode === 'Always' ? '#22c55e' : '#6b7280')}</td>`;
    html += `<td style="font-size:11px;color:#64748b;font-family:monospace">${esc(g.jid)}</td>`;
    html += `</tr>`;
  }

  html += '</tbody></table>';
  return html;
}

// ─── Page Assembly ───────────────────────────────────────────────────────────

function renderPage(data) {
  const {
    mode, containers, quota, graduation, messages, groups,
    scheduledTasks, hostTasks, approvals, workspaceActivity
  } = data;

  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  // Quota bar color
  const quotaColor = quota.level === 'NORMAL' ? '#22c55e' : quota.level === 'THROTTLED' ? '#f59e0b' : '#ef4444';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="10">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Atlas Mission Control</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 24px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .header h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .header .time {
      color: #94a3b8;
      font-size: 13px;
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    @media (max-width: 900px) {
      .stats-row { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 600px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
    }
    .stat-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .stat-card .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #64748b;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .stat-card .value {
      font-size: 26px;
      font-weight: 700;
    }
    .stat-card .sub {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 4px;
    }

    .section {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 16px;
    }
    .section h2 {
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #94a3b8;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #334155;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      padding: 8px 10px;
      color: #64748b;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      border-bottom: 1px solid #334155;
    }
    td {
      padding: 8px 10px;
      border-bottom: 1px solid #1e293b;
      color: #cbd5e1;
    }
    tr:hover td {
      background: rgba(51, 65, 85, 0.5);
    }

    .quota-bar {
      height: 8px;
      background: #334155;
      border-radius: 4px;
      margin-top: 6px;
      overflow: hidden;
    }
    .quota-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Atlas Mission Control</h1>
    <div class="time">${esc(now)} ET</div>
  </div>

  <!-- ═══ TOP STATS ROW ═══ -->
  <div class="stats-row">
    <div class="stat-card">
      <div class="label">Mode</div>
      <div class="value">${statusBadge(mode)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Active Containers</div>
      <div class="value">${containers.length}</div>
      <div class="sub">${containers.map(c => esc(c.name)).join(', ') || 'none'}</div>
    </div>
    <div class="stat-card">
      <div class="label">Today's Sessions</div>
      <div class="value">${quota.total}</div>
      <div class="sub">${quota.autonomous} autonomous + ${quota.ceo} CEO</div>
    </div>
    <div class="stat-card">
      <div class="label">Quota</div>
      <div class="value" style="color:${quotaColor}">${quota.pct}%</div>
      <div class="quota-bar">
        <div class="quota-fill" style="width:${quota.pct}%;background:${quotaColor}"></div>
      </div>
      <div class="sub">${statusBadge(quota.level)} ${quota.weighted} / 200 weighted</div>
    </div>
    <div class="stat-card">
      <div class="label">Pending Approvals</div>
      <div class="value" style="color:${approvals.length > 0 ? '#f59e0b' : '#e2e8f0'}">${approvals.length}</div>
      <div class="sub">${approvals.length > 0 ? 'action needed' : 'clear'}</div>
    </div>
  </div>

  <!-- ═══ TODAY'S ACTIVITY ═══ -->
  <div class="section">
    <h2>Today's Activity</h2>
    ${renderConversations(messages, groups)}
  </div>

  <!-- ═══ SHARED WORKSPACE ACTIVITY ═══ -->
  <div class="section">
    <h2>Shared Workspace Activity</h2>
    ${renderSharedWorkspace(workspaceActivity)}
  </div>

  <!-- ═══ GRADUATION PROGRESS ═══ -->
  <div class="section">
    <h2>Graduation Progress</h2>
    ${renderGraduationProgress(graduation)}
  </div>

  <!-- ═══ HOST-EXECUTOR RESULTS ═══ -->
  <div class="section">
    <h2>Host-Executor Results</h2>
    ${renderHostTasks(hostTasks)}
  </div>

  <!-- ═══ SCHEDULED TASKS ═══ -->
  <div class="section">
    <h2>Scheduled Tasks</h2>
    ${renderScheduledTasks(scheduledTasks)}
  </div>

  <!-- ═══ REGISTERED GROUPS ═══ -->
  <div class="section">
    <h2>Registered Groups</h2>
    ${renderRegisteredGroups(groups)}
  </div>

</body>
</html>`;
}

// ─── Server ──────────────────────────────────────────────────────────────────

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
    const groups = getRegisteredGroups(db);

    const data = {
      mode: getMode(),
      containers: getActiveContainers(),
      quota: getQuotaToday(),
      graduation: getGraduationStatus(),
      messages: getRecentMessages(db, 50),
      groups,
      scheduledTasks: getScheduledTasks(db),
      hostTasks: getHostTasks(),
      approvals: getApprovalQueue(),
      workspaceActivity: getSharedWorkspaceActivity(),
    };

    const html = renderPage(data);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500);
    res.end(`Render error: ${err.message}\n${err.stack}`);
  } finally {
    db.close();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Atlas Mission Control running at http://0.0.0.0:${PORT}`);
  console.log(`  Auth: ${AUTH_ENABLED ? 'enabled' : 'DISABLED - set MISSION_CONTROL_USER and MISSION_CONTROL_PASS in .env'}`);
  console.log(`  Database: ${NANOCLAW_DB}`);
  console.log(`  Atlas dir: ${ATLAS_DIR}`);
});
