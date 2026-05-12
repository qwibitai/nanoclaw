/**
 * Host-side daily summary digest.
 *
 * Mirrors v1's daily-notifications: once a day, for each agent group, build
 * a digest of recent ship_log + backlog activity and post it to the group's
 * channel. v2 trunk had every data piece (ship_log, backlog, commit-scan)
 * but never ported the consumer; data was accumulating with no readout.
 *
 * Differences from v1:
 *   - no GitHub team-PR section (commit-scan covers default-branch shipping
 *     in locally cloned repos; the gap is non-cloned team repos which the
 *     user opted to defer until needed).
 *   - per-group channel override via container.json `dailySummary.messagingGroupId`
 *     replaces v1's `notifyJid` field.
 *
 * Trigger model: ticks every 5 min, fires when local hour in DAILY_SUMMARY_TZ
 * matches DAILY_SUMMARY_HOUR and we haven't already fired today (per a small
 * JSON state file). Hour-only granularity is enough for "daily at 8am ET" —
 * no cron-parser dep.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readContainerConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getBacklog, getBacklogResolvedSince, getShipLogSince } from './db/backlog.js';
import type { BacklogItem, ShipLogEntry } from './db/backlog.js';
import { getMessagingGroup, getPrimaryMessagingGroupByAgentGroup } from './db/messaging-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import type { AgentGroup, MessagingGroup } from './types.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const STATE_PATH = path.join(DATA_DIR, 'daily-summary-state.json');

const DEFAULT_HOUR = 8;
const DEFAULT_TZ = 'America/New_York';

let timer: NodeJS.Timeout | null = null;

export function startDailySummary(): void {
  if (timer) return;
  timer = setTimeout(function tick() {
    runTick().catch((err) => log.error('Daily summary tick failed', { err }));
    timer = setTimeout(tick, TICK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

export function stopDailySummary(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Exposed for tests — runs one tick synchronously and returns. */
export async function _tickForTest(): Promise<void> {
  await runTick();
}

async function runTick(): Promise<void> {
  const targetHour = parseHour(process.env.DAILY_SUMMARY_HOUR) ?? DEFAULT_HOUR;
  const tz = process.env.DAILY_SUMMARY_TZ || DEFAULT_TZ;
  const now = new Date();

  const hourNow = hourInZone(now, tz);
  const todayKey = dateKeyInZone(now, tz);

  if (hourNow !== targetHour) return;

  const state = readState();
  if (state.lastFiredDateKey === todayKey) return;

  log.info('Daily summary firing', { todayKey, hourNow, targetHour, tz });
  await fireDigests();
  writeState({ lastFiredDateKey: todayKey });
}

async function fireDigests(): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Daily summary: no delivery adapter — skipping');
    return;
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const groups = getAllAgentGroups();
  let sentCount = 0;

  for (const group of groups) {
    try {
      const summary = buildSummary(group, since);
      if (isEmpty(summary)) continue;

      const target = resolveTarget(group);
      if (!target) {
        log.warn('Daily summary: no wired channel — skipping', { agentGroupId: group.id });
        continue;
      }

      const text = formatDigest(group, summary);
      await adapter.deliver(target.channel_type, target.platform_id, null, 'chat', JSON.stringify({ text }));
      sentCount += 1;
      log.info('Daily summary delivered', {
        agentGroupId: group.id,
        messagingGroupId: target.id,
        shipped: summary.shipped.length,
        resolved: summary.resolved.length,
        openBacklog: summary.openBacklog.length,
      });
    } catch (err) {
      log.warn('Daily summary delivery failed', { agentGroupId: group.id, err });
    }
  }

  log.info('Daily summary cycle complete', { groups: groups.length, sent: sentCount });
}

interface Summary {
  shipped: ShipLogEntry[];
  resolved: BacklogItem[];
  openBacklog: BacklogItem[];
}

function buildSummary(group: AgentGroup, since: string): Summary {
  const shipped = getShipLogSince(group.id, since);
  const resolved = getBacklogResolvedSince(group.id, since);
  const openBacklog = [...getBacklog(group.id, 'in_progress'), ...getBacklog(group.id, 'open')];
  return { shipped, resolved, openBacklog };
}

function isEmpty(s: Summary): boolean {
  return s.shipped.length === 0 && s.resolved.length === 0 && s.openBacklog.length === 0;
}

