/**
 * scripts/lookback.ts — recent-thread review report.
 *
 * Walks central DB → recently-active sessions → per-session inbound/outbound DBs,
 * surfaces threads that look half-baked or open. Owner reviews the markdown
 * report and decides what to follow up on.
 *
 * Usage:
 *   pnpm exec tsx scripts/lookback.ts                 # last 7 days
 *   pnpm exec tsx scripts/lookback.ts --days 14
 *   pnpm exec tsx scripts/lookback.ts --days 7 --quiet  # skip 'idle' rows
 *
 * Status classification (per session):
 *   user-waiting   — last message was inbound (user → agent), no agent reply since
 *   agent-pending  — last agent reply contains commitment language (I'll, let me,
 *                    checking, investigating, next step, follow up, TODO, will do)
 *   approval-open  — pending_approvals row references this session, no resolution
 *   task-stale     — task scheduled to run, process_after passed, status != 'delivered'
 *   idle           — otherwise; last activity was a clean exchange
 *
 * Heuristics intentionally conservative — better to surface a session that
 * was actually closed than to miss one that's open.
 */

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CENTRAL_DB = path.join(ROOT, 'data', 'v2.db');
const SESSIONS_DIR = path.join(ROOT, 'data', 'v2-sessions');

interface Args {
  days: number;
  quiet: boolean;
}

function parseArgs(): Args {
  const args: Args = { days: 7, quiet: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') {
      args.days = parseInt(argv[++i] ?? '7', 10);
    } else if (argv[i] === '--quiet') {
      args.quiet = true;
    }
  }
  return args;
}

interface SessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  status: string;
  last_active: string | null;
  agent_group_name: string;
  agent_group_folder: string;
  messaging_group_name: string | null;
  channel_type: string | null;
}

interface MessageRow {
  id: string;
  kind: string;
  timestamp: string;
  channel_type: string | null;
  content: string;
  source: 'inbound' | 'outbound';
}

const COMMITMENT_PATTERNS = [
  /\bI'?ll\b/i,
  /\blet me\b/i,
  /\bchecking\b/i,
  /\binvestigating\b/i,
  /\bnext step\b/i,
  /\bfollow.?up\b/i,
  /\bTODO\b/,
  /\bwill do\b/i,
  /\bgetting back to/i,
  /\bcircle back\b/i,
  /\bwait for\b/i,
  /\bwaiting on\b/i,
  /\bstand.?by\b/i,
];

function hasCommitmentLanguage(text: string): boolean {
  return COMMITMENT_PATTERNS.some((p) => p.test(text));
}

function readMessages(sessionDir: string): MessageRow[] {
  const inPath = path.join(sessionDir, 'inbound.db');
  const outPath = path.join(sessionDir, 'outbound.db');
  const messages: MessageRow[] = [];
  if (fs.existsSync(inPath)) {
    const db = new Database(inPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, kind, timestamp, channel_type, content
           FROM messages_in
           ORDER BY seq DESC
           LIMIT 50`,
        )
        .all() as Omit<MessageRow, 'source'>[];
      messages.push(...rows.map((r) => ({ ...r, source: 'inbound' as const })));
    } finally {
      db.close();
    }
  }
  if (fs.existsSync(outPath)) {
    const db = new Database(outPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, kind, timestamp, channel_type, content
           FROM messages_out
           ORDER BY seq DESC
           LIMIT 50`,
        )
        .all() as Omit<MessageRow, 'source'>[];
      messages.push(...rows.map((r) => ({ ...r, source: 'outbound' as const })));
    } finally {
      db.close();
    }
  }
  return messages.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

interface PendingTask {
  id: string;
  process_after: string;
  prompt: string;
}

