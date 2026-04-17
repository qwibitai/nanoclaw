import {
  editTelegramMessage,
  pinTelegramMessage,
  sendTelegramMessage,
} from '../channels/telegram.js';
import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface DashboardItem {
  id: string;
  title: string;
  reason: string;
  ageMins: number;
}

export interface DashboardInput {
  chatId: string;
  items: DashboardItem[];
}

export interface ArchiveDashboardInput {
  chatId: string;
  counts: Record<string, number>;
  total: number;
  nextDigestHuman: string;
}

const DIVIDER = '────────────────────';

function fmtAttention(items: DashboardItem[]): string {
  const header = `📥 Attention — ${items.length} open`;
  if (items.length === 0) {
    return `${header}\n${DIVIDER}\n(inbox is clear — nothing requires you right now)\n\nLast update: ${new Date().toLocaleTimeString()}`;
  }
  const top = items.slice(0, 5);
  const lines = top.map(
    (it, i) => `${i + 1}. [${it.reason}] ${it.title} · ${it.ageMins}m ago`,
  );
  const tail =
    items.length > 5
      ? `\n+${items.length - 5} more · /attention for full list`
      : '';
  return `${header}\n${DIVIDER}\n${lines.join('\n')}${tail}\n\nLast update: ${new Date().toLocaleTimeString()}`;
}

function fmtArchive(input: ArchiveDashboardInput): string {
  const header = `🗂 Archive queue — ${input.total} pending`;
  const entries = Object.entries(input.counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return `${header}\n${DIVIDER}\n(nothing queued for archive)\n\nNext digest: ${input.nextDigestHuman}\nLast update: ${new Date().toLocaleTimeString()}`;
  }
  const lines = entries.map(([cat, n]) => `• ${cat}: ${n}`);
  return `${header}\n${DIVIDER}\n${lines.join('\n')}\n\nNext digest: ${input.nextDigestHuman}\nLast update: ${new Date().toLocaleTimeString()}`;
}

/**
 * Upsert a pinned dashboard for a given topic. On first call, posts + pins a
 * new message. On subsequent calls, edits the existing pinned message in
 * place. All Telegram errors are logged at warn and swallowed so a failed
 * dashboard update never blocks the caller.
 */
async function upsertDashboard(
  topic: string,
  chatId: string,
  text: string,
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(`SELECT pinned_msg_id FROM triage_dashboards WHERE topic = ?`)
    .get(topic) as { pinned_msg_id: number | null } | undefined;

  if (!row || row.pinned_msg_id === null) {
    try {
      const sent = await sendTelegramMessage(chatId, text);
      await pinTelegramMessage(chatId, sent.message_id);
      db.prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(topic) DO UPDATE SET
           telegram_chat_id = excluded.telegram_chat_id,
           pinned_msg_id = excluded.pinned_msg_id,
           last_rendered_at = excluded.last_rendered_at`,
      ).run(topic, chatId, sent.message_id, Date.now());
    } catch (err) {
      logger.warn(
        { err: String(err), topic },
        'Failed to create triage dashboard',
      );
    }
    return;
  }

  try {
    await editTelegramMessage(chatId, row.pinned_msg_id, text);
    db.prepare(
      `UPDATE triage_dashboards SET last_rendered_at = ? WHERE topic = ?`,
    ).run(Date.now(), topic);
  } catch (err) {
    logger.warn(
      { err: String(err), topic, msgId: row.pinned_msg_id },
      'Failed to edit triage dashboard',
    );
  }
}

export async function renderAttentionDashboard(
  input: DashboardInput,
): Promise<void> {
  await upsertDashboard('attention', input.chatId, fmtAttention(input.items));
}

export async function renderArchiveDashboard(
  input: ArchiveDashboardInput,
): Promise<void> {
  await upsertDashboard('archive', input.chatId, fmtArchive(input));
}
