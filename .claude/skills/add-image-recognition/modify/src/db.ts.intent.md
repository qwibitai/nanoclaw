# Intent: src/db.ts modifications

## What changed
Added `image_path` support for storing and querying image metadata alongside messages.

## Key sections

### createSchema() — new migration
- Added: `ALTER TABLE messages ADD COLUMN image_path TEXT` migration after the channel/is_group migration
- Uses try/catch pattern consistent with existing migrations

### storeMessage()
- Added: `image_path` as 9th column in INSERT statement
- Uses `msg.image_path || null` to handle optional field

### storeMessageDirect()
- Added: `image_path?: string` to parameter type
- Added: `image_path` as 9th column in INSERT statement
- Uses `msg.image_path || null` to handle optional field

### getNewMessages()
- Added: `image_path` to SELECT columns
- Changed: `AND content != '' AND content IS NOT NULL` to `AND (content != '' OR image_path IS NOT NULL)` to accept image-only messages

### getMessagesSince()
- Added: `image_path` to SELECT columns
- Changed: `AND content != '' AND content IS NOT NULL` to `AND (content != '' OR image_path IS NOT NULL)` to accept image-only messages

## Invariants
- All existing schema, migrations, and functions are unchanged
- Chat metadata functions are untouched
- Task, session, router state, and registered group functions are untouched
- JSON migration logic is untouched

## Must-keep
- All existing migrations (context_mode, is_bot_message, channel/is_group)
- The bot message filtering logic (is_bot_message flag + content prefix backstop)
- All task scheduling functions
- All router state, session, and registered group accessors
