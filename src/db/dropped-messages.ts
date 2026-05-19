import { getDb } from './connection.js';

export interface UnregisteredSender {
  channel_type: string;
  platform_id: string;
  user_id: string | null;
  sender_name: string | null;
  reason: string;
  messaging_group_id: string | null;
  agent_group_id: string | null;
  message_count: number;
  first_seen: string;
  last_seen: string;
}

export function recordDroppedMessage(msg: {
  channel_type: string;
  platform_id: string;
  user_id: string | null;
  sender_name: string | null;
  reason: string;
  messaging_group_id: string | null;
  agent_group_id: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO unregistered_senders (channel_type, platform_id, user_id, sender_name, reason, messaging_group_id, agent_group_id, message_count, first_seen, last_seen)
       VALUES (@channel_type, @platform_id, @user_id, @sender_name, @reason, @messaging_group_id, @agent_group_id, 1, @now, @now)
       ON CONFLICT (channel_type, platform_id) DO UPDATE SET
         user_id = COALESCE(excluded.user_id, unregistered_senders.user_id),
         sender_name = COALESCE(excluded.sender_name, unregistered_senders.sender_name),
         reason = excluded.reason,
         message_count = unregistered_senders.message_count + 1,
         last_seen = excluded.last_seen`,
    )
    .run({ ...msg, now });
}

export function getUnregisteredSenders(limit = 50): UnregisteredSender[] {
  return getDb()
    .prepare('SELECT * FROM unregistered_senders ORDER BY last_seen DESC LIMIT ?')
    .all(limit) as UnregisteredSender[];
}
