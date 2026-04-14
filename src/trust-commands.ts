/**
 * Trust command parsing and response formatting.
 * Commands: trust status, never auto-execute [class], reset trust, what did I miss
 */

import {
  getAllTrustLevels,
  getPendingTrustApprovalIds,
  resetTrustLevels,
  setTrustAutoExecute,
} from './db.js';
import { queryEvents } from './event-log.js';
import { TIMEZONE } from './config.js';
import { formatLocalTime } from './timezone.js';
import type { ActionClass } from './trust-engine.js';

export type TrustCommand =
  | { type: 'status' }
  | { type: 'never_auto'; actionClass: ActionClass }
  | { type: 'reset' }
  | { type: 'what_did_i_miss' };

/** Parse a trigger-stripped message into a trust command, or null. */
export function parseTrustCommand(text: string): TrustCommand | null {
  const lower = text.trim().toLowerCase();

  if (lower === 'trust status' || lower.startsWith('trust status')) {
    return { type: 'status' };
  }

  const neverMatch = lower.match(
    /^never\s+auto[-\s]?execute\s+([a-z]+\.[a-z]+)$/,
  );
  if (neverMatch) {
    return { type: 'never_auto', actionClass: neverMatch[1] as ActionClass };
  }

  if (lower === 'reset trust') {
    return { type: 'reset' };
  }

  // "what did I miss" and variants
  if (
    /^what\s+did\s+i\s+miss/i.test(lower) ||
    lower === 'catch me up' ||
    lower === 'catch up' ||
    lower === 'what happened' ||
    /^what['']?s\s+new/i.test(lower)
  ) {
    return { type: 'what_did_i_miss' };
  }

  return null;
}

const CONFIDENCE_BAR_LENGTH = 10;
function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence * CONFIDENCE_BAR_LENGTH);
  return (
    '\u{2588}'.repeat(filled) +
    '\u{2591}'.repeat(CONFIDENCE_BAR_LENGTH - filled)
  );
}

/** Execute a trust command and return the response text. */
export function executeTrustCommand(
  command: TrustCommand,
  groupId: string,
): string {
  switch (command.type) {
    case 'status': {
      const levels = getAllTrustLevels(groupId);
      if (levels.length === 0) {
        return '\u{1F512} *Trust Status*\n\nNo trust data yet \u2014 everything requires approval (cold start).';
      }
      const lines = ['\u{1F512} *Trust Status*', ''];
      for (const level of levels) {
        const bar = confidenceBar(level.confidence);
        const pct = (level.confidence * 100).toFixed(0);
        const gate = !level.auto_execute ? ' \u{1F510} manual' : '';
        lines.push(
          `**${level.action_class}**${gate}`,
          `[${bar}] ${pct}% (${level.approvals}\u{2713} ${level.denials}\u{2717}, threshold ${(level.threshold * 100).toFixed(0)}%)`,
          '',
        );
      }
      return lines.join('\n').trim();
    }

    case 'never_auto': {
      setTrustAutoExecute(command.actionClass, groupId, false, 1.0);
      return `\u{1F510} \`${command.actionClass}\` is now permanently gated \u2014 will always ask for approval.`;
    }

    case 'reset': {
      resetTrustLevels(groupId);
      return '\u{1F504} Trust levels reset to cold start. All actions will require approval again.';
    }

    case 'what_did_i_miss': {
      return generateCatchUpSummary(groupId);
    }
  }
}

/**
 * Default lookback window for "what did I miss" (6 hours).
 * In the future this could use the actual last user message timestamp.
 */
const CATCH_UP_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Human-readable label for event types in the catch-up summary.
 */
function eventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    'message.inbound': 'Messages received',
    'message.outbound': 'Messages sent',
    'task.complete': 'Tasks completed',
    'task.queued': 'Tasks queued',
    'trust.request': 'Trust approvals requested',
    'trust.approved': 'Trust actions approved',
    'trust.denied': 'Trust actions denied',
    'email.received': 'Emails processed',
    'webhook.received': 'Webhooks received',
    'system.error': 'System errors',
  };
  return labels[type] || type;
}

/**
 * Generate a catch-up summary of events since the last interaction.
 */
function generateCatchUpSummary(groupId: string): string {
  const since = Date.now() - CATCH_UP_WINDOW_MS;
  const events = queryEvents({ since, limit: 500 });

  const header = `\u{1F4DD} *What you missed*\n_Since ${formatLocalTime(new Date(since).toISOString(), TIMEZONE)}_\n`;

  if (events.length === 0) {
    return `${header}\nAll quiet \u2014 nothing happened while you were away.`;
  }

  // Count by type
  const byType = new Map<string, number>();
  for (const e of events) {
    byType.set(e.event_type, (byType.get(e.event_type) || 0) + 1);
  }

  const lines: string[] = [header];

  for (const [type, count] of byType) {
    lines.push(`  \u{2022} ${eventTypeLabel(type)}: ${count}`);
  }

  // Highlight errors
  const errors = events.filter((e) => e.event_type === 'system.error');
  if (errors.length > 0) {
    lines.push('');
    lines.push(`\u{26A0}\u{FE0F} *${errors.length} error(s)* \u2014 check logs.`);
  }

  // Pending approvals
  const pendingApprovals = getPendingTrustApprovalIds(groupId);
  if (pendingApprovals.length > 0) {
    lines.push('');
    lines.push(
      `\u{1F510} *${pendingApprovals.length} pending approval(s)* awaiting your decision.`,
    );
  }

  return lines.join('\n').trim();
}
