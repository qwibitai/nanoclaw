-- Fix Telegram DM chats incorrectly marked as groups.
-- Migration 005 set is_group=1 for all tg: chats, but positive Telegram IDs
-- are DMs (private chats) and only negative IDs are groups/supergroups/channels.
UPDATE chats SET is_group = 0 WHERE jid LIKE 'tg:%' AND jid NOT LIKE 'tg:-%';
