# NanoClaw Telegram Setup — Session Notes (2026-02-20)

## Overview

This session added Telegram as the primary channel for NanoClaw, replacing WhatsApp. The assistant was also renamed from Andy to Saga. Three issues were encountered and resolved.

---

## Issue 1: Skills system not initialized

### Symptom
Running `npx tsx scripts/apply-skill.ts .claude/skills/add-telegram` failed immediately:

```
Error: .nanoclaw/state.yaml not found. Run initSkillsSystem() first.
```

### Cause
The skills engine requires a `.nanoclaw/` directory with a `state.yaml` file before it can apply any skill. This directory didn't exist yet. The `apply-skill.ts` script has no `--init` flag — passing one caused it to look for a skill directory literally named `--init`.

### Fix
Created a temporary one-line script to call `initSkillsSystem()` from `skills-engine/migrate.ts` directly, ran it, then deleted it:

```ts
// _init-skills.ts (temporary, deleted after use)
import { initSkillsSystem } from './skills-engine/migrate.js';
initSkillsSystem();
```

```bash
npx tsx _init-skills.ts
rm _init-skills.ts
```

---

## Issue 2: Service crashed after Telegram skill was applied — "Apple Container system failed to start"

### Symptom
After applying the Telegram skill, building, and restarting the service, it crashed immediately. `logs/nanoclaw.error.log` showed:

```
╔════════════════════════════════════════════════════════════════╗
║  FATAL: Apple Container system failed to start                 ║
╚════════════════════════════════════════════════════════════════╝
```

This persisted even after a clean `rm -rf dist && npm run build`.

### Cause
The Telegram skill's three-way merge of `src/index.ts` did not include changes from the earlier Docker migration (PR #323). The old inline `ensureContainerSystemRunning()` function — which called Apple Container CLI commands (`container system status`, `container system start`) — was still present in `src/index.ts`. The correct Docker-based implementation had already been extracted into `src/container-runtime.ts` as `ensureContainerRuntimeRunning()` and `cleanupOrphans()`, but `index.ts` was never updated to use it.

### Fix
- Removed the old `ensureContainerSystemRunning()` function from `src/index.ts`
- Added import of `ensureContainerRuntimeRunning` and `cleanupOrphans` from `./container-runtime.js`
- Replaced the single call site in `main()`:

```ts
// Before
ensureContainerSystemRunning();

// After
ensureContainerRuntimeRunning();
cleanupOrphans();
```

- Removed the now-unused `import { execSync } from 'child_process'` at the top of `index.ts`

---

## Issue 3: Bot connected but didn't respond to incoming Telegram messages

### Symptom
Outbound messages worked (IPC test message delivered successfully). But messages sent to Saga in Telegram got no response and left no trace in the logs — no "Telegram message stored", no errors, nothing.

### Cause
The channel registration script (`06-register-channel.sh`) writes directly to SQLite. However, the running service holds an **in-memory copy** of registered groups that is only loaded from the database at startup. Since the Telegram chat (`tg:6402709414`) was registered *after* the service had already started, the in-memory map didn't include it.

When a message arrived, the Telegram message handler looked up the JID in the in-memory map, found nothing, and silently returned early — dropping the message with only a `debug`-level log that doesn't appear in normal log output.

### Fix
Restart the service so it reloads `registeredGroups` from the database on startup:

```bash
systemctl --user restart nanoclaw
```

### Prevention
Any time a channel is registered while the service is running, a restart is required for incoming messages to be processed. Alternatively, the registration could be done via the IPC `register_group` task type, which updates the in-memory map without requiring a restart.

---

## Changes Committed

**Commit:** `0e5518c` — `feat: add Telegram channel and rename assistant to Saga`

| File | Change |
|------|--------|
| `src/channels/telegram.ts` | New — TelegramChannel class using grammy |
| `src/channels/telegram.test.ts` | New — 50 unit tests |
| `src/index.ts` | Multi-channel support, fixed Apple Container remnant |
| `src/config.ts` | Added TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY exports |
| `src/routing.test.ts` | Updated for multi-channel routing |
| `src/task-scheduler.ts` | Minor updates from skill merge |
| `src/group-queue.ts` | Minor updates from skill merge |
| `package.json` / `package-lock.json` | Added `grammy` dependency |
| `.env.example` | Added TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY |
| `groups/main/CLAUDE.md` | Renamed Andy → Saga |