function findStaleTasks(sessionDir: string, now: Date): PendingTask[] {
  // A task is stale only if it's still `pending` (not `completed`/`failed`)
  // AND its process_after is in the past. For recurring tasks (series_id set),
  // surface only the OLDEST pending occurrence per series — the host is
  // behind on that series, but listing every queued occurrence is noise.
  const inPath = path.join(sessionDir, 'inbound.db');
  if (!fs.existsSync(inPath)) return [];
  const db = new Database(inPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, process_after, content, series_id
         FROM messages_in
         WHERE kind = 'task'
           AND status = 'pending'
           AND process_after IS NOT NULL
           AND process_after < ?
         ORDER BY process_after ASC`,
      )
      .all(now.toISOString()) as { id: string; process_after: string; content: string; series_id: string | null }[];
    const seenSeries = new Set<string>();
    const out: PendingTask[] = [];
    for (const r of rows) {
      if (r.series_id) {
        if (seenSeries.has(r.series_id)) continue;
        seenSeries.add(r.series_id);
      }
      let prompt = r.content;
      try {
        const parsed = JSON.parse(r.content);
        prompt = parsed.prompt ?? parsed.text ?? r.content;
      } catch {
        // raw content
      }
      out.push({ id: r.id, process_after: r.process_after, prompt: String(prompt).replace(/\s+/g, ' ').trim().slice(0, 120) });
      if (out.length >= 5) break;
    }
    return out;
  } finally {
    db.close();
  }
}

interface PendingApproval {
  approval_id: string;
  action: string;
  created_at: string;
}

function findOpenApprovals(centralDb: Database.Database, sessionId: string): PendingApproval[] {
  const tableExists = centralDb
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='pending_approvals'")
    .get() as { ok: number } | undefined;
  if (!tableExists) return [];
  return centralDb
    .prepare(
      `SELECT approval_id, action, created_at
       FROM pending_approvals
       WHERE session_id = ?
         AND status = 'pending'
       ORDER BY created_at DESC`,
    )
    .all(sessionId) as PendingApproval[];
}

type Status = 'user-waiting' | 'agent-pending' | 'approval-open' | 'task-stale' | 'idle';

interface ClassifiedSession {
  session: SessionRow;
  status: Status;
  reason: string;
  preview: string;
  approvals: PendingApproval[];
  staleTasks: PendingTask[];
  lastInbound: MessageRow | null;
  lastOutbound: MessageRow | null;
}

function previewContent(msg: MessageRow): string {
  let text = msg.content;
  try {
    const parsed = JSON.parse(msg.content);
    text = parsed.text ?? parsed.prompt ?? parsed.message ?? msg.content;
  } catch {
    // raw content
  }
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function classify(
  session: SessionRow,
  messages: MessageRow[],
  approvals: PendingApproval[],
  staleTasks: PendingTask[],
): ClassifiedSession {
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'task');
  const lastInbound = [...chatMessages].reverse().find((m) => m.source === 'inbound') ?? null;
  const lastOutbound = [...chatMessages].reverse().find((m) => m.source === 'outbound') ?? null;
  const lastAny = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;

  let status: Status = 'idle';
  let reason = 'recent activity looks closed';
  let preview = lastAny ? previewContent(lastAny) : '(no recent chat messages)';

  if (approvals.length > 0) {
    status = 'approval-open';
    reason = `${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}: ${approvals.map((a) => a.action).join(', ')}`;
  } else if (staleTasks.length > 0) {
    status = 'task-stale';
    reason = `${staleTasks.length} task${staleTasks.length === 1 ? '' : 's'} past process_after, not delivered`;
    preview = staleTasks[0].prompt;
  } else if (lastAny && lastAny.source === 'inbound' && lastAny.kind === 'chat') {
    status = 'user-waiting';
    reason = 'last message was from user, no agent reply';
    preview = previewContent(lastAny);
  } else if (lastOutbound) {
    const content = previewContent(lastOutbound);
    if (hasCommitmentLanguage(content)) {
      status = 'agent-pending';
      reason = 'agent committed to follow-up; no further messages';
      preview = content;
    }
  }

  return { session, status, reason, preview, approvals, staleTasks, lastInbound, lastOutbound };
}

function fmtAge(timestamp: string | null, now: Date): string {
  if (!timestamp) return 'never';
  const t = new Date(timestamp).getTime();
  const ms = now.getTime() - t;
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(ms / 60000)}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  return `${days.toFixed(1)}d ago`;
}

function statusIcon(s: Status): string {
  return {
    'user-waiting': '[U]',
    'agent-pending': '[A]',
    'approval-open': '[!]',
    'task-stale': '[T]',
    idle: '[ ]',
  }[s];
}

function main(): void {
  const args = parseArgs();
  const now = new Date();
  const cutoff = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000).toISOString();

  const central = new Database(CENTRAL_DB, { readonly: true });
  let sessions: SessionRow[];
  try {
    sessions = central
      .prepare(
        `SELECT s.id, s.agent_group_id, s.messaging_group_id, s.thread_id, s.status, s.last_active,
                ag.name AS agent_group_name, ag.folder AS agent_group_folder,
                mg.name AS messaging_group_name, mg.channel_type
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
         LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
         WHERE s.last_active IS NOT NULL
           AND s.last_active >= ?
         ORDER BY s.last_active DESC`,
      )
      .all(cutoff) as SessionRow[];
  } finally {
    // keep central open for approval lookups; close at end
  }

  const classified: ClassifiedSession[] = [];
  for (const s of sessions) {
    const sessionDir = path.join(SESSIONS_DIR, s.agent_group_id, s.id);
    if (!fs.existsSync(sessionDir)) continue;
    const messages = readMessages(sessionDir);
    const approvals = findOpenApprovals(central, s.id);
    const staleTasks = findStaleTasks(sessionDir, now);
    classified.push(classify(s, messages, approvals, staleTasks));
  }
  central.close();

  const filtered = args.quiet ? classified.filter((c) => c.status !== 'idle') : classified;

  // Group by agent group, ordered by attention-needed first.
  const groups = new Map<string, ClassifiedSession[]>();
  for (const c of filtered) {
    const key = `${c.session.agent_group_name} (${c.session.agent_group_folder})`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const STATUS_ORDER: Status[] = ['approval-open', 'user-waiting', 'task-stale', 'agent-pending', 'idle'];

  const totals = STATUS_ORDER.map((s) => ({
    status: s,
    count: filtered.filter((c) => c.status === s).length,
  }));

  console.log(`# Lookback report — last ${args.days} days`);
  console.log(`Generated: ${now.toISOString()}`);
  console.log('');
  console.log('## Summary');
  console.log('');
  console.log('| Status | Count | Meaning |');
  console.log('|---|---|---|');
  console.log(`| ${statusIcon('approval-open')} approval-open | ${totals[0].count} | Pending approval blocking the session |`);
  console.log(`| ${statusIcon('user-waiting')} user-waiting | ${totals[1].count} | You messaged, no reply from agent |`);
  console.log(`| ${statusIcon('task-stale')} task-stale | ${totals[2].count} | Scheduled task past due, not delivered |`);
  console.log(`| ${statusIcon('agent-pending')} agent-pending | ${totals[3].count} | Agent committed to follow-up; nothing since |`);
  console.log(`| ${statusIcon('idle')} idle | ${totals[4].count} | Looks closed |`);
  console.log('');

  for (const [groupKey, sessions] of groups) {
    sessions.sort((a, b) => {
      const sa = STATUS_ORDER.indexOf(a.status);
      const sb = STATUS_ORDER.indexOf(b.status);
      if (sa !== sb) return sa - sb;
      const ta = a.session.last_active ?? '';
      const tb = b.session.last_active ?? '';
      return tb.localeCompare(ta);
    });

    const interesting = sessions.filter((s) => s.status !== 'idle');
    if (interesting.length === 0 && args.quiet) continue;

    console.log(`## ${groupKey}`);
    console.log('');
    for (const c of sessions) {
      const channel = c.session.channel_type ?? 'no-channel';
      const mg = c.session.messaging_group_name ?? '—';
      const age = fmtAge(c.session.last_active, now);
      console.log(`### ${statusIcon(c.status)} ${c.status} — ${channel}/${mg} (${age})`);
      console.log(`- session: \`${c.session.id}\``);
      if (c.session.thread_id) console.log(`- thread: \`${c.session.thread_id}\``);
      console.log(`- reason: ${c.reason}`);
      if (c.preview) console.log(`- last: ${c.preview}`);
      if (c.approvals.length > 0) {
        console.log(`- approvals:`);
        for (const a of c.approvals) console.log(`  - \`${a.approval_id}\` ${a.action} (${fmtAge(a.created_at, now)})`);
      }
      if (c.staleTasks.length > 0) {
        console.log(`- stale tasks:`);
        for (const t of c.staleTasks)
          console.log(`  - \`${t.id}\` (due ${fmtAge(t.process_after, now)}): ${t.prompt}`);
      }
      console.log('');
    }
  }

  console.log('---');
  console.log(`_${filtered.length} session${filtered.length === 1 ? '' : 's'} reviewed (--days ${args.days}${args.quiet ? ', --quiet' : ''})_`);
}

main();
