---
name: enable-native-runner
description: Switch NanoClaw from Docker container mode to native host process mode, enabling tmux, Playwright, macOS APIs, and Ollama integrations.
---

# Enable Native Runner Mode

This skill switches NanoClaw from Docker container mode (`RUNTIME_MODE=container`) to native mode (`RUNTIME_MODE=native`), where the agent-runner runs as a direct child process on the host instead of inside a Docker container.

**When to use:** You want the agent to run tmux sessions, use Playwright with a real browser, call macOS-native tools (screen capture, camera, `osascript`), or access Ollama on localhost without the overhead of a container.

**When not to use:** Multi-user or server deployments where isolation matters. Container mode is the secure default.

## Phase 1: Apply Code Changes

### Merge the skill branch

```bash
git remote -v
```

Check that the `upstream` remote points to `https://github.com/qwibitai/nanoclaw.git`. If not, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream
```

Merge the native runner branch:

```bash
git merge upstream/skill/native-runner --no-edit
```

If there are conflicts, resolve them and continue:

```bash
git add -A && git merge --continue
```

Build to confirm everything compiles:

```bash
npm run build
```

## Phase 2: Configure

Add to your `.env`:

```
RUNTIME_MODE=native
```

**Optional — tmux socket for container mode** (only relevant if you switch back to containers):

```
MOUNT_TMUX_SOCKET=false
```

Set to `true` to mount the host tmux socket into containers. See `docs/NATIVE-MODE.md` for security trade-offs.

## Phase 3: First-run setup

On first start in native mode, NanoClaw will:

1. Install `agent-runner` npm dependencies (once, takes ~10s on a cold start)
2. Symlink each skill in `container/skills/` into `~/.claude/skills/`

The agent-runner is executed via `tsx` — ensure it is available:

```bash
ls node_modules/.bin/tsx || echo "tsx not found — run: npm install"
```

## Phase 4: Restart NanoClaw

**macOS (launchd):**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Linux (systemd):**

```bash
systemctl --user restart nanoclaw
```

**Direct:**

```bash
npm run dev
```

## Phase 5: Verify

Check the log for the native mode confirmation line:

```bash
grep "native mode" logs/nanoclaw.log | tail -3
```

You should see:

```
INFO: Running in native mode — skipping container runtime checks
INFO: Native mode: agent-runner dependencies installed (or: already present)
```

Send a test message to any registered group to confirm the agent responds.

## Troubleshooting

See `docs/NATIVE-MODE.md` for full troubleshooting guidance covering:
- `npx tsx` not found (Node version manager PATH issues)
- Credentials not picked up (quoted `.env` values)
- Skills not appearing (symlink vs real directory)
- macOS launchd tmux socket path issues
