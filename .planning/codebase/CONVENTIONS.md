# Coding Conventions

**Analysis Date:** 2026-02-27

## Naming Patterns

**Files:**
- Lowercase with hyphens for separators: `src/container-runner.ts`, `src/group-queue.ts`, `src/task-scheduler.ts`
- Test files: `*.test.ts` (co-located with source)
- Channel implementations: `src/channels/{channel}.ts` (e.g., `whatsapp.ts`, `telegram.ts`)
- Type definitions: `src/types.ts` (single centralized types file)

**Functions:**
- camelCase for all function and method names: `getAvailableGroups()`, `enqueueMessageCheck()`, `buildVolumeMounts()`
- Async functions return `Promise<T>`: `async connect(): Promise<void>`
- Test helper functions: lowercase with underscore prefix for internal/test-only functions: `_initTestDatabase()`, `_resetSchedulerLoopForTests()`

**Variables:**
- camelCase for local variables and properties: `groupJid`, `containerName`, `activatingCount`
- Constants: SCREAMING_SNAKE_CASE: `MAX_CONCURRENT_CONTAINERS`, `GROUP_SYNC_INTERVAL_MS`, `BASE_RETRY_MS`
- Destructuring used extensively: `const { status, result, error } = output`

**Types and Interfaces:**
- PascalCase for interfaces: `Channel`, `RegisteredGroup`, `ContainerInput`, `ContainerOutput`, `GroupState`
- Interfaces declare public contracts (e.g., `Channel` abstract protocol, `OnInboundMessage` callback type)
- Internal interfaces prefixed with implementation detail: `interface QueuedTask` (internal to `GroupQueue`)

**Database/ORM:**
- Snake_case for database columns and return objects: `chat_jid`, `sender_name`, `is_from_me`, `is_bot_message`, `created_at`
- Mapping to TypeScript interfaces: `NewMessage`, `RegisteredGroup`, `ScheduledTask`

## Code Style

**Formatting:**
- Tool: Prettier with single-quote option
- Config: `.prettierrc` with `"singleQuote": true`
- Run: `npm run format` or `npm run format:check`
- Single quotes for all strings: `'whatsapp'`, `'group@g.us'`, `'messages'`

**Linting:**
- No dedicated ESLint config file found; uses Prettier for formatting only
- TypeScript strict mode via `typescript` and `@types` packages

**Import Organization:**
Order:
1. Node.js built-in modules: `import fs from 'fs'`, `import path from 'path'`
2. Third-party packages: `import pino from 'pino'`, `import makeWASocket from '@whiskeysockets/baileys'`
3. Relative imports from same codebase: `import { logger } from '../logger.js'`, `import { Channel } from '../types.js'`
4. Side effects and re-exports: `export { escapeXml, formatMessages } from './router.js'`

**Path Aliases:**
- No path aliases configured; uses relative imports with `.js` extensions (ESM)
- File paths always include `.js` extension: `import { logger } from './logger.js'`

## Error Handling

**Patterns:**
- `.catch()` chains for Promise-based error handling: most async errors caught at call site
- Example: `await fetchLatestWaWebVersion({}).catch((err) => { logger.warn(...); return { version: undefined }; })`
- `try/catch` blocks for synchronous operations or when recovery is needed
- Example from `src/db.ts`: migrations wrap `ALTER TABLE` in try/catch to handle "column already exists" cases
- Errors logged via `logger.error()`, `logger.warn()` with structured context: `{ err, groupJid, taskId }`
- Functions throw `Error` when contract is violated: `throw new Error('No channel for JID: ' + jid)`
- No error re-throwing without context; always add context fields to logger calls

## Logging

**Framework:** Pino with pino-pretty transport

**Setup:** `src/logger.ts`
- Level controlled by `LOG_LEVEL` env var, defaults to `info`
- Pretty-printed colored output in development
- Uncaught exceptions and unhandled rejections routed through logger before exit/error

**Patterns:**
- Structured logging: pass object with context fields, then message
- Example: `logger.info({ groupCount: 10 }, 'State loaded')`
- Severity levels: `logger.debug()`, `logger.info()`, `logger.warn()`, `logger.error()`, `logger.fatal()`
- Always include relevant IDs/identifiers in context: `{ groupJid }`, `{ taskId, groupFolder }`, `{ err }`
- Don't log at trace level; minimum is debug

## Comments

**When to Comment:**
- Explain *why* non-obvious decisions were made, not *what* the code does
- Security/safety decisions get explanatory comments
- Example from `src/container-runner.ts`: "Main gets the project root read-only... prevents the agent from modifying host application code"
- Example from `src/db.ts`: "Add context_mode column if it doesn't exist (migration for existing DBs)"
- Non-obvious algorithms or regex patterns get a comment explaining intent
- Public API functions in interfaces get TSDoc-style comments (see `src/types.ts`)

**JSDoc/TSDoc:**
- Used on exported interfaces and callback types
- Example from `src/types.ts`:
  ```typescript
  /**
   * Mount Allowlist - Security configuration for additional mounts
   * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
   * and is NOT mounted into any container, making it tamper-proof from agents.
   */
  export interface MountAllowlist { ... }
  ```
- Callback types documented: `// Callback for chat metadata discovery.`
- Implementation details in comments, not docstrings

## Function Design

**Size:**
- Functions generally 20-60 lines; large orchestration functions like `runContainerAgent()` reach 200+ lines
- Keep sync functions < 40 lines; async handlers can be longer

**Parameters:**
- Prefer parameter objects over many positional args
- Example: `interface ContainerInput { prompt, sessionId, groupFolder, chatJid, ... }`
- Inject dependencies via constructor or parameters: `constructor(opts: WhatsAppChannelOpts)`
- Dependency injection pattern used for testing: `startSchedulerLoop()` takes `deps` object

**Return Values:**
- Always return early for error/edge cases
- Example from `src/index.ts`: `if (!channel) throw new Error(...)`
- Void functions that need to signal failure use `logger.warn()` + return
- Example: invalid folder in group registration logs warning and returns early

## Module Design

**Exports:**
- Modules export named functions/classes; no default exports
- Example: `export function escapeXml()`, `export class WhatsAppChannel`
- Test utilities prefixed with underscore: `export function _initTestDatabase()`
- Public API vs internal marked by prefix convention

**Barrel Files:**
- Not used; imports are always direct: `import { logger } from './logger.js'`
- `src/index.ts` is orchestrator, not a barrel

**Module Responsibilities:**
- Single responsibility: `db.ts` handles all database ops, `logger.ts` sets up logging, `types.ts` exports all type definitions
- Clear boundaries: channels separate (`src/channels/`), container ops isolated (`container-runner.ts`, `container-runtime.ts`)
- Queue management isolated: `group-queue.ts` handles only concurrency, task execution passed in

---

*Convention analysis: 2026-02-27*
