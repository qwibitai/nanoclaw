---
name: add-telegram-topics
description: Add per-topic isolation for Telegram forum groups. Each forum topic gets its own agent container, session, and memory — auto-registered on first message. Requires Telegram channel to be set up first (use /add-telegram).
---

# Add Telegram Topic Isolation

Turns each Telegram forum topic into an isolated agent workspace. Topics auto-register on first message, get their own container and conversation history, and share a read-only copy of the parent group's memory.

**Requires:** Telegram channel already set up (`/add-telegram`). The group must have Forum Topics enabled in Telegram.

## Pre-flight

### Check if already applied

```bash
grep -q 'parseTelegramJid' src/channels/telegram.ts && echo "ALREADY_APPLIED" || echo "NEEDS_INSTALL"
```

If `ALREADY_APPLIED`, skip to Verify. Otherwise continue.

### Check Telegram is installed

```bash
test -f src/channels/telegram.ts && echo "OK" || echo "MISSING"
```

If `MISSING`, tell the user to run `/add-telegram` first and stop.

## Apply Code Changes

### Merge the skill branch

```bash
git fetch origin feat/telegram-topic-isolation
git merge origin/feat/telegram-topic-isolation --no-edit || {
  # Resolve package-lock conflicts automatically
  git checkout --theirs package-lock.json 2>/dev/null
  git add package-lock.json 2>/dev/null
  GIT_EDITOR=true git merge --continue
}
```

### Build and test

```bash
npm install
npm run build
npx vitest run src/channels/telegram.test.ts
```

All tests must pass before proceeding.

## How It Works

### Virtual JIDs

Messages in forum topics get a virtual JID: `tg:<chat_id>:t:<thread_id>`.
Messages in the General topic (no thread_id) use the base JID as before.

- Inbound: `message_thread_id=42` on chat `-1003204831761` becomes `tg:-1003204831761:t:42`
- Outbound: `tg:-1003204831761:t:42` sends to chat `-1003204831761` with `message_thread_id=42`

### Auto-registration

When a message arrives in a topic whose parent group is registered, the topic is automatically registered as a new group:
- Folder: `<parent_folder>_t<thread_id>` (e.g. `telegram_main_t42`)
- Inherits trigger config and requiresTrigger from parent
- Gets its own CLAUDE.md seeded with parent's context
- NOT marked as isMain

### Container isolation

Each topic runs its own container with:
- Its own group folder at `/workspace/group` (read-write)
- Parent group folder at `/workspace/parent` (read-only) for shared memory
- Global memory at `/workspace/global` (read-only)
- Its own session, IPC namespace, and conversation history

### `/chatid` command

When run inside a forum topic, `/chatid` now shows both the topic JID and the base group JID.

## Verify

Send a message in any forum topic in your registered Telegram group. Check:

1. A new folder appears in `groups/` (e.g. `groups/telegram_main_t42/`)
2. The folder contains a `CLAUDE.md` with parent context
3. The bot replies within the same topic
4. Check logs: `tail -f logs/nanoclaw.log` should show "Auto-registered topic group"

### Check registered topics

```bash
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups WHERE jid LIKE '%:t:%';"
```

## Troubleshooting

### Bot not responding in topics

1. Check `logs/nanoclaw.error.log` for `FOREIGN KEY constraint failed` — this means the chat metadata row wasn't created. Restart the service.
2. Verify Forum Topics is enabled on the Telegram group (Group Settings > Topics > Enable).
3. Check Group Privacy is disabled for the bot (`@BotFather` > `/mybots` > Bot Settings > Group Privacy > Turn off).

### Topic messages going to General

The virtual JID system only activates when `message_thread_id` is present. If Telegram isn't sending thread IDs, Forum Topics may not be enabled on the group.

### Removing a topic registration

```bash
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid = 'tg:<chat_id>:t:<thread_id>';"
```

The topic folder in `groups/` is preserved (won't be deleted).
