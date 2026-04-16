import { getDb } from './connection.js';

export interface OutboxMessage {
  id: number;
  chatJid: string;
  text: string;
  createdAt: string;
  attempts: number;
}

export function enqueueOutbox(chatJid: string, text: string): void {
  getDb()
    .prepare('INSERT INTO outbox (chat_jid, text, created_at) VALUES (?, ?, ?)')
    .run(chatJid, text, new Date().toISOString());
}

export function getOutboxMessages(): OutboxMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM outbox ORDER BY id ASC')
    .all() as Array<{
    id: number;
    chat_jid: string;
    text: string;
    created_at: string;
    attempts: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    chatJid: r.chat_jid,
    text: r.text,
    createdAt: r.created_at,
    attempts: r.attempts,
  }));
}

export function deleteOutboxMessage(id: number): void {
  getDb().prepare('DELETE FROM outbox WHERE id = ?').run(id);
}

export function incrementOutboxAttempts(id: number): void {
  getDb()
    .prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?')
    .run(id);
}
