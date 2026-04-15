import { getDb } from './db.js';
import { DELEGATION_GUARDRAIL_COUNT } from './config.js';
import { logger } from './logger.js';

export function recordDelegation(groupName: string, actionClass: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO delegation_counters (group_name, action_class, count, last_delegated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(group_name, action_class)
     DO UPDATE SET count = count + 1, last_delegated_at = ?`,
  ).run(groupName, actionClass, Date.now(), Date.now());

  logger.debug({ groupName, actionClass }, 'Delegation recorded');
}

export function getDelegationCount(
  groupName: string,
  actionClass: string,
): number {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT count FROM delegation_counters WHERE group_name = ? AND action_class = ?',
    )
    .get(groupName, actionClass) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function shouldRequireApproval(
  groupName: string,
  actionClass: string,
): boolean {
  const count = getDelegationCount(groupName, actionClass);
  return count < DELEGATION_GUARDRAIL_COUNT;
}

export function resetDelegationCount(
  groupName: string,
  actionClass: string,
): void {
  const db = getDb();
  db.prepare(
    'DELETE FROM delegation_counters WHERE group_name = ? AND action_class = ?',
  ).run(groupName, actionClass);
}
