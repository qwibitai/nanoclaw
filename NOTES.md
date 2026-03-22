# User Story Testing — 2026-03-22

## Story 1: Trigger new session via @NanoClaw mention

**Story:** As a user I should be able to trigger a new session with Claude (through NanoClaw) by typing @NanoClaw. NanoClaw should respond in a thread started off of the first message.

**Result:** PASS

**Observations:**
- Message received and trigger matched correctly
- Thread context created as `pending-{id}`, resolved to real Discord thread on first response
- First container attempt failed with stale session ("No conversation found with session ID"), auto-retry with fresh session succeeded
- Response sent to a new thread off the original message as expected

**Issues:**
- Stale session retry adds ~4s latency on first message to a new thread context. The `pending-{id}` session directory inherits a leftover session ID from a previous conversation. Recovery works, but could be avoided by clearing session state for new thread contexts upfront.

---

## Story 2: Continue conversation by replying in bot thread

**Story:** As a user I should be able to continue a conversation with @NanoClaw (pick up the Claude session) by responding to a thread it has opened.

**Result:** PARTIAL PASS

**Observations:**
- Thread reply detected correctly — auto-prepended `@Jarvis` trigger without explicit mention
- Thread context looked up by Discord thread ID (`1485354025363701823`) — routing worked
- Response delivered to the correct existing thread

**Issues:**
- **Session resume failed.** The first message ran under session dir `pending-84/.claude/`, but once the thread resolved to Discord thread ID `1485354025363701823`, the follow-up mounted a *different* session dir `1485354025363701823/.claude/`. The session created in Story 1 was orphaned in the `pending-84` dir and never migrated. This means **every thread reply starts a fresh session** — conversation context is lost.
- Root cause: `container-runner.ts` uses `threadId` for the session path. When a thread starts as `pending-{contextId}` and resolves to a real Discord thread ID, the session dir changes but the files are not copied/moved.
- Fix: either (a) migrate/symlink the session dir when `pending-*` resolves to a real thread ID, or (b) always use the thread context ID (not Discord thread ID) as the session dir key.

---

## Story 3: Reply to bot message — opens thread or continues in existing thread

**Story:** As a user I should be able to reply to @NanoClaw in the main channel and it should open a thread. If done within an existing thread, it should continue with that session — just as if we had responded without the reply functionality.

**Result:** PARTIAL PASS

### Test 3a: Reply to bot message in main channel
- C E L I N E replied to a bot message in `#general`
- Thread context `pending-86` created, container spawned, response sent to **new thread** `1485361871413579930`
- **PASS** — reply in main channel correctly opened a new thread

### Test 3b: Reply in existing thread (continuation)
- C E L I N E continued in thread `1485361871413579930`, two follow-ups handled correctly
- Third message (12:39:47): response **leaked to main channel** instead of thread
- Root cause: container from 12:38 completed with "Agent error after output was sent" warning. The `currentSendTarget` was cleared on container completion, so the next message's response had no thread target and fell through to main channel send.
- **FAIL** — response leaked to main channel after container error+completion cycle

### Test 3c: Reply in another user's thread
- Shiven replied in Skeeskeet's thread `1485362957889306645` at 12:47
- Thread recognized as bot thread, routed correctly, response sent to existing thread
- **PASS for routing** — but session not resumed (same pending→real ID migration bug as Story 2)

### Test 3d: IPC piping to active container (follow-ups while container running)
- Skeeskeet and Shiven continued chatting in thread `1485362957889306645` at 12:49-12:50
- Messages piped to active container via IPC — fast ~3s responses
- All responses went to correct thread
- **PASS** — IPC piping works well for rapid multi-turn conversations

**Issues:**
1. **Response leaked to main channel** after container error+completion. The `currentSendTarget` map loses thread context when a container finishes, causing the next response to fall back to main channel.
2. **Session resume still broken** (same as Story 2) — every new container attempt hits stale session, retries fresh.
3. **"Agent error after output was sent"** warning appears frequently — the container exits with error code 1 even after successfully sending output. This suggests the agent-runner has an issue with its exit handling.

### Retest (13:01 — after restart with LINEAR_API_KEY fix)

#### Test A: Reply to bot message in main channel (no @mention)
- **Two replies** to bot messages in `#general` at 13:02 and 13:03
- Both stored, both seen by message loop (`New messages count: 1`)
- **Neither triggered processing** — no "Processing" log, no container spawned
- **FAIL** — Discord's reply-to-bot detection is not prepending the trigger. The code at line ~220 checks `repliedToMessage.author.id === this.client.user.id` but something is preventing this from firing. Possible causes: the `repliedToMessage` fetch failed silently, or the bot's user ID doesn't match because the reply target is a webhook/system message rather than the bot user.

#### Test B: Reply in existing thread
- Replied in thread `1485362957889306645` at 13:03:58
- Thread correctly recognized as bot thread, trigger auto-prepended
- Container spawned for thread `1485362957889306645`
- **Response sent to NEW thread** `1485368310257156156` instead of existing thread!
- **FAIL** — the `pendingTrigger` map from the earlier unprocessed main-channel replies (Test A) was still set. When `sendMessage()` checked `pendingTrigger.get(jid)`, it found a stale entry and created a new thread instead of sending to the existing one.
- Root cause: `pendingTrigger` is keyed by `jid` (the channel, not the thread). Unprocessed main-channel replies pollute the trigger map, and the next response for that channel consumes the stale trigger.
- Fix: key `pendingTrigger` by `jid:threadId` or clear stale triggers when they don't match the current thread context.

#### Test C: Follow-ups in new thread (continuation)
- Follow-up messages at 13:04:30 and 13:04:45 routed to new thread `1485368310257156156`
- IPC piping worked, responses sent to correct thread
- **PASS** — once in the right thread, follow-ups work
