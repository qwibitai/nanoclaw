import { TIMEZONE, CHAT_INTERFACE_CONFIG } from './config.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';
import { getDb } from './db.js';
import { eventBus } from './event-bus.js';
import {
  getTrackedItemsByState,
  getDigestState,
  updateDigestState,
  transitionItemState,
  incrementDigestCount,
  type TrackedItem,
} from './tracked-items.js';

function normalizeDigestTitle(title: string): string {
  return title.replace(/^(re|fwd|fw):\s*/gi, '').trim();
}

export function generateMorningDashboard(groupName: string): string {
  const now = Date.now();
  const dateStr =
    formatLocalTime(new Date(now).toISOString(), TIMEZONE).split(',')[0] ||
    new Date().toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

  const actionRequired = getTrackedItemsByState(groupName, [
    'pending',
    'pushed',
  ]);
  const queued = getTrackedItemsByState(groupName, ['queued', 'digested']);
  const resolved = getRecentlyResolved(groupName, now);

  const lines: string[] = [];
  lines.push(`<b>MORNING DASHBOARD</b> — ${dateStr}`);
  lines.push('');

  if (actionRequired.length > 0) {
    lines.push(`<b>━━ ACTION REQUIRED (${actionRequired.length}) ━━</b>`);
    let num = 1;
    for (const item of actionRequired) {
      const icon = item.trust_tier === 'escalate' ? '🔴' : '🟡';
      const age = formatAge(now - item.detected_at);
      lines.push(`${num}. ${icon} ${item.source}: ${item.title} (${age})`);
      num++;
    }
    lines.push('');
  }

  if (queued.length > 0) {
    lines.push(`<b>━━ QUEUED (${queued.length}) ━━</b>`);
    for (const item of queued) {
      lines.push(`📬 ${item.source}: ${item.title}`);
    }
    lines.push('');
  }

  lines.push('<b>━━ OVERNIGHT SUMMARY ━━</b>');
  if (resolved.length > 0) {
    lines.push(
      `✅ Resolved: ${resolved.length} item${resolved.length > 1 ? 's' : ''}`,
    );
    for (const item of resolved.slice(0, 5)) {
      const method =
        item.resolution_method?.replace('auto:', '').replace('manual:', '') ||
        'resolved';
      lines.push(`  • ${item.title} (${method})`);
    }
  } else {
    lines.push('📊 No overnight activity');
  }

  if (actionRequired.length === 0 && queued.length === 0) {
    lines.push('');
    lines.push('Nothing urgent. Clean slate today.');
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━');
  if (actionRequired.length > 0) {
    lines.push('Reply with a number to act, or just start your day.');
  }

  updateDigestState(groupName, {
    last_dashboard_at: now,
    queued_count: 0,
    last_user_interaction: now,
  });

  logger.debug(
    {
      groupName,
      actionRequired: actionRequired.length,
      queued: queued.length,
      resolved: resolved.length,
    },
    'Morning dashboard generated',
  );

  return lines.join('\n');
}

function getRecentlyResolved(groupName: string, now: number): TrackedItem[] {
  const resolved = getTrackedItemsByState(groupName, ['resolved']);
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  return resolved.filter(
    (item) => (item.resolved_at ?? 0) > twentyFourHoursAgo,
  );
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function shouldFireDigest(groupName: string): boolean {
  const state = getDigestState(groupName);
  const { digestThreshold, digestMinIntervalMs } = CHAT_INTERFACE_CONFIG;

  if (state.queued_count < digestThreshold) return false;

  if (state.last_digest_at) {
    const elapsed = Date.now() - state.last_digest_at;
    if (elapsed < digestMinIntervalMs) return false;
  }

  return true;
}

export function generateSmartDigest(groupName: string): string | null {
  const now = Date.now();
  const state = getDigestState(groupName);
  const since =
    state.last_digest_at ??
    state.last_dashboard_at ??
    now - 24 * 60 * 60 * 1000;

  const resolved = getTrackedItemsByState(groupName, ['resolved']).filter(
    (i) => (i.resolved_at ?? 0) > since,
  );
  const pending = getTrackedItemsByState(groupName, [
    'pending',
    'pushed',
  ]).filter((i) => i.detected_at < since || now - i.detected_at > 14400000);
  const fyi = getTrackedItemsByState(groupName, ['queued', 'digested']);

  if (resolved.length === 0 && pending.length === 0 && fyi.length === 0) {
    return null;
  }

  const timeStr =
    formatLocalTime(new Date(now).toISOString(), TIMEZONE)
      .split(',')
      .pop()
      ?.trim() || '';
  const lines: string[] = [];
  lines.push(`📊 <b>DIGEST</b> — ${timeStr}`);
  lines.push('');

  if (resolved.length > 0) {
    lines.push('<b>━━ RESOLVED SINCE LAST CHECK ━━</b>');
    for (const item of resolved) {
      const method =
        item.resolution_method?.replace('auto:', '').replace('manual:', '') ||
        '';
      lines.push(`✅ ${item.title}${method ? ` — ${method}` : ''}`);
    }
    lines.push('');
  }

  if (fyi.length > 0) {
    lines.push('<b>━━ FYI ━━</b>');

    const threaded = new Map<string, TrackedItem[]>();
    const unthreaded: TrackedItem[] = [];
    for (const item of fyi) {
      if (item.thread_id) {
        const group = threaded.get(item.thread_id) ?? [];
        group.push(item);
        threaded.set(item.thread_id, group);
      } else {
        unthreaded.push(item);
      }
    }

    for (const items of threaded.values()) {
      if (items.length > 1) {
        const title = normalizeDigestTitle(items[0].title);
        lines.push(`📬 ${title} (${items.length} items)`);
      } else {
        const item = items[0];
        lines.push(`📬 ${item.source}: ${item.title}`);
      }
    }

    const bySource = new Map<string, number>();
    for (const item of unthreaded) {
      bySource.set(item.source, (bySource.get(item.source) || 0) + 1);
    }
    for (const [source, count] of bySource) {
      lines.push(`📬 ${count} ${source} item${count > 1 ? 's' : ''}`);
    }

    lines.push('');

    const fyiIds = fyi.filter((i) => i.state === 'queued').map((i) => i.id);
    for (const id of fyiIds) {
      try {
        transitionItemState(id, 'queued', 'digested');
      } catch {
        /* already transitioned */
      }
    }
    incrementDigestCount(fyi.map((i) => i.id));
  }

  if (pending.length > 0) {
    lines.push('<b>━━ STILL PENDING ━━</b>');
    for (const item of pending) {
      const age = formatAge(now - item.detected_at);
      lines.push(`⏳ ${item.title} — pushed ${age}`);
    }
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('Next digest when 5+ items accumulate.');

  updateDigestState(groupName, {
    last_digest_at: now,
    queued_count: 0,
  });

  return lines.join('\n');
}

export function generateOnDemandDigest(groupName: string): string {
  const now = Date.now();
  const state = getDigestState(groupName);
  const since = state.last_user_interaction ?? now - 6 * 60 * 60 * 1000;

  const actionRequired = getTrackedItemsByState(groupName, [
    'pending',
    'pushed',
  ]).filter((i) => i.detected_at > since);
  const resolved = getTrackedItemsByState(groupName, ['resolved']).filter(
    (i) => (i.resolved_at ?? 0) > since,
  );
  const fyi = getTrackedItemsByState(groupName, ['queued', 'digested']).filter(
    (i) => i.detected_at > since,
  );

  if (
    actionRequired.length === 0 &&
    resolved.length === 0 &&
    fyi.length === 0
  ) {
    const sinceStr = formatLocalTime(new Date(since).toISOString(), TIMEZONE);
    return `All clear since ${sinceStr}. Nothing needs your attention.`;
  }

  const sinceStr = formatLocalTime(new Date(since).toISOString(), TIMEZONE);
  const lines: string[] = [];
  lines.push(`📊 <b>CATCH-UP</b> — since ${sinceStr}`);
  lines.push('');

  if (actionRequired.length > 0) {
    lines.push('<b>━━ ACTION REQUIRED ━━</b>');
    for (const item of actionRequired) {
      const icon = item.trust_tier === 'escalate' ? '🔴' : '🟡';
      const age = formatAge(now - item.detected_at);
      lines.push(
        `${icon} ${item.source}: ${item.title} (pushed ${age}, still pending)`,
      );
    }
    lines.push('');
  }

  if (resolved.length > 0) {
    lines.push('<b>━━ RESOLVED ━━</b>');
    for (const item of resolved) {
      const method =
        item.resolution_method?.replace('auto:', '').replace('manual:', '') ||
        '';
      lines.push(`✅ ${item.title}${method ? ` (${method})` : ''}`);
    }
    lines.push('');
  }

  if (fyi.length > 0) {
    lines.push('<b>━━ FYI ━━</b>');
    const bySource = new Map<string, number>();
    for (const item of fyi) {
      bySource.set(item.source, (bySource.get(item.source) || 0) + 1);
    }
    for (const [source, count] of bySource) {
      lines.push(`📬 ${count} ${source} item${count > 1 ? 's' : ''}`);
    }
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(
    `${actionRequired.length} item${actionRequired.length !== 1 ? 's' : ''} need${actionRequired.length === 1 ? 's' : ''} your attention.`,
  );

  updateDigestState(groupName, {
    last_digest_at: now,
    queued_count: 0,
    last_user_interaction: now,
  });

  return lines.join('\n');
}

export function detectAndArchiveStale(
  groupName: string,
  staleThreshold: number,
): TrackedItem[] {
  const db = getDb();
  const staleRows = db
    .prepare(
      `SELECT * FROM tracked_items
     WHERE group_name = ? AND state IN ('digested', 'pending') AND digest_count >= ?`,
    )
    .all(groupName, staleThreshold) as Array<Record<string, unknown>>;

  const staleItems: TrackedItem[] = [];

  for (const row of staleRows) {
    const item = deserializeStaleItem(row);
    try {
      transitionItemState(item.id, item.state as any, 'stale', {
        resolved_at: Date.now(),
        resolution_method: 'stale',
      });
      staleItems.push(item);

      eventBus.emit('item.stale', {
        type: 'item.stale',
        source: 'digest-engine',
        timestamp: Date.now(),
        payload: { itemId: item.id, digestCycles: item.digest_count },
      });
    } catch {
      // Already transitioned
    }
  }

  return staleItems;
}

function deserializeStaleItem(row: Record<string, unknown>): TrackedItem {
  return {
    ...row,
    classification_reason: row.classification_reason
      ? JSON.parse(row.classification_reason as string)
      : null,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  } as TrackedItem;
}
