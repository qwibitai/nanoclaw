import Database from 'better-sqlite3';

export type MessagePriority = 'critical' | 'high' | 'normal' | 'low';
export type MessageStatus =
  | 'pending'
  | 'batched'
  | 'sending'
  | 'sent'
  | 'failed';
export type MessageTemplate = 'alert' | 'digest' | 'notification' | 'custom';

export interface OutboundMessage {
  id: string;
  recipient_id: string;
  recipient_type: string;
  template: MessageTemplate;
  content: string;
  priority: MessagePriority;
  status: MessageStatus;
  scheduled_for: string | null;
  batch_key: string | null;
  batch_window: number;
  retry_count: number;
  created_at: string;
  sent_at: string | null;
  error_message: string | null;
}

let db: Database.Database;

/** @internal */
export function _setOutboundMessagesDb(database: Database.Database): void {
  db = database;
}

export function insertOutboundMessage(
  msg: Omit<OutboundMessage, 'retry_count' | 'sent_at' | 'error_message'>,
): void {
  db.prepare(
    `INSERT INTO outbound_messages
       (id, recipient_id, recipient_type, template, content, priority, status,
        scheduled_for, batch_key, batch_window, retry_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    msg.id,
    msg.recipient_id,
    msg.recipient_type,
    msg.template,
    msg.content,
    msg.priority,
    msg.status,
    msg.scheduled_for,
    msg.batch_key,
    msg.batch_window,
    msg.created_at,
  );
}

export function getOutboundMessage(id: string): OutboundMessage | undefined {
  return db
    .prepare('SELECT * FROM outbound_messages WHERE id = ?')
    .get(id) as OutboundMessage | undefined;
}

/** Get pending messages ready to send, ordered by priority then age. */
export function getPendingMessages(limit: number = 50): OutboundMessage[] {
  const priorityOrder = `CASE priority
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'normal' THEN 2
    WHEN 'low' THEN 3
    ELSE 4 END`;
  return db
    .prepare(
      `SELECT * FROM outbound_messages
       WHERE status = 'pending'
         AND (scheduled_for IS NULL OR scheduled_for <= ?)
       ORDER BY ${priorityOrder}, created_at
       LIMIT ?`,
    )
    .all(new Date().toISOString(), limit) as OutboundMessage[];
}

/** Get batched messages matching a batch key that are within their batch window. */
export function getBatchedMessages(batchKey: string): OutboundMessage[] {
  return db
    .prepare(
      `SELECT * FROM outbound_messages
       WHERE batch_key = ? AND status IN ('pending', 'batched')
       ORDER BY created_at`,
    )
    .all(batchKey) as OutboundMessage[];
}

export function updateMessageStatus(
  id: string,
  status: MessageStatus,
  errorMessage?: string,
): void {
  if (status === 'sent') {
    db.prepare(
      `UPDATE outbound_messages
       SET status = ?, sent_at = ?, error_message = NULL
       WHERE id = ?`,
    ).run(status, new Date().toISOString(), id);
  } else if (status === 'failed') {
    db.prepare(
      `UPDATE outbound_messages
       SET status = ?, error_message = ?, retry_count = retry_count + 1
       WHERE id = ?`,
    ).run(status, errorMessage ?? null, id);
  } else {
    db.prepare('UPDATE outbound_messages SET status = ? WHERE id = ?').run(
      status,
      id,
    );
  }
}

/** Count messages sent to a recipient within a time window (for rate limiting). */
export function countRecentMessages(
  recipientId: string,
  windowMs: number,
): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM outbound_messages
       WHERE recipient_id = ? AND created_at > ?
         AND status IN ('pending', 'batched', 'sending', 'sent')`,
    )
    .get(recipientId, since) as { count: number };
  return row.count;
}
