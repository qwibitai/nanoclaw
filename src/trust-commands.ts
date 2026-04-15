/**
 * Trust command parsing and response formatting.
 * Commands: trust status, never auto-execute [class], reset trust, what did I miss
 */

import {
  getAllTrustLevels,
  getDb,
  resetTrustLevels,
  setTrustAutoExecute,
} from './db.js';
import { generateOnDemandDigest } from './digest-engine.js';
import { resetAdjustments } from './classification-adjustments.js';
import { DELEGATION_GUARDRAIL_COUNT } from './config.js';
import type { ActionClass } from './trust-engine.js';

export type TrustCommand =
  | { type: 'status' }
  | { type: 'never_auto'; actionClass: ActionClass }
  | { type: 'reset' }
  | { type: 'what_did_i_miss' }
  | { type: 'dismiss_item'; itemId: string }
  | { type: 'reset_learning' }
  | { type: 'delegation_status' };

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

  if (lower === 'reset learning') {
    return { type: 'reset_learning' };
  }

  const dismissMatch = lower.match(/^dismiss\s+(.+)$/);
  if (dismissMatch) {
    return { type: 'dismiss_item', itemId: dismissMatch[1].trim() };
  }

  if (lower === 'delegation status') {
    return { type: 'delegation_status' };
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
      return generateOnDemandDigest(groupId);
    }

    case 'dismiss_item': {
      markProcessedItemDismissed(command.itemId);
      return `✅ Dismissed: \`${command.itemId}\``;
    }

    case 'reset_learning': {
      resetAdjustments();
      return '🔄 Classification learning reset. All adjustments cleared — back to default rules.';
    }

    case 'delegation_status': {
      const db = getDb();
      const rows = db
        .prepare('SELECT action_class, count, last_delegated_at FROM delegation_counters WHERE group_name = ? ORDER BY count DESC')
        .all(groupId) as Array<{ action_class: string; count: number; last_delegated_at: number | null }>;

      if (rows.length === 0) {
        return '📊 DELEGATION STATUS\n\nNo delegations recorded yet. Use "Handle It" on push notifications to start building delegation trust.';
      }

      let output = '📊 DELEGATION STATUS\n\n';
      for (const row of rows) {
        const guardrailMet = row.count >= DELEGATION_GUARDRAIL_COUNT;
        const status = guardrailMet ? '✅ Auto' : `🔒 ${row.count}/${DELEGATION_GUARDRAIL_COUNT}`;
        output += `${row.action_class}: ${status}\n`;
      }
      return output;
    }
  }
}

function markProcessedItemDismissed(itemId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO processed_items (item_id, source, processed_at, action_taken)
     VALUES (?, 'dismiss', ?, 'dismissed')`,
  ).run(itemId, new Date().toISOString());
}
