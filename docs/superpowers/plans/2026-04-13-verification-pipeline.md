# Verification Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a three-stage verification pipeline that reduces hallucination and improves accuracy. Stage 1 is prompt engineering (zero cost). Stage 2 is local post-processing (no LLM). Stage 3 integrates lightweight pre-action validation into the trust gateway (rule-based in v1). Confidence markers give users provenance at a glance.

**Architecture:** Mostly prompt engineering and light post-processing — not heavy infrastructure. System prompt discipline runs inside the container agent. Confidence marker parsing runs in `src/router.ts` on the host. Pre-action intent validation runs in `src/trust-gateway.ts` before auto-approving. Calibration fields extend the outcomes table schema for future use by Plan 7.

**Tech Stack:** TypeScript (existing), SQLite `better-sqlite3` (existing), Node.js built-ins, no new dependencies.

**Spec:** docs/superpowers/specs/2026-04-13-nanoclaw-scope-expansion-design.md (Layer 4)

**Depends on:** Plan 3 (Trust Engine) — completed

---

## Task 1: Add verification event types to `src/events.ts`

Add three new event interfaces after the `TrustGraduatedEvent` block, before the `SystemErrorEvent` block. Then update `EventMap`.

**File:** `src/events.ts`

Add after `TrustGraduatedEvent`:

```typescript
// --- Verification events ---

export interface VerifyCheckEvent extends NanoClawEvent {
  type: 'verify.check';
  source: 'router';
  payload: {
    taskId: string;
    groupId: string;
    claimsFound: number;
  };
}

export interface VerifyPassedEvent extends NanoClawEvent {
  type: 'verify.passed';
  source: 'router';
  payload: {
    taskId: string;
    groupId: string;
    confidenceMarkers: number;
  };
}

export interface VerifyFailedEvent extends NanoClawEvent {
  type: 'verify.failed';
  source: 'trust-gateway';
  payload: {
    taskId: string;
    groupId: string;
    toolName: string;
    reason: string;
  };
}
```

Update `EventMap` to include the three new event types:

```typescript
'verify.check': VerifyCheckEvent;
'verify.passed': VerifyPassedEvent;
'verify.failed': VerifyFailedEvent;
```

**Verification:** `npm run build` — zero TypeScript errors.

---

## Task 2: Self-check system prompt update

Inject the fact-classification discipline into the container agent's system prompt. The agent uses KNOWN / REMEMBERED / INFERRED prefixes in its thinking, and emits `✓`, `~`, or `?` confidence markers in responses.

**File:** `container/agent-runner/src/index.ts`

Find the `systemPrompt` string (or wherever the system prompt is assembled in `runQuery`). Append the following block to the system prompt:

```
## Fact Classification

Before stating any fact in a response, classify it internally:
- KNOWN: directly observed in this session (tool result, file content, message text)
- REMEMBERED: from memory files or prior conversation
- INFERRED: reasoned from other facts, not directly confirmed

In your final response, prefix claims with a confidence marker:
- ✓ Verified: [claim] (source: [where you saw it])
- ~ Unverified: [claim] (source: memory)
- ? Unknown: [claim] (not confirmed)

Only use ✓ for KNOWN facts with a named source. Use ~ for REMEMBERED claims. Use ? when you cannot confirm. Omit markers entirely for routine, conversational phrases that carry no factual claim.
```

**Where to apply:** In `runQuery()`, where the `systemPrompt` is built. Insert this block after the existing system prompt content, before closing.

**Verification:** No build step required for this — verified by reading the assembled prompt in a test run. Ensure `npm run build` still passes for the container runner.

---

## Task 3: Confidence marker formatting in `src/router.ts`

Parse confidence markers from agent responses and format them for channel display. The agent outputs raw Unicode markers (`✓`, `~`, `?`). The router normalizes them — on channels that support them, they pass through. On channels that don't (plain SMS-style), they map to text labels.

**File:** `src/router.ts`

Add a new exported function after `stripInternalTags`:

