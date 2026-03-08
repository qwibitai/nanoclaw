---
name: add-compact
description: Add /compact command for manual context compaction. Solves context rot in long sessions by forwarding the SDK's built-in /compact slash command. Main-group or trusted sender only.
---

# Add /compact Command

Adds a `/compact` session command that compacts conversation history to fight context rot in long-running sessions. Uses the Claude Agent SDK's built-in `/compact` slash command — no synthetic system prompts.

**Session contract:** `/compact` keeps the same logical session alive. The SDK returns a new session ID after compaction (via the `init` system message), which the agent-runner forwards to the orchestrator as `newSessionId`. No destructive reset occurs — the agent retains summarized context.

## Phase 1: Pre-flight

Read `.nanoclaw/state.yaml`. If `add-compact` is in `applied_skills`, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-compact
```

This deterministically:
- Adds `src/session-commands.ts` (extract and authorize session commands)
- Adds `src/session-commands.test.ts` (unit tests for command parsing and auth)
- Three-way merges session command interception into `src/index.ts` (both `processGroupMessages` and `startMessageLoop`)
- Three-way merges slash command handling into `container/agent-runner/src/index.ts`
- Records application in `.nanoclaw/state.yaml`

If merge conflicts occur, read the intent files:
- `modify/src/index.ts.intent.md`
- `modify/container/agent-runner/src/index.ts.intent.md`

### Validate

```bash
npm test
npm run build
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Integration Test

1. Start NanoClaw in dev mode: `npm run dev`
2. From the **main group** (self-chat), send exactly: `/compact`
3. Verify:
   - The agent acknowledges compaction (e.g., "Conversation compacted.")
   - The session continues — send a follow-up message and verify the agent responds coherently
   - A conversation archive is written to `groups/{folder}/conversations/` (by the PreCompact hook)
   - Container logs show `Compact boundary observed` (confirms SDK actually compacted)
   - If `compact_boundary` was NOT observed, the response says "compact_boundary was not observed"
4. From a **non-main group** as a non-admin user, send: `@<assistant> /compact`
5. Verify:
   - The bot responds with "Session commands require admin access."
   - No compaction occurs, no container is spawned for the command
6. From a **non-main group** as the admin (device owner / `is_from_me`), send: `@<assistant> /compact`
7. Verify:
   - Compaction proceeds normally (same behavior as main group)
8. While an **active container** is running for the main group, send `/compact`
9. Verify:
   - The active container is signaled to close (authorized senders only — untrusted senders cannot kill in-flight work)
   - Compaction proceeds via a new container once the active one exits
   - The command is not dropped (no cursor race)
10. Send a normal message, then `/compact`, then another normal message in quick succession (same polling batch):
11. Verify:
    - Pre-compact messages are sent to the agent first (check container logs for two `runAgent` calls)
    - Compaction proceeds after pre-compact messages are processed
    - Messages **after** `/compact` in the batch are preserved (cursor advances to `/compact`'s timestamp only) and processed on the next poll cycle
12. From a **non-main group** as a non-admin user, send `@<assistant> /compact`:
13. Verify:
    - Denial message is sent ("Session commands require admin access.")
    - The `/compact` is consumed (cursor advanced) — it does NOT replay on future polls
    - Other messages in the same batch are also consumed (cursor is a high-water mark — this is an accepted tradeoff for the narrow edge case of denied `/compact` + other messages in the same polling interval)
    - No container is killed or interrupted
14. From a **non-main group** (with `requiresTrigger` enabled) as a non-admin user, send bare `/compact` (no trigger prefix):
15. Verify:
    - No denial message is sent (trigger policy prevents untrusted bot responses)
    - The `/compact` is consumed silently
    - Note: in groups where `requiresTrigger` is `false`, a denial message IS sent because the sender is considered reachable
16. After compaction, verify **no auto-compaction** behavior — only manual `/compact` triggers it

### Validation on Fresh Clone

```bash
git clone <your-fork> /tmp/nanoclaw-test
cd /tmp/nanoclaw-test
claude  # then run /add-compact
npm run build
npm test
./container/build.sh
# Manual: send /compact from main group, verify compaction + continuation
# Manual: send @<assistant> /compact from non-main as non-admin, verify denial
# Manual: send @<assistant> /compact from non-main as admin, verify allowed
# Manual: verify no auto-compaction behavior
```

## Security Constraints

- **Main-group or trusted/admin sender only.** The main group is the user's private self-chat and is trusted (see `docs/SECURITY.md`). Non-main groups are untrusted — a careless or malicious user could wipe the agent's short-term memory. However, the device owner (`is_from_me`) is always trusted and can compact from any group.
- **No auto-compaction.** This skill implements manual compaction only. Automatic threshold-based compaction is a separate concern and should be a separate skill.
- **No config file.** NanoClaw's philosophy is customization through code changes, not configuration sprawl.
- **Transcript archived before compaction.** The existing `PreCompact` hook in the agent-runner archives the full transcript to `conversations/` before the SDK compacts it.
- **Session continues after compaction.** This is not a destructive reset. The conversation continues with summarized context.

## What This Does NOT Do

- No automatic compaction threshold (add separately if desired)
- No `/clear` command (separate skill, separate semantics — `/clear` is a destructive reset)
- No cross-group compaction (each group's session is isolated)
- No changes to the container image, Dockerfile, or build script

## Troubleshooting

- **"Session commands require admin access"**: Only the device owner (`is_from_me`) or main-group senders can use `/compact`. Other users are denied.
- **No compact_boundary in logs**: The SDK may not emit this event in all versions. Check the agent-runner logs for the warning message. Compaction may still have succeeded.
- **Pre-compact failure**: If messages before `/compact` fail to process, the error message says "Failed to process messages before /compact." The cursor advances past sent output to prevent duplicates; `/compact` remains pending for the next attempt.
