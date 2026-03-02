---
name: host-commands
description: >
  Run pre-approved commands on the host machine (Docker builds, system services, etc.)
  and register new Telegram topics with project mounts — all from chat without touching the host.
allowed-tools: Bash(echo*), Bash(cat*)
---

# Host Commands & Dynamic Group Registration

Anything that can't run inside the container has a pathway back to the host via IPC.
Two MCP tools handle this: `run_host_command` and `update_mount_allowlist`.

---

## Running Host Commands

Use the `run_host_command` MCP tool. The result is sent back to the chat automatically.

```
run_host_command(name: "deploy-live-odds-lab")
```

If you pass an unknown name, the host replies with available commands.

### Current Commands

| Name | What it does |
|------|-------------|
| `deploy-live-odds-lab` | Full rebuild + redeploy (slow — triggers Docker build) |
| `restart-live-odds-lab` | Restart container without rebuilding |
| `logs-live-odds-lab` | Show last 100 lines of logs |
| `status-live-odds-lab` | Show container status |
| `restart-nanoclaw` | Restart the NanoClaw service itself (macOS LaunchAgent) — **no reply will come back**, the process restarts before it can respond |

To add new commands: edit `~/.config/nanoclaw/host-commands.json` on the host,
or ask the human to add them. New commands are available immediately — no restart needed.

---

## Registering a New Topic + Project from Chat

You can fully register a new Telegram topic and link it to a project without anyone
touching the host machine. Do it in this order:

### Step 1 — Add mounts to the allowlist

```
update_mount_allowlist(paths: [
  { path: "~/projects/my-app", allow_read_write: false, description: "my-app source" }
])
```

Wait for the confirmation message before continuing.

### Step 2 — Register the group with mounts

```
register_group(
  jid: "tg:-1003846359076:306",
  name: "My App",
  folder: "my-app",
  trigger: "@JBot",
  container_config: {
    additionalMounts: [
      { hostPath: "/Users/jamesschindler/projects/my-app", containerPath: "my-app", readonly: true }
    ]
  }
)
```

The group is live immediately — no restart required.

### Step 3 (optional) — Add host commands for that project

Ask the human to add entries to `~/.config/nanoclaw/host-commands.json` if the project
needs deploy/restart commands. This file requires host access and cannot be updated via IPC.

---

## What Requires Host Access vs. What Doesn't

| Task | Can do from chat? | How |
|------|-------------------|-----|
| Register a new topic/group | ✅ Yes | `register_group` IPC |
| Add mount paths to allowlist | ✅ Yes (main only) | `update_mount_allowlist` IPC |
| Run Docker build/restart | ✅ Yes | `run_host_command` IPC |
| Add a new named host command | ❌ No | Edit `~/.config/nanoclaw/host-commands.json` on host |
| Rebuild NanoClaw container image | ❌ No | Run `./container/build.sh` on host |
| Restart NanoClaw service | ❌ No | `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` on host |
