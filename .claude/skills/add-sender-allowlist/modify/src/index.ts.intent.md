# Intent: src/index.ts modifications for sender-allowlist skill

## What changed

Three surgical additions — no logic removed, no refactoring:

1. **New import** (after existing imports):
   ```ts
   import { isSenderAllowed, isTriggerAllowed, loadSenderAllowlist, shouldDropMessage } from './sender-allowlist.js';
   ```

2. **Trigger gating** in both `hasTrigger` checks (processGroupMessages and startMessageLoop):
   - Before: `TRIGGER_PATTERN.test(m.content.trim())`
   - After: same check AND `(m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg))`
   - Self-sent triggers (`is_from_me`) always bypass the allowlist — requires the companion db.ts change that adds `is_from_me` to the SELECT projection
   - Config is loaded once per batch, not per message
   - Note: `is_bot_message` rows are filtered by db.ts queries (`AND is_bot_message = 0`) so they never reach the trigger check. `is_from_me` rows DO reach it, hence the explicit bypass.

3. **Drop mode** in `channelOpts.onMessage`:
   - Before: `storeMessage(msg)` unconditionally
   - After: only for registered groups, skip `storeMessage` when chat mode is `drop` and sender is denied
   - Bypass: `is_from_me` and `is_bot_message` always pass through (checked before allowlist)
   - Logging: one debug/info line per denied inbound message when `logDenied=true`

## Invariants

- **Default behavior unchanged**: if `~/.config/nanoclaw/sender-allowlist.json` is missing, `loadSenderAllowlist()` returns allow-all defaults. Zero change for users who don't create the config.
- **No platform assumptions**: uses only `msg.sender` and `msg.chat_jid` from `NewMessage`, which are populated for all channels (WhatsApp, Telegram, Slack, etc).
- **Own messages always pass**: `is_from_me` bypasses both drop logic (checked on the raw `NewMessage` in onMessage) and trigger gating (checked via `m.is_from_me` in hasTrigger, populated by the companion db.ts change).
- **Bot messages always pass**: `is_bot_message === true` bypasses drop logic in onMessage. For trigger checks, db.ts queries filter `is_bot_message = 0` so bot messages never reach the trigger check.
- **Config is cached by mtime**: `loadSenderAllowlist()` re-reads only when the file changes on disk.
