/**
 * Rollout Manager
 * Groups consecutive agent turns from the same chat into evaluation windows.
 * A rollout closes when it reaches ROLLOUT_SIZE turns or after ROLLOUT_INACTIVITY_MS
 * of silence.
 */
import { ROLLOUT_INACTIVITY_MS, ROLLOUT_SIZE } from '../config.js';
import {
  getOpenRollout,
  getStaleOpenRollouts,
  insertRollout,
  updateRollout,
} from '../db.js';
import { logger } from '../logger.js';
import { Rollout } from '../types.js';

/**
 * Get the current open rollout for a chat, or create a new one.
 * Closes the existing rollout first if it has reached ROLLOUT_SIZE turns.
 */
export function getOrCreateRollout(
  chatJid: string,
  groupFolder: string,
): Rollout {
  const existing = getOpenRollout(chatJid);
  const now = new Date().toISOString();

  if (existing) {
    if (existing.turn_count >= ROLLOUT_SIZE) {
      // Close the full rollout and start a new one
      updateRollout(existing.id, { status: 'closed', closed_at: now });
      logger.info(
        { rolloutId: existing.id, turns: existing.turn_count },
        'Rollout closed: reached max turns',
      );
    } else {
      // Increment turn count and update activity timestamp
      updateRollout(existing.id, {
        turn_count: existing.turn_count + 1,
        last_activity_at: now,
      });
      return {
        ...existing,
        turn_count: existing.turn_count + 1,
        last_activity_at: now,
      };
    }
  }

  // Create a new rollout
  const id = `rollout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rollout: Rollout = {
    id,
    group_folder: groupFolder,
    chat_jid: chatJid,
    status: 'open',
    turn_count: 1,
    created_at: now,
    closed_at: null,
    last_activity_at: now,
  };
  insertRollout(rollout);
  logger.debug({ rolloutId: id, chatJid }, 'New rollout opened');
  return rollout;
}

/**
 * Close any open rollouts that have been inactive beyond ROLLOUT_INACTIVITY_MS.
 * Call this periodically from the evaluation loop.
 */
export function closeStaleRollouts(): void {
  const cutoff = new Date(Date.now() - ROLLOUT_INACTIVITY_MS).toISOString();
  const stale = getStaleOpenRollouts(cutoff);

  for (const rollout of stale) {
    const now = new Date().toISOString();
    updateRollout(rollout.id, { status: 'closed', closed_at: now });
    logger.info(
      { rolloutId: rollout.id, turns: rollout.turn_count },
      'Rollout closed: inactivity timeout',
    );
  }
}
