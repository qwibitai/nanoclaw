# Intent: src/db.ts modifications

## What changed
Added media attachment storage to the messages table and updated all message read/write functions.

## Key changes

### Import
Added `MediaAttachment` from types.

### Schema migration
Added `attachments TEXT` column to `messages` table via ALTER TABLE (same safe migration pattern as other columns). Placed after existing migration blocks. Attachments are stored as JSON-serialized `MediaAttachment[]`.

### storeMessage()
- SQL INSERT now includes `attachments` column (9th parameter)
- Serializes `msg.attachments` to JSON, or null if no attachments

### storeMessageDirect()
- Added `attachments?: MediaAttachment[]` to parameter type
- SQL INSERT now includes `attachments` column
- Same JSON serialization as storeMessage()

### getNewMessages()
- SELECT now includes `attachments` column
- Return type changed from raw rows to parsed rows: `row.attachments` (JSON string) is parsed back to `MediaAttachment[]`
- Returns `undefined` for messages without attachments

### getMessagesSince()
- SELECT now includes `attachments` column
- Same JSON parse pattern as getNewMessages()

## Invariants
- All existing queries and functions are preserved
- The migration uses try/catch to be idempotent (safe to run multiple times)
- NULL attachments in DB → undefined in TypeScript (not empty array)

## Must-keep
- All existing table schemas and migration blocks
- The is_bot_message filter logic in getNewMessages/getMessagesSince
- All registered group accessors and their column handling
- All task, router state, session, and chat metadata functions