```typescript
/**
 * Normalize confidence markers in agent output for channel delivery.
 *
 * The agent emits:
 *   ✓ Verified: ...  — KNOWN fact with a source
 *   ~ Unverified: ... — REMEMBERED claim
 *   ? Unknown: ...   — unconfirmed claim
 *
 * For channels that support Unicode (WhatsApp, Telegram, Signal, Discord),
 * the markers pass through unchanged. For plain-text channels, map to text.
 */
export function normalizeConfidenceMarkers(
  text: string,
  plainText: boolean = false,
): string {
  if (!plainText) return text;
  return text
    .replace(/^✓ Verified:/gm, '[confirmed]')
    .replace(/^~ Unverified:/gm, '[from memory]')
    .replace(/^\? Unknown:/gm, '[uncertain]');
}
```

Update `formatOutbound` to call `normalizeConfidenceMarkers`. Since all current channels support Unicode, `plainText` defaults to `false` and the markers pass through unchanged. This leaves a clean hook for future plain-text channels.

```typescript
export function formatOutbound(rawText: string, plainText: boolean = false): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return normalizeConfidenceMarkers(text, plainText);
}
```

**Verification:** `npm run build` — zero TypeScript errors. Existing callers of `formatOutbound` continue to work (added parameter is optional with default).

---

## Task 4: Pre-action intent validation in `src/trust-gateway.ts`

Before auto-approving a `POST /trust/evaluate` request, run a lightweight rule-based check: does the tool name match the intent expressed in the description? If not, log a warning and emit a `verify.failed` event. This v1 check is rule-based (no LLM call). An LLM-based check (Haiku) is deferred to a future plan.

**File:** `src/trust-gateway.ts`

### 4a. Add the validation function

Add a new function before `handleEvaluate`:

```typescript
/**
 * Rule-based pre-action intent validation (v1).
 *
 * Checks that the action's tool name is plausibly consistent with the
 * description. Returns null if validation passes, or a string reason
 * if it fails.
 *
 * This is intentionally lightweight — no LLM call. The goal is to catch
 * obvious mismatches (e.g. a "write email" description paired with a
 * "delete_file" tool) without adding latency.
 *
 * LLM-based validation (Haiku cross-check) is deferred to a later plan.
 */
function validateActionIntent(
  toolName: string,
  description: string | undefined,
): string | null {
  if (!description) return null; // no description to check against

  const desc = description.toLowerCase();
  const tool = toolName.toLowerCase();

  // Destructive tools should not appear with purely read-intent descriptions
  const destructiveTools = ['delete', 'remove', 'drop', 'truncate', 'wipe'];
  const readOnlyDescriptions = ['read', 'fetch', 'list', 'get', 'search', 'find', 'check', 'view'];

  const toolIsDestructive = destructiveTools.some((d) => tool.includes(d));
  const descIsReadOnly =
    readOnlyDescriptions.some((r) => desc.startsWith(r) || desc.includes(`to ${r}`)) &&
    !destructiveTools.some((d) => desc.includes(d));

  if (toolIsDestructive && descIsReadOnly) {
    return `tool "${toolName}" appears destructive but description implies read-only: "${description}"`;
  }

  return null;
}
```

### 4b. Call the validator in `handleEvaluate`

In `handleEvaluate`, after extracting `desc` and `toolName`, call the validator before the `evaluateTrust` call:

```typescript
  // Pre-action intent validation (v1: rule-based)
  const intentMismatch = validateActionIntent(toolName, desc);
  if (intentMismatch) {
    logger.warn({ toolName, groupId, reason: intentMismatch }, 'Intent mismatch detected');
    const failedEvent: VerifyFailedEvent = {
      type: 'verify.failed',
      source: 'trust-gateway',
      groupId,
      timestamp: Date.now(),
      payload: {
        taskId: '',
        groupId,
        toolName,
        reason: intentMismatch,
      },
    };
    eventBus.emit('verify.failed', failedEvent);
    // Log the mismatch but do not block — trust evaluation proceeds normally.
    // A future plan will optionally reject here or escalate to the user.
  }
```

Also import `VerifyFailedEvent` at the top of the file:

```typescript
import type {
  TrustRequestEvent,
  TrustApprovedEvent,
  TrustDeniedEvent,
  VerifyFailedEvent,
} from './events.js';
```

