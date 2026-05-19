import type { UserDm } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

export function upsertUserDm(row: UserDm): void {
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (@user_id, @channel_type, @messaging_group_id, @resolved_at)
       ON CONFLICT(user_id, channel_type) DO UPDATE SET
         messaging_group_id = excluded.messaging_group_id,
         resolved_at = excluded.resolved_at`,
    )
    .run(row);
}

export function getUserDm(userId: string, channelType: string): UserDm | undefined {
  return getDb().prepare('SELECT * FROM user_dms WHERE user_id = ? AND channel_type = ?').get(userId, channelType) as
    | UserDm
    | undefined;
}

export function getUserDmsForUser(userId: string): UserDm[] {
  return getDb().prepare('SELECT * FROM user_dms WHERE user_id = ?').all(userId) as UserDm[];
}

export function deleteUserDm(userId: string, channelType: string): void {
  getDb().prepare('DELETE FROM user_dms WHERE user_id = ? AND channel_type = ?').run(userId, channelType);
}
