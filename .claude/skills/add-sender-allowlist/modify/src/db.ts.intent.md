# Intent: src/db.ts modifications for sender-allowlist skill

## What changed

One change to two queries — no logic removed, no refactoring:

1. **Added `is_from_me` to SELECT projections** in `getNewMessages` and `getMessagesSince`:
   - Before: `SELECT id, chat_jid, sender, sender_name, content, timestamp`
   - After: `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me`

## Why

The `is_from_me` column already exists in the messages table (stored on INSERT) but was not projected by these two read queries. The sender-allowlist skill needs this field in trigger gating so that self-sent trigger messages always bypass the allowlist check. Without it, the owner's triggers could be blocked if their sender ID isn't in the allowlist.

## Invariants

- **No WHERE clause changes**: only the SELECT column list is affected.
- **No schema changes**: `is_from_me` column already exists (added in original schema).
- **Type-safe**: `NewMessage.is_from_me` is already defined as `boolean | undefined` in types.ts. SQLite returns 0/1 which is falsy/truthy in JS.
