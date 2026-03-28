import { getDb } from './db.js';
import { logger } from './logger.js';

export interface ShadowResponse {
  id: number;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  response: string;
  created_at: string;
  would_have_sent_at: string;
}

/**
 * Returns true if the given group JID has shadow_mode enabled.
 */
export function isGroupInShadowMode(jid: string): boolean {
  const row = getDb()
    .prepare('SELECT shadow_mode FROM registered_groups WHERE jid = ?')
    .get(jid) as { shadow_mode: number } | undefined;
  return row?.shadow_mode === 1;
}

/**
 * Sets shadow mode on or off for a group.
 */
export function setShadowMode(jid: string, enabled: boolean): void {
  getDb()
    .prepare('UPDATE registered_groups SET shadow_mode = ? WHERE jid = ?')
    .run(enabled ? 1 : 0, jid);
}

/**
 * Returns the current shadow message count for a group.
 */
export function getShadowMessageCount(jid: string): number {
  const row = getDb()
    .prepare(
      'SELECT shadow_message_count FROM registered_groups WHERE jid = ?',
    )
    .get(jid) as { shadow_message_count: number } | undefined;
  return row?.shadow_message_count ?? 0;
}

/**
 * Returns the shadow activation threshold for a group.
 */
export function getShadowActivationThreshold(jid: string): number {
  const row = getDb()
    .prepare(
      'SELECT shadow_activation_threshold FROM registered_groups WHERE jid = ?',
    )
    .get(jid) as { shadow_activation_threshold: number } | undefined;
  return row?.shadow_activation_threshold ?? 10;
}

/**
 * Increments the shadow message count by 1. If the count meets or exceeds
 * the activation threshold, calls activateShadowGroup.
 */
export function incrementShadowMessageCount(jid: string): void {
  getDb()
    .prepare(
      'UPDATE registered_groups SET shadow_message_count = shadow_message_count + 1 WHERE jid = ?',
    )
    .run(jid);

  const count = getShadowMessageCount(jid);
  const threshold = getShadowActivationThreshold(jid);
  if (count >= threshold) {
    activateShadowGroup(jid);
  }
}

/**
 * Stores a shadow response (what the bot would have sent in a real group).
 */
export function storeShadowResponse(
  groupFolder: string,
  chatJid: string,
  prompt: string,
  response: string,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO shadow_responses (group_folder, chat_jid, prompt, response, created_at, would_have_sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(groupFolder, chatJid, prompt, response, now, now);
}

/**
 * Retrieves shadow responses for a group, newest first. Optionally limited.
 */
export function getShadowResponses(
  groupFolder: string,
  limit?: number,
): ShadowResponse[] {
  let sql =
    'SELECT * FROM shadow_responses WHERE group_folder = ? ORDER BY created_at DESC';
  if (limit !== undefined) {
    sql += ` LIMIT ${limit}`;
  }
  return getDb().prepare(sql).all(groupFolder) as ShadowResponse[];
}

/**
 * Activates a shadow group: sets shadow_mode=0 and resets the message count.
 */
export function activateShadowGroup(jid: string): void {
  getDb()
    .prepare(
      'UPDATE registered_groups SET shadow_mode = 0, shadow_message_count = 0 WHERE jid = ?',
    )
    .run(jid);
  logger.info('Shadow group activated: ' + jid);
}
