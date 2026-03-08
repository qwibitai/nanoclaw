# Intent: Add reaction storage and quote fields to database

1. Import `Reaction` type from types.ts
2. Add `quoted_message_id`, `quote_sender_name`, `quote_content` columns to messages table schema
3. Add `reactions` table (id, chat_jid, message_id, emoji, timestamp)
4. Add migration to add quote columns to existing DBs
5. Add migration to recreate old reactions table if it has the old `reactor_jid` schema
6. Update `storeMessage()` to persist quote fields
7. Update `getNewMessages()` and `getMessagesSince()` SELECT to include quote fields
8. Add `storeReaction()`, `getLatestMessage()`, `getMessageById()` helper functions

All changes are additive — existing queries and functions continue to work.
