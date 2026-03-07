# Worker Dispatch Root Cause (2026-02-24)

## Problem

1. Jarvis workers appeared "not responding".
2. Andy-Developer posted full worker dispatch JSON contracts into the WhatsApp chat.

## Evidence

- Registered worker groups use internal JIDs (`jarvis-worker-*@nanoclaw`) in `store/messages.db`.
- Recent WhatsApp chat records in `messages` table showed bot posts containing full JSON payloads in Andy-Developer group chat (`120363407693898924@g.us`).
- `worker_runs` table had no new runs during those dispatch attempts.
- IPC/MCP implementation mismatch:
  - `send_message` tool had no target-group parameter (always used current chat JID).
  - IPC host attempted to route all messages through external channel ownership (`@g.us`/`@s.whatsapp.net`), so internal worker JIDs were not routable.

## Root Cause

Dispatch contract/documentation assumed cross-group targeting, but runtime implementation only supported same-chat sends. As a result, worker dispatch JSON was sent to Andy's own WhatsApp chat and never entered the internal worker queue.

## Permanent Fixes

1. Added true target routing in MCP tool:
   - `container/agent-runner/src/ipc-mcp-stdio.ts`
   - `send_message` now supports `target_group_jid`.
   - `schedule_task` now accepts `target_group_jid` for non-main callers (host authorization still enforced).
2. Added IPC guardrail to stop recurrence:
   - `src/ipc.ts`
   - Blocks worker-style JSON dispatch targeted at `andy-developer` chat (self-chat leak prevention).
3. Added internal dispatch path for `@nanoclaw` JIDs:
   - `src/index.ts`
   - Internal messages are persisted into SQLite as `nanoclaw` channel messages and picked up by the same group-processing loop.
4. Enabled internal group processing without external channel ownership:
   - `src/index.ts`
   - Message loop now processes internal JIDs.
   - Worker replies are relayed back to originating controller chat (derived from internal sender, fallback to `andy-developer`).
5. Improved worker discoverability for Andy:
   - `src/container-runner.ts`
   - Andy-Developer snapshot now includes registered groups (including worker lanes).
6. Updated docs:
   - `groups/andy-developer/docs/jarvis-dispatch.md` now uses `target_group_jid` in dispatch example.

## Regression Coverage

- Added tests in `src/ipc-auth.test.ts` for:
  - blocking accidental self-chat worker-dispatch JSON
  - allowing normal status messages
  - allowing valid worker-targeted dispatch JSON

## Validation Run

- `npm test` passed.
- `npm run build` passed.