/**
 * Resolve the target messaging group for an agent group's daily digest.
 * Override in container.json wins; otherwise fall back to the primary
 * (highest priority, oldest tiebreak) wired channel. Bogus override id
 * falls back to primary with a warning, not a hard failure — operator
 * mistakes shouldn't silence the digest entirely.
 */
function resolveTarget(group: AgentGroup): MessagingGroup | null {
  const config = readContainerConfig(group.folder);
  const overrideId = config.dailySummary?.messagingGroupId;
  if (overrideId) {
    const mg = getMessagingGroup(overrideId);
    if (mg) return mg;
    log.warn('Daily summary: dailySummary.messagingGroupId not found, falling back to primary', {
      agentGroupId: group.id,
      overrideId,
    });
  }
  return getPrimaryMessagingGroupByAgentGroup(group.id);
}

// ── Formatting ──

export function formatDigest(group: AgentGroup, s: Summary): string {
  const groupLabel = group.name || group.folder || group.id;
  const lines: string[] = [`📋 **Daily Summary** — ${groupLabel}`];

  if (s.shipped.length > 0) {
    lines.push('', `🤖 **Agent Shipped** (${s.shipped.length}):`);
    const byRepo = groupBy(s.shipped, extractRepo);
    const repoNames = Object.keys(byRepo);
    const showRepoHeader = repoNames.length > 1;
    for (const repo of repoNames) {
      if (showRepoHeader) lines.push(`**${repo}**`);
      for (const entry of byRepo[repo]) {
        lines.push(`• ${entry.title}${entry.pr_url ? ` — ${entry.pr_url}` : ''}`);
      }
    }
  }

  if (s.resolved.length > 0) {
    lines.push('', `✅ **Resolved** (${s.resolved.length}):`);
    for (const item of s.resolved) {
      const emoji = item.status === 'resolved' ? '✅' : '🚫';
      lines.push(`${emoji} ${item.title}`);
    }
  }

  if (s.openBacklog.length > 0) {
    lines.push('', `📌 **Open Backlog** (${s.openBacklog.length}):`);
    for (const item of s.openBacklog) {
      const pri = item.priority === 'high' ? '🔴' : item.priority === 'medium' ? '🟡' : '⚪';
      const suffix = item.status === 'in_progress' ? ' [in progress]' : '';
      lines.push(`${pri} ${item.title}${suffix}`);
    }
  }

  return lines.join('\n');
}

/**
 * Repo extraction priority — direct port of v1's logic:
 *   1. Parse owner/repo from a github.com/.../pull|issues URL in pr_url.
 *   2. If tags include 'commit-digest', use the other tag (commit-scan
 *      writes `commit-digest,<repoName>` per scanRepo).
 *   3. Title prefix before ':' if it appears in the first 40 chars.
 *   4. 'Other'.
 */
export function extractRepo(entry: ShipLogEntry): string {
  if (entry.pr_url) {
    const m = entry.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)/);
    if (m) return m[1];
  }
  if (entry.tags) {
    try {
      const parsed = JSON.parse(entry.tags);
      if (Array.isArray(parsed) && parsed.includes('commit-digest')) {
        const other = parsed.find((t: unknown) => typeof t === 'string' && t !== 'commit-digest');
        if (typeof other === 'string') return other;
      }
    } catch {
      // commit-scan writes tags as a comma-separated string, not JSON.
      const parts = entry.tags.split(',').map((t) => t.trim());
      if (parts.includes('commit-digest')) {
        const other = parts.find((t) => t !== 'commit-digest');
        if (other) return other;
      }
    }
  }
  if (entry.title) {
    const idx = entry.title.indexOf(':');
    if (idx > 0 && idx < 40) return entry.title.slice(0, idx);
  }
  return 'Other';
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = keyFn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

// ── TZ helpers ──

function hourInZone(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value;
  return hour ? parseInt(hour, 10) : -1;
}

function dateKeyInZone(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

function parseHour(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) return null;
  return n;
}

// ── State file ──

interface State {
  lastFiredDateKey: string | null;
}

function readState(): State {
  try {
    if (!fs.existsSync(STATE_PATH)) return { lastFiredDateKey: null };
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as Partial<State>;
    return { lastFiredDateKey: raw.lastFiredDateKey ?? null };
  } catch (err) {
    log.warn('Daily summary: failed to read state, treating as fresh', { err });
    return { lastFiredDateKey: null };
  }
}

function writeState(state: State): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    log.error('Daily summary: failed to write state', { err });
  }
}
