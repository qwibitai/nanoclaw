---
name: add-deep-mode
description: Add /deep and /end commands for long-running container sessions. Suppresses idle timeout so containers stay alive for extended work (coding, research, document collaboration). 4-hour safety max.
---

# Add Deep Mode (Long-Running Sessions)

Adds `/deep` and `/end` commands that suppress idle timeout on containers, keeping them alive for extended work sessions. Containers normally die after 30 min idle. Deep mode extends idle to 1 hour and sets a 4-hour absolute max.

## Phase 1: Pre-flight

Check if deep mode is already applied:

```bash
grep -q 'DEEP_MODE_IDLE_TIMEOUT' src/config.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

Merge the skill branch:

```bash
git fetch upstream skill/deep-mode
git merge upstream/skill/deep-mode
```

> **Note:** `upstream` is the remote pointing to `qwibitai/nanoclaw`. If using a different remote name, substitute accordingly.

This adds:
- `DEEP_MODE_IDLE_TIMEOUT` and `DEEP_MODE_MAX_DURATION` constants in `src/config.ts`
- Deep mode state (`deepMode`, `deepModeStarted`) and methods (`enterDeepMode`, `exitDeepMode`, `isDeepMode`) in `src/group-queue.ts`
- `deepMode` field in `ContainerInput` interface and deep-mode-aware timeout logic in `src/container-runner.ts`
- `/deep` and `/end` command interception, `handleDeepMode()` function, deep watchdog timer, and conditional idle timeout in `src/index.ts`

### Validate

```bash
npm run build
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Integration Test

1. Start NanoClaw in dev mode: `npm run dev`
2. From the **main group**, send exactly: `/deep`
3. Verify:
   - The bot responds with "Deep mode activated. Container will stay alive (up to 4h). Send /end to exit."
   - The container stays alive after completing a response (no 30-min idle kill)
   - Sending `/deep` again responds with "Deep mode is already active."
4. Send a follow-up message and verify the agent responds normally
5. Send exactly: `/end`
6. Verify:
   - The bot responds with "Deep mode ended. Container will shut down after normal idle timeout."
   - The container shuts down after the normal idle period
   - Sending `/end` again responds with "Deep mode is not active."
7. Verify the **4-hour safety max**: deep mode containers are force-closed after 4 hours regardless of activity
8. From a **non-main group** as a non-admin user, send `/deep`:
9. Verify:
   - The command is ignored (only main group or device owner can activate deep mode)
   - The message is stored normally and does not trigger deep mode

## Configuration

Environment variables (all optional, sensible defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEP_MODE_IDLE_TIMEOUT` | `3600000` (1h) | Idle timeout while deep mode is active |
| `DEEP_MODE_MAX_DURATION` | `14400000` (4h) | Absolute max duration for deep mode sessions |

## Security Constraints

- **Main-group or device owner only.** Deep mode is a privileged operation — untrusted users in non-main groups cannot activate it.
- **Safety max enforced.** A 4-hour absolute ceiling prevents runaway containers even if the user forgets to `/end`.
- **Container hard timeout extended.** The container runtime timeout is set to `DEEP_MODE_MAX_DURATION + 60s` to allow graceful shutdown.
- **Deep mode resets on container exit.** If a container dies for any reason, deep mode state is cleared automatically.

## What This Does NOT Do

- No auto-activation based on message content or session length
- No per-group deep mode configuration (all groups share the same timeouts)
- No changes to the container image, Dockerfile, or build script
- No persistent deep mode state across restarts (deep mode is session-scoped)
