# /stop Command — Kill In-Progress Sessions

## Problem

When a user sends a message and a container agent is mid-response, there's no way to interrupt it. If the user wants to rephrase or cancel, they must wait for the full response to complete (which can take minutes for complex tasks).

## Design

### User-Facing Behavior

- User sends `/stop` in a channel or thread
- The orchestrator intercepts it (never reaches the container)
- The active container for that thread is interrupted mid-turn via SDK `AbortController`, then hard-killed if it doesn't exit within 5 seconds
- A confirmation message ("Session stopped.") is sent to the channel
- Anyone in the group can use `/stop` — no sender restriction

### Thread Scoping

- If sent inside a thread: kills the container for that thread's context ID (`ctx-{id}`)
- If sent outside a thread: kills the container for the `default` thread
- If no active container exists: sends "No active session to stop."

## Architecture

Three layers, from host to container:

### 1. Orchestrator Intercept (`src/index.ts`)

Intercept `/stop` in the `onMessage` callback, same pattern as `/remote-control`:

```typescript
if (trimmed === '/stop') {
  handleStop(chatJid, msg).catch(err =>
    logger.error({ err, chatJid }, 'Stop command error'));
  return; // Don't store the message
}
```

`handleStop(chatJid, msg)` resolves the thread context:
- If the message has a `thread_context_id` (set by the channel when the message is a reply in a thread), use `ctx-{thread_context_id}`
- Otherwise, use `'default'`
- Calls `queue.stopContainer(chatJid, threadId)` and sends the result message to the channel

```typescript
async function handleStop(chatJid: string, msg: NewMessage): Promise<void> {
  const channel = findChannel(channels, chatJid);
  if (!channel) return;

  const threadId = msg.thread_context_id
    ? `ctx-${msg.thread_context_id}`
    : 'default';

  const result = queue.stopContainer(chatJid, threadId);
  const reply = result.stopped
    ? 'Session stopped.'
    : 'No active session to stop.';
  await channel.sendMessage(chatJid, reply, msg.thread_context_id);
}
```

### 2. GroupQueue Stop Method (`src/group-queue.ts`)

New method `stopContainer(groupJid, threadId)`:

1. Look up the `ThreadState` for the given `(groupJid, threadId)`
2. If no active thread found, return `{ stopped: false }`
3. Write a `_stop` sentinel file to the thread's IPC input directory (same pattern as `closeStdin`/`pauseContainer`)
4. Set a 5-second hard-kill timer: if the container process hasn't exited by then, call `stopContainerAsync(containerName)` (from `container-runtime.ts`) which runs `docker stop -t 1`. The `ChildProcess.on('close')` handler in `container-runner.ts` handles cleanup.
5. Return `{ stopped: true, containerName }`

The 5-second grace period gives the agent-runner time to detect the `_stop` sentinel, abort the SDK query, and exit cleanly. If the SDK doesn't respond to abort in time, the hard kill ensures the container doesn't hang.

The `_stop` sentinel is distinct from `_close` because `_close` is a graceful "finish your current turn and exit" signal, while `_stop` means "abort immediately."

### 3. Agent-Runner Abort (`container/agent-runner/src/index.ts`)

Wire an `AbortController` into each `runTurn` call:

1. Add `const IPC_INPUT_STOP_SENTINEL = path.join(IPC_INPUT_DIR, '_stop')` alongside existing sentinels
2. Create `const abortController = new AbortController()` before calling `query()`
3. Pass `abortController` in the query options (SDK supports this — see `QueryOptions.abortController`)
4. Start a `_stop` sentinel watcher using `setInterval` at 500ms that:
   - Checks `fs.existsSync(IPC_INPUT_STOP_SENTINEL)`
   - If found: deletes the sentinel, calls `abortController.abort()`, clears the interval
5. Clear the interval in a `finally` block after the `for await` loop in `runTurn` completes
6. On abort, the SDK yields an interrupted message; after the loop, `writeOutput({ status: 'success', result: null, newSessionId })` and exit the main loop

In `waitForIpcMessage()`, add a `_stop` check alongside the existing `_close` check:

```typescript
if (shouldStop()) {  // checks and deletes _stop sentinel
  resolve(null);
  return;
}
```

In `main()`, add a `shouldStop()` check after `runTurn` returns (before `waitForIpcMessage`) and in the main `while(true)` loop to break out cleanly.

Also clean up stale `_stop` sentinel at startup (same as `_close` cleanup on line 745).

## Files Changed

| File | Change |
|------|--------|
| `src/index.ts` | Intercept `/stop` in `onMessage`, add `handleStop()` |
| `src/group-queue.ts` | Add `stopContainer()` method, write `_stop` sentinel + hard-kill timer |
| `container/agent-runner/src/index.ts` | Add `AbortController` to `runTurn`, `_stop` sentinel watcher, handle in `waitForIpcMessage` |

## Edge Cases

- **No active container**: Reply "No active session to stop." — don't error
- **Container already exiting**: The hard-kill timer handles this; `stopContainerAsync` is idempotent on already-stopped containers
- **Multiple `/stop` in quick succession**: Second one is a no-op (container already being killed)
- **`/stop` during pause**: The paused container's process is still alive; write `_stop` + hard-kill works the same way
- **Scheduled task containers**: `/stop` should NOT kill task containers (they're invisible to the user). Only interactive/goal containers are stoppable. Thread scoping naturally handles this since task containers use `task_{id}` thread IDs which users can't target.

## Non-Goals

- Stopping containers in other groups (out of scope)
- Stopping specific subagents within a container (the whole container is killed)
- Reaction-based stop (future enhancement)
