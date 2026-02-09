# Agent Guidelines for NanoClaw

This document provides essential information for AI agents operating within the NanoClaw repository. Follow these guidelines to ensure consistency, stability, and code quality.

## 1. Build & Development Commands

This project is a Node.js application using TypeScript (ESM) and Docker.

- **Build Project:**

  ```bash
  npm run build
  ```

  Runs `tsc` to compile TypeScript to `dist/`.

- **Start (Production):**

  ```bash
  npm start
  ```

  Runs the compiled code from `dist/index.js`.

- **Development Mode:**

  ```bash
  npm run dev
  ```

  Runs `src/index.ts` directly using `tsx` with watch mode.

- **Type Checking:**

  ```bash
  npm run typecheck
  ```

  Runs `tsc --noEmit` to verify type safety. **Always run this after modifying code.**

- **Formatting:**

  ```bash
  npm run format
  npm run format:check
  ```

  Uses Prettier. Ensure code is formatted before finishing a task.

## 2. Testing

**Current Status:** No formal test runner (Jest/Vitest) is currently configured in `package.json`.

- **Running a Single "Test" / Script:**
  Since there is no test harness, use `tsx` to execute individual files or ad-hoc test scripts:

  ```bash
  npx tsx src/path/to/script.ts
  ```

- **Adding Tests:**
  If you are asked to add tests, standard `vitest` or `jest` would be appropriate, but do not add dependencies unless explicitly requested. For now, rely on `typecheck` and manual verification via `tsx` scripts if needed.

## 3. Code Style & Conventions

Adhere strictly to the following conventions to match the existing codebase.

### TypeScript & Imports

- **Module System:** NodeNext (ESM).
- **Import Extensions:** You **MUST** include the `.js` extension for relative imports.

  ```typescript
  // CORRECT
  import { config } from './config.js';

  // INCORRECT
  import { config } from './config';
  ```

- **Strict Mode:** `strict: true` is enabled. No `any` unless absolutely necessary (and documented).
- **Types:** Define interfaces in `src/types.ts` if shared, or locally if private.

### Formatting & Naming

- **Formatter:** Prettier (single quotes, trailing commas).
- **Variables/Functions:** `camelCase` (e.g., `processMessage`, `registeredGroups`).
- **Types/Interfaces:** `PascalCase` (e.g., `ScheduledTask`, `NewMessage`).
- **Constants:** `UPPER_SNAKE_CASE` (e.g., `POLL_INTERVAL`, `DATA_DIR`).
- **Filenames:** `kebab-case` (e.g., `task-scheduler.ts`, `container-runner.ts`).

### Error Handling & Logging

- **Logger:** Use the global `logger` instance (Pino).
- **Pattern:** Catch errors and log them with context objects.
  ```typescript
  try {
    // ... operation
  } catch (err) {
    logger.error({ err, contextId }, 'Description of error');
  }
  ```
- **Process Exit:** Do not use `process.exit()` in library code. Only in fatal startup errors in `index.ts`.

### Database (SQLite)

- **Library:** `better-sqlite3`.
- **Queries:** Write raw SQL strings in `src/db.ts`. Use prepared statements (`?`) for all variable inputs.
- **Migrations:** Add new `CREATE TABLE` or `ALTER TABLE` statements in `initDatabase()` within `src/db.ts`. Wrap `ALTER` in `try...catch` to handle "column already exists" cases gracefully.

## 4. Architecture Overview

- **Entry Point:** `src/index.ts` manages the Discord connection (`discord.js`) and the main event loop.
- **Agent Runner:** `src/container-runner.ts` spawns Docker containers for agents.
- **Data:**
  - `groups/`: Isolated filesystem for each agent group.
  - `data/`: Shared state and database (`messages.db`).
- **IPC:** Communication between the host (NanoClaw) and agents happens via file-based IPC in `data/ipc/`.

## 5. Critical Rules for Agents

1. **Docker Requirement:** The system relies on Docker. Do not modify container logic unless you understand the security implications (mounts, isolation).
2. **Database Integrity:** Always use the exported functions in `src/db.ts`. Do not write raw SQL in other files.
3. **Safety:** When modifying `src/index.ts`, ensure the message loop (`startMessageLoop`) and IPC watcher (`startIpcWatcher`) are preserved to maintain system liveness.

## 6. Service Management

If running as a systemd service (Linux):

- **Restart Service:**

  ```bash
  systemctl --user restart nanoclaw
  ```

- **Check Status:**

  ```bash
  systemctl --user status nanoclaw
  ```

- **View Logs:**
  ```bash
  journalctl --user -u nanoclaw -f
  ```
