# Message History Overflow Fix Cherry-Pick (upstream c98205c)

## Summary

Cherry-pick upstream commit `c98205c` which prevents full message history from being sent to container agents when `lastAgentTimestamp` is missing.

## Problem

When `lastAgentTimestamp` is missing (new group, corrupted state, startup recovery), the empty-string fallback caused `getMessagesSince` to return up to 200 messages — the entire group history. This sent a massive prompt to the container agent.

## Upstream Changes

**`src/config.ts`:** Add `MAX_MESSAGES_PER_PROMPT` constant (default 10, env-configurable).

**`src/db.ts`:** Add `getLastBotMessageTimestamp(chatJid, botPrefix)` function to recover cursor from last bot reply.

**`src/index.ts`:** Add `getOrRecoverCursor(chatJid)` function. Update 3 call sites (`processGroupMessages`, piping path in `startMessageLoop`, `recoverPendingMessages`) to use `getOrRecoverCursor` and pass `MAX_MESSAGES_PER_PROMPT`.

**`src/db.test.ts`:** Tests for `getLastBotMessageTimestamp`.

## Conflict Resolution

Two conflicts expected (verified by test cherry-pick):

1. **`src/config.ts`:** Upstream adds `MAX_MESSAGES_PER_PROMPT` after `ONECLI_URL`. Shoggoth replaced `ONECLI_URL` with `CREDENTIAL_PROXY_PORT`. Resolution: keep `CREDENTIAL_PROXY_PORT`, add `MAX_MESSAGES_PER_PROMPT` after it.

2. **`src/index.ts` import:** Upstream adds `MAX_MESSAGES_PER_PROMPT` and `ONECLI_URL` to imports. Resolution: add only `MAX_MESSAGES_PER_PROMPT` (we don't have `ONECLI_URL`).

`db.ts` and `db.test.ts` merge cleanly.

## Verification

1. `npm run build` — no type errors
2. `npm test` — all tests pass
