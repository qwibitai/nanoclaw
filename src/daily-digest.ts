/**
 * @deprecated Replaced by src/digest-engine.ts (TENSION-4).
 * This module remains during the migration period. Once digest-engine.ts
 * handles morning dashboard + smart digest + on-demand digest, remove this file
 * and update any imports in src/index.ts.
 */

/**
 * Daily Digest — Morning Brief
 *
 * Synthesizes overnight events into a concise digest message.
 * Runs as a scheduled interval (default: every day at 8:00 AM).
 * Sends to the main group's channel.
 */

import { TIMEZONE } from './config.js';
import { getPendingTrustApprovalIds } from './db.js';
import { queryEvents } from './event-log.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';

/** How far back to look for events (24 hours). */
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DigestDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getMainGroupJid: () => string | undefined;
}

/**
 * Summarize events of a given type into a count + brief description.
 */
function summarizeEventType(
  events: Array<{
    event_type: string;
    payload: Record<string, unknown>;
  }>,
): string[] {
  const byType = new Map<string, number>();
  for (const e of events) {
    byType.set(e.event_type, (byType.get(e.event_type) || 0) + 1);
  }

  const lines: string[] = [];
  for (const [type, count] of byType) {
    const label = formatEventTypeLabel(type);
    lines.push(`  \u{2022} ${label}: ${count}`);
  }
  return lines;
}

/**
 * Human-readable label for an event type.
 */
function formatEventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    'message.inbound': 'Messages received',
    'message.outbound': 'Messages sent',
    'task.complete': 'Tasks completed',
    'task.queued': 'Tasks queued',
    'trust.request': 'Trust approvals requested',
    'trust.approved': 'Trust actions approved',
    'trust.denied': 'Trust actions denied',
    'email.received': 'Emails received',
    'webhook.received': 'Webhooks received',
    'system.error': 'System errors',
  };
  return labels[type] || type;
}

/**
 * Generate the daily digest text.
 * Exported for testing.
 */
export function generateDigest(mainGroupJid: string, now?: number): string {
  const currentTime = now ?? Date.now();
  const since = currentTime - DIGEST_WINDOW_MS;

  const events = queryEvents({ since, limit: 500 });

  if (events.length === 0) {
    return `\u{1F4CB} *Daily Digest*\n\n_${formatLocalTime(new Date(currentTime).toISOString(), TIMEZONE)}_\n\nQuiet night \u2014 no events in the last 24 hours.`;
  }

  const lines: string[] = [
    `\u{1F4CB} *Daily Digest*`,
    '',
    `_${formatLocalTime(new Date(currentTime).toISOString(), TIMEZONE)}_`,
    '',
  ];

  // Event summary by type
  const eventSummary = summarizeEventType(events);
  if (eventSummary.length > 0) {
    lines.push('*Activity Summary*');
    lines.push(...eventSummary);
    lines.push('');
  }

  // Errors (highlight if any)
  const errors = events.filter((e) => e.event_type === 'system.error');
  if (errors.length > 0) {
    lines.push(
      `\u{26A0}\u{FE0F} *${errors.length} error(s)* occurred \u2014 check logs for details.`,
    );
    lines.push('');
  }

  // Pending trust approvals
  const pendingApprovals = getPendingTrustApprovalIds(mainGroupJid);
  if (pendingApprovals.length > 0) {
    lines.push(
      `\u{1F510} *${pendingApprovals.length} pending trust approval(s)* waiting for your decision.`,
    );
    lines.push('');
  }

  // Email highlights
  const emailEvents = events.filter((e) => e.event_type === 'email.received');
  if (emailEvents.length > 0) {
    const totalEmails = emailEvents.reduce((sum, e) => {
      const count = e.payload.count;
      return sum + (typeof count === 'number' ? count : 0);
    }, 0);
    lines.push(
      `\u{1F4E7} *${totalEmails} email(s)* processed across ${emailEvents.length} batch(es).`,
    );
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Run the daily digest: generate and send.
 */
export async function runDailyDigest(deps: DigestDeps): Promise<void> {
  const mainJid = deps.getMainGroupJid();
  if (!mainJid) {
    logger.warn('Daily digest: no main group configured, skipping');
    return;
  }

  const digest = generateDigest(mainJid);
  await deps.sendMessage(mainJid, digest);
  logger.info('Daily digest sent');
}
