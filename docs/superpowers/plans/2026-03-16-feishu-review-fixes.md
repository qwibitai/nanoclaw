# Feishu Channel Code Review Fixes

## Context

Self-reflective code review of `src/channels/feishu.ts` and `src/channels/feishu.test.ts` found 2 issues that need fixing before merge, plus 2 minor improvements. All are localized changes — no architectural impact.

## Fixes

### Fix 1: `handleMessage` malformed data defense (Important)

**Problem:** `handleMessage` at line 109-111 directly accesses `data.message.chat_id` and `data.sender`. If the SDK delivers a malformed event, this throws an uncaught exception.

**File:** `src/channels/feishu.ts:109`

**Change:** Add guard at the top of `handleMessage`:

```typescript
private async handleMessage(data: any): Promise<void> {
    if (!data?.message?.chat_id || !data?.sender) return;
    // ... rest unchanged
```

### Fix 2: `parseInt` radix (Minor)

**Problem:** `parseInt(message.create_time)` without radix at line 119.

**File:** `src/channels/feishu.ts:119`

**Change:** `parseInt(message.create_time)` → `parseInt(message.create_time, 10)`

### Fix 3: Test — `connect()` survives `botInfoGet` failure (Important)

**Problem:** All 29 tests mock `botInfoGet` as successful. The try/catch at line 77-89 is an important degradation path with no test coverage.

**File:** `src/channels/feishu.test.ts` — add in `connection lifecycle` describe block

### Fix 4: Test — malformed event data (Important)

**File:** `src/channels/feishu.test.ts` — add in `inbound text messages` describe block

### Fix 5: Test — `sendMessage` after `disconnect()` (Minor)

**File:** `src/channels/feishu.test.ts` — add in `sendMessage` describe block
