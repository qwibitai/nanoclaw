# Plan 6: Proactive Monitor

**Date:** 2026-04-13
**Branch:** claude/infallible-blackburn
**Status:** Complete

## Overview

Makes NanoClaw proactive by adding event routing rules, a daily digest, and a "what did I miss?" command. Builds on the existing event bus, event log, and task scheduler infrastructure.

## Tasks

### Task 1: Event Routing Rules Engine (`src/event-router.ts`)
- Load rules from `groups/{name}/events.json`
- Match events against rules (source, glob/regex patterns on payload fields)
- Execute actions: `notify` (send message to channel), `spawn_task` (enqueue via executor pool)
- Subscribe to event bus and process incoming events
- Tests in `src/__tests__/event-router.test.ts`

### Task 2: Wire Event Sources
- `src/email-sse.ts` — emit structured events to event bus when email triggers fire
- Verify task-scheduler already emits events (it doesn't — wire it)
- Define `email.received` and `task.scheduled.complete` event types

### Task 3: Webhook Endpoint
- Add POST `/webhook/:source` to the trust gateway HTTP server
- Accept JSON payload, emit as event on the event bus
- Authenticate via `x-webhook-secret` header matching `WEBHOOK_SECRET` from env
- New event type: `webhook.received`

### Task 4: Daily Digest (`src/daily-digest.ts`)
- Register as a cron task (configurable, default "0 8 * * *" in configured timezone)
- Query event_log for events since last digest
- Query pending trust approvals
- Format a concise text brief (no LLM call for v1)
- Send to the main group's channel
- Tests

### Task 5: "What Did I Miss?" Command
- Add to `src/trust-commands.ts` as an assistant command
- Detect "what did I miss" (and variants) in trigger-stripped messages
- Query event_log since user's last message timestamp
- Format prioritized summary
- Return as intercepted response (like trust commands)

### Task 6: Integration + Verification
- Run `npx vitest run` and verify all tests pass
- Verify TypeScript compilation with `npm run build`

## Event Types Added

| Event Type | Source | Description |
|-----------|--------|-------------|
| `email.received` | `email-sse` | New triaged email batch |
| `webhook.received` | `webhook` | External webhook payload |

## Files Changed

- `src/event-router.ts` (new)
- `src/daily-digest.ts` (new)
- `src/__tests__/event-router.test.ts` (new)
- `src/__tests__/daily-digest.test.ts` (new)
- `src/events.ts` (add new event types)
- `src/trust-commands.ts` (add "what did I miss" command)
- `src/trust-gateway.ts` (add webhook endpoint)
- `src/email-sse.ts` (emit events to bus)
- `src/index.ts` (wire event router + daily digest at startup)
- `src/config.ts` (add WEBHOOK_SECRET)
