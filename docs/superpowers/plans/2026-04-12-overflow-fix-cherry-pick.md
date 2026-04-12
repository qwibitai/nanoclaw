# Message History Overflow Fix Cherry-Pick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate upstream fix (commit `c98205c`) that prevents sending entire message history to agents when cursor is missing.

**Architecture:** Cherry-pick with two known conflicts to resolve manually.

**Tech Stack:** TypeScript, SQLite, vitest

---

### Task 1: Cherry-pick and resolve conflicts

**Files:**
- Modify: `src/config.ts` (add MAX_MESSAGES_PER_PROMPT)
- Modify: `src/db.ts` (add getLastBotMessageTimestamp)
- Modify: `src/index.ts` (add getOrRecoverCursor, update 3 call sites)
- Modify: `src/db.test.ts` (new tests)

- [ ] **Step 1: Attempt the cherry-pick**

```bash
git cherry-pick c98205c --no-commit
```

This will produce conflicts in `src/config.ts` and `src/index.ts`.

- [ ] **Step 2: Resolve config.ts conflict**

The conflict is around line 50. Upstream adds `ONECLI_URL` + `MAX_MESSAGES_PER_PROMPT` but Shoggoth replaced `ONECLI_URL` with `CREDENTIAL_PROXY_PORT`.

Keep Shoggoth's `CREDENTIAL_PROXY_PORT` and add the new constant. The resolved section should look like:

```typescript
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
```

- [ ] **Step 3: Resolve index.ts import conflict**

The conflict is in the import block around line 10. Upstream adds `MAX_MESSAGES_PER_PROMPT` and `ONECLI_URL`. We only want `MAX_MESSAGES_PER_PROMPT`. The resolved import should be:

```typescript
import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
```

No `ONECLI_URL` — Shoggoth uses credential proxy instead.

- [ ] **Step 4: Verify the rest of index.ts merged cleanly**

The cherry-pick should have auto-merged these changes into index.ts:
- Import of `getLastBotMessageTimestamp` from `./db.js`
- New `getOrRecoverCursor` function
- Three call sites updated to use `getOrRecoverCursor(chatJid)` and pass `MAX_MESSAGES_PER_PROMPT`

Verify these are present and correct by reading the file.

- [ ] **Step 5: Verify db.ts and db.test.ts merged cleanly**

Check that `getLastBotMessageTimestamp` function exists in `db.ts` and that new tests exist in `db.test.ts`.

- [ ] **Step 6: Build and run tests**

```bash
npm run build && npm test
```

Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/db.ts src/db.test.ts src/index.ts
git commit -m "fix: cherry-pick upstream c98205c — message history overflow prevention

Prevents full message history from being sent to container agents when
lastAgentTimestamp is missing (new group, corrupted state, restart).

- Adds MAX_MESSAGES_PER_PROMPT config (default 10)
- Adds getLastBotMessageTimestamp for cursor recovery from last bot reply
- Adds getOrRecoverCursor that falls back to bot reply timestamp
- Updates all 3 getMessagesSince call sites to use recovered cursor + limit

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
