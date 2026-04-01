---
name: isolated-sessions
description: Add per-context session isolation to NanoClaw groups. Enables a single registered group to run independent Claude sessions for different contexts — Slack threads, email threads, per-user DMs, or any other channel-defined scope. Each context gets its own conversation history and IPC namespace while sharing the group's folder, CLAUDE.md, and container config.
---

# Isolated Sessions

This skill adds the primitives needed for context-scoped session isolation within a group.

## When to use this

By default, each NanoClaw group has one shared Claude session. All messages in the group continue the same conversation. This is fine for most use cases.

Use this skill when:
- A Slack channel should give each **thread** its own independent conversation
- A Gmail integration should give each **email** its own session rather than one long shared history
- A group should give each **user** their own isolated session
- Any channel needs to scope sessions by an opaque context identifier it controls

## Phase 1: Apply Code Changes

### Check if already applied

```bash
grep -q "isolatedSessions" src/types.ts && echo "already applied" || echo "not applied"
```

If already applied, skip to Phase 2.

### Merge the skill branch

```bash
git fetch upstream skill/isolated-sessions
git merge upstream/skill/isolated-sessions
```

Resolve any conflicts by reading both sides. The skill changes four files:
- `src/types.ts` — adds `isolatedSessions?` to `RegisteredGroup`, `sessionContext?` to `NewMessage`
- `src/db.ts` — migration for `session_context` on messages, `isolated_sessions` on groups; updated queries
- `src/container-runner.ts` — adds `ipcKey?` to `ContainerInput`, threads it through IPC mount
- `src/index.ts` — `subSessionRegistry`, `deriveSessionKey`, `deriveQueueKey`, updated message loop and `runAgent`

### Validate

```bash
npm install
npm run build
npm test
```

All tests must pass and build must be clean before proceeding.

## Phase 2: Configure a Group

To enable isolation for a group, set `isolatedSessions: true` when registering it. This can be done via the IPC watcher's `/register-group` command or directly in the database.

**Via database (immediate, no restart needed):**

```bash
sqlite3 store/messages.db \
  "UPDATE registered_groups SET isolated_sessions = 1 WHERE jid = '<your-group-jid>'"
```

Then reload groups in the running process by restarting the service, or wait — groups are reloaded at startup.

**Via registration (new groups):**

When calling `registerGroup` in a channel or IPC handler, include `isolatedSessions: true` in the `RegisteredGroup` object:

```typescript
registerGroup(jid, {
  name: 'My Channel',
  folder: 'my_channel',
  trigger: '@andy',
  added_at: new Date().toISOString(),
  isolatedSessions: true,
});
```

## Phase 3: Supply sessionContext from a Channel

The channel is responsible for deciding what the context boundary is. The core never interprets `sessionContext` — it's an opaque string used only to derive a stable session key.

In any channel's inbound message handler, set `sessionContext` on the `NewMessage` before calling `onInboundMessage`:

```typescript
const msg: NewMessage = {
  id: messageId,
  chat_jid: channelJid,
  sender: userId,
  sender_name: userName,
  content: text,
  timestamp: new Date().toISOString(),
  // Set this to whatever scopes the session for your channel:
  sessionContext: threadId,   // e.g. Slack thread_ts
  // sessionContext: emailId, // e.g. Gmail message/thread ID
  // sessionContext: userId,  // e.g. per-user isolation
};
onInboundMessage(channelJid, msg);
```

If `sessionContext` is omitted, the group falls back to its normal single-session behaviour — so the change is backwards compatible.

### How the isolation works

When `group.isolatedSessions` is `true` and `msg.sessionContext` is set:

1. A **session key** is derived: `${group.folder}_${sha256(sessionContext).slice(0,12)}`. This is used as the Claude session ID key in the database and as the IPC namespace directory.
2. A **queue key** is derived: `${chatJid}::ctx::${sessionContext}`. This gives each context its own slot in the GroupQueue, so concurrent contexts run in separate containers without contention.
3. `getMessagesSince` is called with the `sessionContext` filter, so each context only sees its own message history.

The group folder, CLAUDE.md, container config, and `.claude/` settings directory are **shared** across all contexts. Only the session state and IPC namespace are isolated.

## Usage Examples

### Slack threads

In `src/channels/slack.ts`, when handling a message event:

```typescript
const sessionContext = event.thread_ts ?? event.ts; // use thread root ts
const msg: NewMessage = {
  // ...other fields...
  sessionContext,
};
```

Register the Slack channel's group with `isolatedSessions: true`. Each thread now gets its own Claude session. Replies within the thread continue that session; new threads start fresh.

### Gmail (per-email sessions)

In a Gmail channel handler:

```typescript
const sessionContext = email.threadId; // Gmail thread ID
```

Each email thread maintains independent context. The agent handling a support ticket doesn't see unrelated emails.

### Per-user isolation

For a channel where each user should have their own session:

```typescript
const sessionContext = message.from; // sender identifier
```

## Troubleshooting

### Sessions not isolating

1. Confirm `isolated_sessions = 1` in the database for the group:
   ```bash
   sqlite3 store/messages.db "SELECT jid, isolated_sessions FROM registered_groups"
   ```
2. Confirm the channel is setting `sessionContext` on messages before calling `onInboundMessage`.
3. Check logs for `sessionContext` in the "Processing messages" log line.

### All contexts sharing one session

The group's `isolatedSessions` flag is loaded at startup. If you updated the DB directly, restart the service:
```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux
systemctl --user restart nanoclaw
```

### Sub-session state lost after restart

`subSessionRegistry` is in-memory and rebuilt when messages arrive — this is by design. Session state (the Claude conversation ID) is persisted in the database and survives restarts. The cursor (message position) for a sub-session is recovered from the last bot reply timestamp on restart, which may replay a small number of messages.
