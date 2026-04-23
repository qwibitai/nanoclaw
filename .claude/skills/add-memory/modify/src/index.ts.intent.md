# Intent: src/index.ts modifications

## What changed
Integrated the memory system into the message processing pipeline and agent invocation.

## Key sections
- **Imports**: Added `import { buildMemorySnapshot, embedConversationMessages, initMemorySchema, retrieveMemoryContext } from './memory.js'` and `import { DATA_DIR } from './config.js'`
- **main()**: Added `initMemorySchema()` call after `initDatabase()` to create memory tables on startup
- **processGroupMessages()**: Added RAG memory retrieval before formatting the prompt — `retrieveMemoryContext()` is called with missed messages, and the result is prepended to the formatted prompt
- **processGroupMessages()**: Added conversation embedding — after first successful agent output, `embedConversationMessages()` is called asynchronously (fire-and-forget with error logging)
- **runAgent()**: Added memory snapshot writing — `buildMemorySnapshot()` is called and written to `{ipcDir}/memory_snapshot.json` before running the container agent

## Invariants
- All existing message processing, cursor management, and error recovery logic is unchanged
- The sender allowlist system is preserved exactly as-is
- Channel registration and connection logic is unchanged
- The message loop, queue management, and typing indicators remain identical
- Memory failures are gracefully handled — if retrieval fails, the agent runs without memory context

## Must-keep
- All sender-allowlist imports and usage (`isSenderAllowed`, `isTriggerAllowed`, `loadSenderAllowlist`, `shouldDropMessage`)
- The `isMain === true` pattern for main group detection (not `MAIN_GROUP_FOLDER`)
- The channel registry system (`getChannelFactory`, `getRegisteredChannelNames`, barrel import)
- All existing exports (`escapeXml`, `formatMessages`, `getAvailableGroups`, `_setRegisteredGroups`)
- The `syncGroups` IPC dependency (not `syncGroupMetadata`)
- Error recovery with cursor rollback in `processGroupMessages`