**Design note:** The validator logs and emits an event but does not block the action in v1. Blocking would require higher confidence in the rule set. The event record lets us measure false-positive rate before deciding to enforce.

**Verification:** `npm run build` — zero TypeScript errors.

---

## Task 5: Confidence calibration schema fields in `src/db.ts`

Add `confidence_level` and `was_correct` columns to the `trust_actions` table. These columns are nullable so existing rows are unaffected. Plan 7 (Learning System) will write to them when outcomes are evaluated.

**File:** `src/db.ts`

### 5a. Schema change

In `createSchema`, find the `trust_actions` table definition and add two columns:

```sql
CREATE TABLE IF NOT EXISTS trust_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_class TEXT NOT NULL,
  domain TEXT NOT NULL,
  operation TEXT NOT NULL,
  description TEXT,
  decision TEXT NOT NULL,
  outcome TEXT,
  group_id TEXT NOT NULL,
  timestamp DATETIME NOT NULL,
  confidence_level TEXT,    -- 'verified' | 'unverified' | 'unknown' | NULL
  was_correct INTEGER       -- 1 = correct, 0 = incorrect, NULL = not yet evaluated
);
```

### 5b. Migration for existing databases

After the `createSchema` function's ALTER TABLE migration block (where `context_mode` is added), add two more migrations:

```typescript
  // Add confidence_level column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE trust_actions ADD COLUMN confidence_level TEXT`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Add was_correct column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE trust_actions ADD COLUMN was_correct INTEGER`,
    );
  } catch {
    // Column already exists — ignore
  }
```

**Note:** No new query functions are needed. Plan 7 will add `insertOutcome` / `updateOutcome` functions when it builds the learning system. The schema is prepared now to avoid a breaking migration later.

**Verification:** `npm run build` — zero TypeScript errors. `npm test` if tests exist for db.ts.

---

## Task 6: Tests and verification

### 6a. Unit test for `normalizeConfidenceMarkers`

**File:** `src/router.test.ts` (create if not present, follow existing test file patterns)

```typescript
import { normalizeConfidenceMarkers } from './router.js';

describe('normalizeConfidenceMarkers', () => {
  it('passes markers through unchanged in rich-text mode', () => {
    const text = '✓ Verified: your refill is ready (source: browser)\n~ Unverified: Thursday appointment (source: memory)';
    expect(normalizeConfidenceMarkers(text, false)).toBe(text);
  });

  it('maps markers to text labels in plain-text mode', () => {
    const input = '✓ Verified: done\n~ Unverified: maybe\n? Unknown: unclear';
    const output = normalizeConfidenceMarkers(input, true);
    expect(output).toContain('[confirmed]');
    expect(output).toContain('[from memory]');
    expect(output).toContain('[uncertain]');
  });
});
```

### 6b. Unit test for `validateActionIntent`

`validateActionIntent` is not exported (it's internal to trust-gateway). Test it indirectly by calling `POST /trust/evaluate` with a mismatched tool+description and verifying a `verify.failed` event is emitted.

Alternatively, export the function for direct testing if the test file grows unwieldy.

### 6c. Build and test verification

```bash
npm run build
npm test
```

Expected: zero TypeScript errors, all tests pass.

---

## Summary

| Task | Files Changed | Cost |
|------|---------------|------|
| 1. Event types | `src/events.ts` | Zero |
| 2. Self-check prompt | `container/agent-runner/src/index.ts` | Zero |
| 3. Confidence markers | `src/router.ts` | Zero |
| 4. Intent validation | `src/trust-gateway.ts` | Zero (rule-based) |
| 5. Calibration schema | `src/db.ts` | Zero |
| 6. Tests | `src/router.test.ts` | Zero |

Total new files: 0 (one test file created if absent). Total changed files: 5. No new dependencies.

The LLM-based Haiku cross-check (mentioned in the spec as ~$0.001/action) is explicitly deferred. The rule-based v1 in Task 4 catches obvious mismatches without any latency or cost. Haiku validation can be layered on in a follow-on plan once the event data shows where rule-based validation falls short.
