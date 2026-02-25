# ipc.ts — Slack skill modifications

## What changed

1. Added `getChatName` import from `./db.js`
2. In `register_group` IPC handler: `name` is no longer a required field. When missing, it auto-resolves from the `chats` table (populated by `syncChannelMetadata` on startup) and falls back to the raw JID.

## Invariants

- The `register_group` handler still requires `jid`, `folder`, and `trigger`
- Authorization check (isMain) is unchanged
- All other IPC handlers are unchanged
- The resolved name is purely cosmetic (used only in logs)
