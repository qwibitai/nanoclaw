# Intent: src/index.ts modifications for sender-allowlist skill

## What changed

Three surgical additions — no logic removed, no refactoring:

1. **New import** (after existing imports):
   ```ts
   import { isSenderAllowed, isTriggerAllowed, loadSenderAllowlist, shouldDropMessage } from './sender-allowlist.js';
   ```

2. **Trigger gating** in both `hasTrigger` checks (processGroupMessages and startMessageLoop):
   - Before: `TRIGGER_PATTERN.test(m.content.trim())`
   - After: same check AND `isTriggerAllowed(chatJid, m.sender, allowlistCfg)`
   - Config is loaded once per batch, not per message
   - Note: `is_bot_message` rows are filtered by db.ts queries (`AND is_bot_message = 0`) so they never reach the trigger check.

3. **Drop mode** in `channelOpts.onMessage`:
   - Before: `storeMessage(msg)` unconditionally
   - After: only for registered groups, skip `storeMessage` when chat mode is `drop` and sender is denied
   - Bypass: `is_from_me` and `is_bot_message` always pass through (checked before allowlist)
   - Logging: one debug/info line per denied inbound message when `logDenied=true`

## Invariants

- **Default behavior unchanged**: if `~/.config/nanoclaw/sender-allowlist.json` is missing, `loadSenderAllowlist()` returns allow-all defaults. Zero change for users who don't create the config.
- **No platform assumptions**: uses only `msg.sender` and `msg.chat_jid` from `NewMessage`, which are populated for all channels (WhatsApp, Telegram, Slack, etc).
- **Own messages always stored**: `is_from_me === true` bypasses drop logic in onMessage (never dropped). For trigger gating, the owner should include their sender ID in the allowlist.
- **Bot messages always stored**: `is_bot_message === true` bypasses drop logic in onMessage. For trigger checks, db.ts queries filter `is_bot_message = 0` so bot messages never reach the trigger check.
- **Config is cached by mtime**: `loadSenderAllowlist()` re-reads only when the file changes on disk.
