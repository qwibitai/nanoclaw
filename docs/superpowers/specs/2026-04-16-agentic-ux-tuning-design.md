# Agentic UX Phase 4 — Live Tuning & Smoke Test

**Date:** 2026-04-16
**Status:** Draft
**Depends on:** Phase 3 (complete)

## Overview

The agentic UX modules are feature-complete. This phase adds runtime tunability and operational verification:

1. **DB-backed config** — store tunable parameters in SQLite, read at runtime
2. **Chat commands** — `config list/set/reset` and `smoketest` via Telegram
3. **Draft enrichment prompt** — extract to configurable template with thread context
4. **Smoke test** — runtime health check of all agentic UX components

## 1. DB-Backed UX Config

### 1.1 Schema

New table `ux_config`:

```sql
CREATE TABLE IF NOT EXISTS ux_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 1.2 Tunables

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `batcher.maxItems` | number | `5` | Flush batcher after N items |
| `batcher.maxWaitMs` | number | `10000` | Debounce window in ms |
| `enrichment.maxBodyLength` | number | `200` | Skip drafts longer than this |
| `enrichment.maxAgeMinutes` | number | `30` | Skip drafts older than this |
| `enrichment.timeoutMs` | number | `60000` | Agent timeout for enrichment |
| `enrichment.prompt` | string | (see §3) | Draft enrichment prompt template |
| `classifier.rules` | JSON | (see §1.3) | Classification rules array |

### 1.3 Classifier Rules Format

Stored as JSON in `ux_config` under key `classifier.rules`:

```json
[
  {
    "patterns": ["incoming wire", "direct deposit", "wire transfer"],
    "category": "financial",
    "urgency": "action-required",
    "batchable": false
  }
]
```

Patterns are plain strings converted to case-insensitive regexes at load time. This avoids storing regex syntax in the DB (fragile, hard to edit via chat).

### 1.4 UxConfig Module

New file `src/ux-config.ts`:

```typescript
export class UxConfig {
  constructor(db: Database.Database);

  /** Get a config value, falling back to default if not set */
  get<T>(key: string): T;

  /** Set a config value with validation */
  set(key: string, value: string): void;

  /** Reset a key to its default */
  reset(key: string): void;

  /** List all config keys with current values */
  list(): Array<{ key: string; value: string; default: string; updatedAt: string }>;

  /** Seed defaults on startup (INSERT OR IGNORE) */
  seedDefaults(): void;
}
```

Validation rules per key:
- Number keys: must parse as finite number, must be > 0
- `classifier.rules`: must parse as valid JSON array, each entry must have `patterns` (string[]), `category`, `urgency`, `batchable`
- `enrichment.prompt`: must contain `{body}` placeholder

### 1.5 Consumer Integration

**Classifier:** `classifyMessage()` currently reads from a const `RULES` array. Change to accept an optional `rules` parameter. The caller in `router.ts` (`classifyAndFormat`) reads rules from `UxConfig` and passes them in. `UxConfig.get('classifier.rules')` caches the parsed rules internally (60s TTL via a `lastFetched` timestamp) to avoid DB reads on every message.

**Batcher:** The `MessageBatcher` constructor already accepts `maxItems` and `maxWaitMs`. On `config set`, destroy and recreate the batcher with new values.

**Draft enrichment:** The `evaluateEnrichment` callback reads `enrichment.*` values from `UxConfig` each poll cycle (60s interval — no caching needed).

## 2. Chat Commands

### 2.1 Command Routing

Intercepted in `onMessage` in `index.ts`, before agent dispatch. Same pattern as "archive all":

```typescript
const trimmed = message.content.trim().toLowerCase();
if (trimmed.startsWith('config ') || trimmed === 'config list') {
  // Handle config command
  return;
}
if (trimmed === 'smoketest') {
  // Handle smoke test
  return;
}
```

### 2.2 Config Commands

**`config list`** — Returns formatted list:

```
⚙️ UX Configuration

