#!/usr/bin/env node
/**
 * Atlas Mission Control v2 — CEO glance dashboard
 *
 * Server-rendered HTML, dark theme, auto-refreshes every 10s.
 * Reads from NanoClaw SQLite + Atlas state files.
 * No React, no build tooling — single file.
 *
 * Redesigned for a CEO who glances at it for 10 seconds:
 * - Shows WHAT was asked and WHAT Atlas did, not UUIDs
 * - Conversation pairs with status icons
 * - Escalations prominently visible
 * - Graduation as visual progress bars with locked state
 */

// Force Eastern time for all date operations — Atlas standard timezone
process.env.TZ = 'America/New_York';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const PORT = process.env.MC_PORT || 8080;
const ATLAS_DIR = path.join(require('os').homedir(), '.atlas');
const NANOCLAW_DB = path.join(__dirname, '..', 'store', 'messages.db');

// --- Basic Auth ---------------------------------------------------------------

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
    } catch { /* no .env -- auth disabled */ }
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

// --- Utility ------------------------------------------------------------------

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

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
    });
  } catch { return ''; }
}

function truncate(str, len = 200) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '\u2026' : str;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// --- Data Readers -------------------------------------------------------------

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
  const modeFile = readJson(path.join(ATLAS_DIR, 'state', 'mode.json'));
  if (!modeFile) return 'active';
  return modeFile.mode || modeFile.status || 'unknown';
}

