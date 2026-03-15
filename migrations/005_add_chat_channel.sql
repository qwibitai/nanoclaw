ALTER TABLE chats ADD COLUMN channel TEXT;
ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0;

-- Backfill from JID patterns
UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us';
UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net';
UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%';
UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%';
