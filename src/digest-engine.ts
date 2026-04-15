import { TIMEZONE } from './config.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';
import {
  getTrackedItemsByState,
  updateDigestState,
  type TrackedItem,
} from './tracked-items.js';

export function generateMorningDashboard(groupName: string): string {
  const now = Date.now();
  const dateStr =
    formatLocalTime(new Date(now).toISOString(), TIMEZONE).split(',')[0] ||
    new Date().toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

  const actionRequired = getTrackedItemsByState(groupName, ['pending', 'pushed']);
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
        item.resolution_method
          ?.replace('auto:', '')
          .replace('manual:', '') || 'resolved';
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
  return resolved.filter(item => (item.resolved_at ?? 0) > twentyFourHoursAgo);
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
