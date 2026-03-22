# Intent: src/db.ts modifications

## What changed
Added sqlite-vec extension loading and exposed `getDb()` for use by the memory module.

## Key sections
- **Import**: Added `import * as sqliteVec from 'sqlite-vec'` at top
- **getDb() export**: New public function that returns the database instance (needed by `src/memory.ts` to run memory queries)
- **initDatabase()**: Added `sqliteVec.load(db)` call after creating the Database instance, before `createSchema()`

## Invariants
- All existing schema creation, migrations, and accessors remain unchanged
- The `_initTestDatabase()` function does NOT load sqlite-vec (in-memory test DBs don't need it)
- All existing exports are preserved with identical signatures
- The `createSchema()` function is unchanged

## Must-keep
- All existing table schemas (chats, messages, scheduled_tasks, task_run_logs, router_state, sessions, registered_groups)
- All migration ALTER TABLE blocks
- All existing accessor functions (storeMessage, getNewMessages, createTask, etc.)
- The `_initTestDatabase()` function for test compatibility
- The `migrateJsonState()` function
- The `is_main` column migration