function getGraduationStatus() {
  // Check multiple locations for graduation data
  const paths = [
    path.join(ATLAS_DIR, 'autonomy', 'graduation-status.json'),
    path.join(__dirname, '..', 'data', 'graduation-status.json'),
  ];

  for (const p of paths) {
    const grad = readJson(p);
    if (grad?.milestones) return grad;
  }

  return null;
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

function getRecentMessages(db, limit = 100) {
  // Last 24 hours, not just today -- CEO may check in the morning
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    return db.prepare(`
      SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content,
             m.timestamp, m.is_from_me, m.is_bot_message
      FROM messages m
      WHERE m.timestamp >= ? AND m.content IS NOT NULL AND m.content != ''
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(cutoff, limit);
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
          completed.push(JSON.parse(fs.readFileSync(path.join(completedDir, f), 'utf-8')));
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* dir missing */ }

  try {
    if (fs.existsSync(pendingDir)) {
      const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          pending.push(JSON.parse(fs.readFileSync(path.join(pendingDir, f), 'utf-8')));
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

    const activity = { dept, files: [], escalations: [], totalToday: 0 };

    try {
      const subdirs = fs.readdirSync(deptDir, { withFileTypes: true });
      for (const entry of subdirs) {
        const subPath = path.join(deptDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'escalations') {
            try {
              const escFiles = fs.readdirSync(subPath).filter(f => f.endsWith('.md'));
              for (const ef of escFiles) {
                try {
                  const content = fs.readFileSync(path.join(subPath, ef), 'utf-8');
                  const title = content.split('\n').find(l => l.startsWith('# '))?.slice(2).trim()
                    || ef.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '');
                  activity.escalations.push({ file: ef, title });
                } catch { activity.escalations.push({ file: ef, title: ef }); }
              }
            } catch { /* skip */ }
            continue;
          }
          try {
            const files = fs.readdirSync(subPath);
            for (const file of files) {
              try {
                const stat = fs.statSync(path.join(subPath, file));
                if (stat.mtime.toISOString().startsWith(today)) {
                  activity.totalToday++;
                  if (activity.files.length < 5) {
                    const displayName = file.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '');
                    activity.files.push({ name: displayName || file, dir: entry.name });
                  }
                }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip entire dept */ }

    if (activity.totalToday > 0 || activity.escalations.length > 0) {
      results.push(activity);
    }
  }

  return results;
}

// --- Rendering ----------------------------------------------------------------

function badge(text, color) {
  return `<span class="badge" style="background:${color}">${esc(text)}</span>`;
}

function statusBadge(status) {
  const colors = {
    active: '#22c55e', operational: '#22c55e', complete: '#22c55e', success: '#22c55e', NORMAL: '#22c55e',
    pending: '#3b82f6', in_progress: '#3b82f6',
    paused: '#f59e0b', THROTTLED: '#f59e0b', warning: '#f59e0b',
    error: '#ef4444', failed: '#ef4444', PAUSED: '#ef4444',
    locked: '#475569', completed: '#6b7280', unknown: '#6b7280',
  };
  const color = colors[status] || '#6b7280';
  return badge(String(status).toUpperCase(), color);
}

function progressBar(pct, color) {
  const clamped = Math.max(0, Math.min(100, pct));
  return `<div class="progress-track"><div class="progress-fill" style="width:${clamped}%;background:${color}"></div></div>`;
}

/** Strip @Atlas @atlas_gpg_bot and other trigger prefixes from displayed messages */
function cleanContent(content) {
  if (!content) return '';
  return content
    .replace(/@Atlas\s*/gi, '')
    .replace(/@atlas_gpg_bot\s*/gi, '')
    .replace(/@atlas_\w+_bot\s*/gi, '')
    .trim();
}

/** Format timestamp with date context: "Today 5:42 PM" or "Yesterday 3:15 PM" or "Mar 17 2:00 PM" */
function formatTimeWithDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const opts = { timeZone: 'America/New_York' };
    const msgDate = d.toLocaleDateString('en-US', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' });
    const nowDate = now.toLocaleDateString('en-US', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' });

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yestDate = yesterday.toLocaleDateString('en-US', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' });

    const time = d.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit', hour12: true });

    if (msgDate === nowDate) return time;
    if (msgDate === yestDate) return `Yesterday ${time}`;
    return d.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' }) + ' ' + time;
  } catch { return ''; }
}

function renderConversations(messages, groups) {
  if (!messages.length) {
    return `<div class="empty">No conversations in the last 24 hours</div>`;
  }

  // Build JID -> group name map
  const jidMap = {};
  for (const g of groups) jidMap[g.jid] = g.name;

  // Show messages in reverse chronological order (most recent first)
  // Group consecutive messages from the same chat for readability
  const NOW = Date.now();
  const FIVE_MINUTES = 5 * 60 * 1000;
  let html = '';
  let pairCount = 0;
  const MAX_PAIRS = 12;
  let lastJid = null;

  for (const msg of messages) {
    if (pairCount >= MAX_PAIRS) break;

    const isUser = msg.is_from_me === 0 && msg.is_bot_message === 0;
    const isAtlas = msg.is_from_me === 1 || msg.is_bot_message === 1;

    // Skip bot messages in the main loop — they'll be shown as responses
    if (isAtlas) continue;
    if (!isUser) continue;

    // Find Atlas response (look for the next bot message after this one chronologically)
    let response = null;
    for (const r of messages) {
      if ((r.is_from_me === 1 || r.is_bot_message === 1) &&
          r.chat_jid === msg.chat_jid &&
          r.timestamp > msg.timestamp) {
        // Check that this response is close in time (within 10 min)
        const gap = new Date(r.timestamp).getTime() - new Date(msg.timestamp).getTime();
        if (gap < 600_000) { response = r; }
        break;
      }
    }

    const groupName = jidMap[msg.chat_jid] || msg.chat_jid.split('@')[0] || 'Unknown';
    const time = formatTimeWithDate(msg.timestamp);
    const sender = msg.sender_name || 'User';
    const question = truncate(cleanContent(msg.content), 120);
    const msgAge = NOW - new Date(msg.timestamp).getTime();

    // Build response line
    let icon, responseText, responseClass;
    if (response?.content) {
      responseText = truncate(cleanContent(response.content), 150);
      const lower = response.content.toLowerCase();
      if (lower.includes('escalat')) { icon = '\u26A0\uFE0F'; responseClass = ''; }
      else if (lower.includes('draft') || lower.includes('saved to workspace')) { icon = '\uD83D\uDCC4'; responseClass = ''; }
      else if (lower.includes('error') || lower.includes('failed') || lower.includes('denied')) { icon = '\u274C'; responseClass = ''; }
      else { icon = '\u2705'; responseClass = ''; }
    } else if (msgAge < FIVE_MINUTES) {
      icon = '\u23F3';
      responseText = 'Processing\u2026';
      responseClass = '';
    } else {
      icon = '\u2014';
      responseText = 'No response';
      responseClass = ' style="opacity:0.4"';
    }

    // Add group label if switching groups
    if (msg.chat_jid !== lastJid) {
      if (lastJid !== null) html += `<div style="height:8px"></div>`;
      html += `<div class="conv-group-label">${esc(groupName)}</div>`;
      lastJid = msg.chat_jid;
    }

    html += `<div class="conv-pair">`;
    html += `<div class="conv-time">${esc(time)}</div>`;
    html += `<div class="conv-body">`;
    html += `<div class="conv-question"><span class="conv-sender">${esc(sender)}:</span> ${esc(question)}</div>`;
    html += `<div class="conv-response"${responseClass}>\u2192 Atlas: ${esc(responseText)} ${icon}</div>`;
    html += `</div>`;
    html += `</div>`;
    pairCount++;
  }

  return html || `<div class="empty">No conversations in the last 24 hours</div>`;
}

function renderSharedWorkspace(workspaceData) {
  if (!workspaceData.length) {
    return `<div class="empty">No workspace activity today</div>`;
  }

  let html = '';
  // Escalations first -- most important
  const allEscalations = workspaceData.flatMap(d =>
    d.escalations.map(e => ({ ...e, dept: d.dept }))
  );

  if (allEscalations.length > 0) {
    html += `<div class="escalation-banner">`;
    html += `<strong>${allEscalations.length} escalation${allEscalations.length !== 1 ? 's' : ''} pending</strong>`;
    for (const esc_item of allEscalations) {
      const deptLabel = esc_item.dept.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      html += `<div class="escalation-item">${deptLabel}: ${esc(esc_item.title)}</div>`;
    }
    html += `</div>`;
  }

  for (const dept of workspaceData) {
    const deptLabel = dept.dept.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const fileCount = dept.totalToday;
    const escCount = dept.escalations.length;

    html += `<div class="ws-dept">`;
    html += `<span class="ws-dept-name">${esc(deptLabel)}:</span> `;
    html += `<span class="ws-dept-count">${fileCount} new item${fileCount !== 1 ? 's' : ''}</span>`;
    if (dept.files.length > 0) {
      const labels = dept.files.map(f => f.dir + '/' + f.name).join(', ');
      html += ` <span class="ws-dept-detail">(${esc(truncate(labels, 80))})</span>`;
    }
    if (escCount > 0) {
      html += ` ${badge(escCount + ' ESCALATION' + (escCount !== 1 ? 'S' : ''), '#ef4444')}`;
    }
    html += `</div>`;
  }

  return html;
}

function renderGraduationProgress(graduation) {
  if (!graduation) {
    return `<div class="empty">No graduation data available</div>`;
  }

  const milestones = graduation.milestones || {};
  const milestoneOrder = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'];
  let html = '';

  // Find the first incomplete milestone to know which are "locked"
  let firstIncomplete = null;
  for (const key of milestoneOrder) {
    if (milestones[key]?.status !== 'complete') {
      firstIncomplete = key;
      break;
    }
  }

  for (const key of milestoneOrder) {
    const m = milestones[key] || {};
    let pct = 0;
    let color = '#475569';
    let detail = '';
    let isLocked = false;

    if (m.status === 'complete') {
      pct = 100;
      color = '#22c55e';
      detail = 'Complete';
    } else if (key === firstIncomplete) {
      // This is the active milestone
      color = '#3b82f6';
      const prog = m.progress || {};

      if (key === 'M1') {
        const sessions = prog.instrumented_sessions || 0;
        const reqSessions = prog.required_sessions || 3;
        const entities = prog.entities_seen?.length || 0;
        const reqEntities = prog.required_entities || 2;
        pct = Math.round(((sessions / reqSessions) * 0.5 + (entities / reqEntities) * 0.5) * 100);
        detail = `${sessions}/${reqSessions} sessions, ${entities}/${reqEntities} entities`;
        if (entities < reqEntities) {
          const missing = ['gpg', 'crownscape', 'atlas'].filter(e => !(prog.entities_seen || []).includes(e));
          detail += ` (need ${missing.join(', ')})`;
        }
      } else if (key === 'M2') {
        const runs = prog.consecutive_clean_runs || 0;
        const req = prog.required || 5;
        pct = Math.round((runs / req) * 100);
        detail = `${runs}/${req} consecutive clean runs`;
      } else if (key === 'M3') {
        const actions = prog.total_actions || 0;
        const req = prog.required_actions || 10;
        pct = Math.round((actions / req) * 100);
        const rate = prog.override_rate || 0;
        detail = `${actions}/${req} actions, ${Math.round(rate * 100)}% override`;
      } else if (key === 'M4') {
        const drafts = prog.total_drafts || 0;
        const req = prog.required_drafts || 10;
        pct = Math.round((drafts / req) * 100);
        const rate = prog.approve_rate || 0;
        detail = `${drafts}/${req} drafts, ${Math.round(rate * 100)}% approved`;
      } else if (key === 'M5') {
        const cycles = prog.total_cycles || 0;
        const req = prog.required || 20;
        pct = Math.round((cycles / req) * 100);
        detail = `${cycles}/${req} cycles`;
      }
    } else {
      // Locked: milestone before this one isn't complete
      isLocked = true;
      detail = `Locked \u2014 needs ${milestoneOrder[milestoneOrder.indexOf(key) - 1]}`;
    }

    const opacity = isLocked ? 'opacity:0.5' : '';
    html += `<div class="grad-row" style="${opacity}">`;
    html += `<div class="grad-label">${esc(key)}</div>`;
    html += `<div class="grad-bar">${progressBar(pct, color)}</div>`;
    html += `<div class="grad-detail">${esc(detail)}</div>`;
    html += `</div>`;
  }

  return html;
}

function renderHostTasks(hostData) {
  const { completed, pending } = hostData;
  if (!completed.length && !pending.length) {
    return `<div class="empty">No host-executor tasks</div>`;
  }

  let html = '';
  const all = [
    ...pending.map(t => ({ ...t, _status: 'running' })),
    ...completed,
  ].sort((a, b) => (b.completed_at || b.created_at || '').localeCompare(a.completed_at || a.created_at || ''));

  for (const t of all.slice(0, 8)) {
    // Build a human-readable description from available fields
    let desc = t.prompt || t.description || '';
    if (!desc && t.result_summary) {
      // Extract first meaningful line from result_summary (Atlas's output)
      const firstLine = t.result_summary.split('\n').find(l => l.trim().length > 10) || '';
      desc = firstLine.trim();
    }
    if (!desc || desc.length < 5) desc = 'Task ' + (t.task_id || 'unknown').slice(0, 8);
    desc = truncate(cleanContent(desc), 100);

    const status = t._status || t.status || 'unknown';
    const icon = status === 'success' ? '\u2705' : status === 'running' ? '\u23F3' : '\u274C';
    const time = formatTimeWithDate(t.completed_at || t.created_at);
    const entity = (t.entity || '').toUpperCase();

    html += `<div class="host-row">`;
    html += `<span class="host-time">${esc(time)}</span>`;
    html += `<span class="host-entity">${esc(entity)}</span>`;
    html += `<span class="host-desc">${esc(desc)}</span>`;
    html += `<span class="host-status">${icon} ${esc(status)}</span>`;
    html += `</div>`;
  }

  return html;
}

function renderScheduledTasks(tasks) {
  if (!tasks.length) {
    return `<div class="empty">No scheduled tasks</div>`;
  }

  let html = '';
  for (const t of tasks) {
    const name = t.id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const schedule = scheduleHuman(t.schedule_type, t.schedule_value);
    const nextRun = t.next_run ? `${relativeTime(t.next_run)} (${formatTime(t.next_run)})` : 'never';
    const lastRun = t.last_run ? relativeTime(t.last_run) : 'never';

    html += `<div class="sched-row">`;
    html += `<span class="sched-name">${esc(name)}</span>`;
    html += `<span class="sched-schedule">${esc(schedule)}</span>`;
    html += `<span class="sched-next">Next: ${esc(nextRun)}</span>`;
    html += `<span class="sched-last">Last: ${esc(lastRun)}</span>`;
    html += `</div>`;
  }
  return html;
}

function scheduleHuman(type, value) {
  if (type === 'cron') {
    const parts = (value || '').split(' ');
    if (parts.length >= 5) {
      const [min, hour] = parts;
      if (hour !== '*' && min !== '*') {
        const h = parseInt(hour);
        const m = parseInt(min);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `${h12}:${String(m).padStart(2, '0')} ${ampm} daily`;
      }
    }
    return `cron: ${value}`;
  }
  if (type === 'interval') return `every ${value}`;
  return `${type}: ${value}`;
}

function renderRegisteredGroups(groups) {
  if (!groups.length) {
    return `<div class="empty">No registered groups</div>`;
  }

  let html = '';
  // Main group first, then alphabetical
  const sorted = [...groups].sort((a, b) => {
    if (a.is_main && !b.is_main) return -1;
    if (!a.is_main && b.is_main) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  for (const g of sorted) {
    const mainIcon = g.is_main ? '\u2B50 ' : '   ';
    const triggerMode = g.requires_trigger === 0 ? 'always active' : 'on mention';
    const jidDisplay = g.jid.startsWith('tg:') ? g.jid : truncate(g.jid, 30);
    const typeLabel = g.is_main ? 'CEO control' : (g.folder?.startsWith('dispatch:') ? 'dispatch only' : triggerMode);

    html += `<div class="group-row">`;
    html += `<span class="group-icon">${mainIcon}</span>`;
    html += `<span class="group-name">${esc(g.name)}</span>`;
    html += `<span class="group-folder">${esc(g.folder || '')}</span>`;
    html += `<span class="group-type">${esc(typeLabel)}</span>`;
    html += `<span class="group-jid">${esc(jidDisplay)}</span>`;
    html += `</div>`;
  }
  return html;
}

// --- Page Assembly ------------------------------------------------------------

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

  const quotaColor = quota.level === 'NORMAL' ? '#22c55e' : quota.level === 'THROTTLED' ? '#f59e0b' : '#ef4444';
  const modeColor = (mode === 'active' || mode === 'operational') ? '#22c55e' : '#ef4444';
  const totalEscalations = workspaceActivity.reduce((n, d) => n + d.escalations.length, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="10">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Atlas Mission Control</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0f1a; color: #e2e8f0; padding: 20px 24px; line-height: 1.5;
    }
    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
    .header h1 { font-size:20px; font-weight:700; letter-spacing:-0.5px; color:#f1f5f9; }
    .header .time { color:#64748b; font-size:12px; }

    .stats-row { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:16px; }
    @media(max-width:900px) { .stats-row { grid-template-columns:repeat(3,1fr); } }

    .stat-card {
      background:#111827; border:1px solid #1e293b; border-radius:8px; padding:12px 14px;
    }
    .stat-card .label { font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#4b5563; font-weight:600; margin-bottom:4px; }
    .stat-card .value { font-size:22px; font-weight:700; }
    .stat-card .sub { font-size:10px; color:#6b7280; margin-top:3px; }

    .section {
      background:#111827; border:1px solid #1e293b; border-radius:8px;
      padding:14px 18px; margin-bottom:12px;
    }
    .section h2 {
      font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;
      color:#6b7280; margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid #1e293b;
    }

    .badge { display:inline-block; color:#fff; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:700; letter-spacing:0.3px; }
    .empty { color:#4b5563; padding:12px; text-align:center; font-size:13px; }

    .progress-track { height:10px; background:#1e293b; border-radius:5px; overflow:hidden; flex:1; }
    .progress-fill { height:100%; border-radius:5px; transition:width 0.3s; }

    .quota-bar { height:6px; background:#1e293b; border-radius:3px; margin-top:5px; overflow:hidden; }
    .quota-fill { height:100%; border-radius:3px; }

    /* Conversations */
    .conv-group { margin-bottom:10px; }
    .conv-group-label { font-size:11px; font-weight:700; color:#6b7280; text-transform:uppercase; letter-spacing:0.3px; margin-bottom:6px; }
    .conv-pair { display:flex; gap:10px; padding:6px 0; border-bottom:1px solid #0d1321; }
    .conv-pair:last-child { border-bottom:none; }
    .conv-time { color:#4b5563; font-size:11px; min-width:65px; flex-shrink:0; padding-top:1px; }
    .conv-body { flex:1; min-width:0; }
    .conv-question { font-size:13px; color:#cbd5e1; }
    .conv-sender { font-weight:600; color:#3b82f6; }
    .conv-response { font-size:12px; color:#6b7280; margin-top:2px; padding-left:16px; }

    /* Escalation banner */
    .escalation-banner { background:#1c0a0a; border:1px solid #7f1d1d; border-radius:6px; padding:10px 14px; margin-bottom:10px; }
    .escalation-banner strong { color:#fca5a5; font-size:13px; }
    .escalation-item { color:#f87171; font-size:12px; margin-top:4px; padding-left:12px; }

    /* Workspace */
    .ws-dept { padding:4px 0; font-size:13px; }
    .ws-dept-name { font-weight:600; color:#e2e8f0; }
    .ws-dept-count { color:#94a3b8; }
    .ws-dept-detail { color:#4b5563; font-size:11px; }

    /* Graduation */
    .grad-row { display:flex; align-items:center; gap:12px; margin-bottom:8px; }
    .grad-label { font-weight:700; font-size:13px; color:#e2e8f0; min-width:28px; }
    .grad-bar { flex:1; }
    .grad-detail { font-size:11px; color:#6b7280; min-width:200px; text-align:right; }

    /* Host tasks */
    .host-row { display:flex; gap:10px; padding:5px 0; border-bottom:1px solid #0d1321; font-size:13px; align-items:center; }
    .host-row:last-child { border-bottom:none; }
    .host-time { color:#4b5563; font-size:11px; min-width:55px; }
    .host-entity { font-weight:700; font-size:10px; color:#3b82f6; min-width:40px; text-transform:uppercase; }
    .host-desc { flex:1; color:#cbd5e1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .host-status { color:#6b7280; font-size:12px; min-width:80px; text-align:right; }

    /* Scheduled tasks */
    .sched-row { display:flex; gap:12px; padding:5px 0; border-bottom:1px solid #0d1321; font-size:13px; align-items:center; }
    .sched-row:last-child { border-bottom:none; }
    .sched-name { font-weight:600; color:#e2e8f0; flex:1; }
    .sched-schedule { color:#6b7280; font-size:12px; min-width:120px; }
    .sched-next { color:#94a3b8; font-size:12px; min-width:100px; }
    .sched-last { color:#4b5563; font-size:12px; min-width:100px; }

    /* Groups */
    .group-row { display:flex; gap:8px; padding:4px 0; border-bottom:1px solid #0d1321; font-size:13px; align-items:center; }
    .group-row:last-child { border-bottom:none; }
    .group-icon { font-size:14px; min-width:20px; }
    .group-name { font-weight:600; color:#e2e8f0; min-width:140px; }
    .group-folder { color:#4b5563; font-size:11px; font-family:monospace; min-width:160px; }
    .group-type { color:#6b7280; font-size:11px; min-width:100px; }
    .group-jid { color:#374151; font-size:10px; font-family:monospace; }

    /* Two column layout for bottom sections */
    .two-col { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    @media(max-width:900px) { .two-col { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>Atlas Mission Control</h1>
    <div class="time">${esc(now)} ET</div>
  </div>

  <div class="stats-row">
    <div class="stat-card">
      <div class="label">Mode</div>
      <div class="value" style="color:${modeColor}">${esc(mode.toUpperCase())}</div>
    </div>
    <div class="stat-card">
      <div class="label">Containers</div>
      <div class="value">${containers.length}</div>
      <div class="sub">${containers.map(c => esc(c.name)).join(', ') || 'none running'}</div>
    </div>
    <div class="stat-card">
      <div class="label">Tasks Today</div>
      <div class="value">${quota.total}</div>
      <div class="sub">${quota.autonomous} auto + ${quota.ceo} CEO</div>
    </div>
    <div class="stat-card">
      <div class="label">Quota</div>
      <div class="value" style="color:${quotaColor}">${quota.pct}%</div>
      <div class="quota-bar"><div class="quota-fill" style="width:${quota.pct}%;background:${quotaColor}"></div></div>
      <div class="sub">${quota.weighted}/200 weighted \u2022 ${quota.level}</div>
    </div>
    <div class="stat-card">
      <div class="label">Approvals</div>
      <div class="value" style="color:${approvals.length > 0 ? '#f59e0b' : '#e2e8f0'}">${approvals.length}</div>
      <div class="sub">${totalEscalations > 0 ? totalEscalations + ' escalation' + (totalEscalations !== 1 ? 's' : '') : 'clear'}</div>
    </div>
  </div>

  <div class="section">
    <h2>Today's Activity</h2>
    ${renderConversations(messages, groups)}
  </div>

  <div class="section">
    <h2>Shared Workspace Activity</h2>
    ${renderSharedWorkspace(workspaceActivity)}
  </div>

  <div class="section">
    <h2>Graduation Progress</h2>
    ${renderGraduationProgress(graduation)}
  </div>

  <div class="two-col">
    <div class="section">
      <h2>Host-Executor Results</h2>
      ${renderHostTasks(hostTasks)}
    </div>
    <div class="section">
      <h2>Scheduled Tasks</h2>
      ${renderScheduledTasks(scheduledTasks)}
    </div>
  </div>

  <div class="section">
    <h2>Registered Groups</h2>
    ${renderRegisteredGroups(groups)}
  </div>
</body>
</html>`;
}

// --- Server -------------------------------------------------------------------

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
      messages: getRecentMessages(db, 100),
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
  console.log(`Atlas Mission Control v2 at http://0.0.0.0:${PORT}`);
  console.log(`  Auth: ${AUTH_ENABLED ? 'enabled' : 'DISABLED'}`);
  console.log(`  Database: ${NANOCLAW_DB}`);
  console.log(`  Atlas dir: ${ATLAS_DIR}`);
});
