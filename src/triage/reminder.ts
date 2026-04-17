import { getDb } from '../db.js';
import { sendTelegramMessage } from '../channels/telegram.js';
import { logger } from '../logger.js';

/**
 * Scan tracked_items for attention-queue items that are still open
 * (state IN ('pushed','pending')) and older than `windowHours` since detection,
 * and that have never been reminded. For each one, send a single Telegram
 * reminder and stamp `reminded_at` so we never re-send.
 */
export async function runAttentionReminderSweep(opts: {
  windowHours: number;
}): Promise<void> {
  const chatId = process.env.EMAIL_INTEL_TG_CHAT_ID;
  if (!chatId) return;

  const windowMs = opts.windowHours * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  const rows = getDb()
    .prepare(
      `SELECT id, title FROM tracked_items
       WHERE state IN ('pushed', 'pending')
         AND detected_at <= ?
         AND reminded_at IS NULL`,
    )
    .all(cutoff) as Array<{ id: string; title: string }>;

  for (const r of rows) {
    // Claim the item via CAS: only reminded_at=NULL rows get stamped. If two
    // sweeps (or a restarted process) see the same row, only one wins.
    // Stamping BEFORE the send means a crash mid-send means we skip the
    // reminder — preferable to double-reminding the user.
    const claim = getDb()
      .prepare(
        `UPDATE tracked_items SET reminded_at = ?
         WHERE id = ? AND reminded_at IS NULL`,
      )
      .run(Date.now(), r.id);
    if (claim.changes !== 1) continue;

    try {
      await sendTelegramMessage(
        chatId,
        `⏰ Still waiting on you: *${r.title}*`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      logger.warn(
        { err: String(err), itemId: r.id },
        'Triage: failed to send attention reminder (already marked reminded)',
      );
    }
  }
}