batcher.maxItems: 5 (default: 5)
batcher.maxWaitMs: 10000 (default: 10000)
enrichment.maxBodyLength: 200 (default: 200)
enrichment.maxAgeMinutes: 30 (default: 30)
enrichment.timeoutMs: 60000 (default: 60000)
enrichment.prompt: [142 chars] (default)
classifier.rules: [6 rules] (default)
```

**`config set <key> <value>`** — Updates the value:
- Validates type and range
- On success: `✅ Set batcher.maxItems = 10`
- On failure: `❌ Invalid value for batcher.maxItems: must be a positive number`

**`config reset <key>`** — Resets to default:
- `✅ Reset batcher.maxItems to default (5)`

### 2.3 Security

Only intercepted from the main Telegram group (same restriction as "archive all"). The `isMain` check on the registered group prevents non-main groups from changing config.

## 3. Draft Enrichment Prompt Template

### 3.1 Default Template

```
You are improving an auto-generated email draft reply.

Subject: {subject}
Thread ID: {threadId}
Current draft body:
---
{body}
---

Instructions:
- Read the email thread for context (use the thread ID above)
- Improve tone, completeness, and professionalism
- Keep the same intent and meaning
- Match the sender's communication style
- Return ONLY the improved body text, nothing else
- If the draft is already adequate, return exactly: NO_CHANGE
```

### 3.2 Template Variables

| Variable | Source |
|----------|--------|
| `{subject}` | `draft.subject` |
| `{threadId}` | `draft.threadId` |
| `{body}` | `draft.body` |
| `{account}` | `draft.account` |
| `{draftId}` | `draft.draftId` |

Simple string replacement via `template.replace(/\{(\w+)\}/g, ...)`.

### 3.3 Integration

In `index.ts`, the `evaluateEnrichment` callback reads `enrichment.prompt` from `UxConfig` instead of using the hardcoded string. Falls back to the default if the DB value is missing or invalid.

## 4. Production Smoke Test

### 4.1 Command

`smoketest` — exact match, case-insensitive. Intercepted in `onMessage`.

### 4.2 Checks

Run sequentially, report each result:

1. **Classifier** — `classifyAndFormat('test payment received')` → expect `category: 'financial'`
2. **Batcher** — Check batcher instance exists and is not destroyed
3. **GmailOps** — `gmailOpsRouter.listRecentDrafts(account)` for each registered account. Verify API responds without error (does not check draft contents).
4. **Archive tracker** — `archiveTracker.getUnarchived()` → report count
5. **Draft watcher** — Check `draftWatcher` is not null and has active interval
6. **UX config** — `uxConfig.list()` → verify returns entries
7. **Mini App** — HTTP GET to `http://localhost:{port}/task/nonexistent` → expect 404

### 4.3 Output Format

```
🔍 Smoke Test Results

✅ Classifier: financial/action-required
✅ Batcher: active (maxItems=5, maxWaitMs=10000)
✅ GmailOps: 2 accounts responding (personal, dev)
✅ Archive tracker: 3 unarchived emails
✅ Draft watcher: running (60s interval)
✅ UX config: 7 keys loaded
✅ Mini App: responding on port 8080
❌ GmailOps: attaxion — TOKEN_EXPIRED

7/8 checks passed
```

### 4.4 Error Handling

Each check wraps in try/catch. A failing check doesn't stop the remaining checks. Timeout per check: 10 seconds.

## 5. File Structure

| File | Responsibility |
|------|---------------|
| `src/ux-config.ts` | DB-backed config read/write/validate |
| `src/chat-commands.ts` | Parse and execute config/smoketest commands |
| `src/message-classifier.ts` | Accept optional rules parameter |
| `src/index.ts` | Wire commands, pass UxConfig to consumers |

## 6. Testing Strategy

- `ux-config.test.ts` — CRUD, validation, defaults, seed
- `chat-commands.test.ts` — parse commands, format output, error cases
- `message-classifier.test.ts` — extend for dynamic rules parameter
- `smoketest.test.ts` — mock all dependencies, verify check sequence and output format
