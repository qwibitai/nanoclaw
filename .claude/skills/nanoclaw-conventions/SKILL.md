---
name: nanoclaw-conventions
description: "NanoClaw (Claude Agent SDK) working conventions. Load when working on NanoClaw, its container, agent-runner, IPC, or channels. Trigger on 'nanoclaw', 'nano claw', 'agent sdk', 'container runner', or when editing nanoclaw project files."
---

# NanoClaw Working Conventions

## Architecture Overview

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory.

Key files: `src/index.ts` (orchestrator), `src/channels/whatsapp.ts` (WhatsApp), `src/ipc.ts` (IPC watcher), `src/container-runner.ts` (container lifecycle), `src/config.ts` (paths and intervals), `src/mount-security.ts` (mount allowlists).

## Container Isolation Model

Each WhatsApp group gets its own isolated namespaces:

- **Filesystem**: `groups/{folder}/` -- per-group writable workspace, mounted at `/workspace/group`
- **IPC**: `data/ipc/{folder}/` -- per-group IPC directory with `messages/`, `tasks/`, `input/` subdirs, mounted at `/workspace/ipc`
- **Claude sessions**: `data/sessions/{folder}/.claude/` -- per-group session dir, mounted at `/home/node/.claude/`
- **Agent-runner source**: `data/sessions/{folder}/agent-runner-src/` -- per-group copy, mounted at `/app/src`

Main group has elevated privileges: gets read-only project root at `/workspace/project`, can send IPC messages to any group, can register new groups, can schedule tasks for any group. Non-main groups can only access their own folder and IPC namespace.

Global memory directory (`groups/global/`) is mounted read-only at `/workspace/global` for non-main groups.

## Secrets Never Touch Disk

Auth tokens (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) are passed to containers via stdin JSON only. The entrypoint writes stdin to a temp file (`/tmp/input.json`) which is read once by the agent-runner. The `readSecrets()` function in `container-runner.ts` reads from `.env` and injects into the `secrets` field of the input JSON. Secrets are deleted from the input object immediately after writing to stdin so they don't appear in logs.

## IPC is File-Based Polling

Containers write JSON files to `/workspace/ipc/messages/` (outbound messages) and `/workspace/ipc/tasks/` (task scheduling). The host-side `startIpcWatcher()` in `src/ipc.ts` polls all group IPC directories at 1-second intervals (`IPC_POLL_INTERVAL = 1000`).

Authorization is directory-based: the IPC watcher identifies the source group by the directory name. Main group can send messages to any JID; non-main groups can only send to their own JID. Failed IPC files are moved to `data/ipc/errors/`.

Supported IPC task types: `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `refresh_groups`, `register_group`.

## Sentinel Markers

Container stdout output is wrapped with sentinel markers for robust JSON parsing:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"...","newSessionId":"..."}
---NANOCLAW_OUTPUT_END---
```

Both streaming (parsing marker pairs as they arrive) and legacy (extracting last marker pair from accumulated stdout) modes are supported. The markers must match exactly between `container-runner.ts` and the agent-runner.

## Agent-Runner Copy-Per-Group

`container/agent-runner/src/` is copied to `data/sessions/{folder}/agent-runner-src/` on first container run for each group. This allows per-group customization of agent behavior. The copy is mounted at `/app/src` and recompiled inside the container on every start via `entrypoint.sh` (`npx tsc --outDir /tmp/dist`). The compiled output is made read-only to prevent runtime modification.

If the agent-runner source needs updating for all groups, delete the per-group copies and they will be recreated from the canonical source on next run.

## Container Build Cache Gotcha

BuildKit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps -- the builder's volume retains stale files. To force a truly clean rebuild:

```bash
docker builder prune -f
cd container && ./build.sh
```

## Session HOME

Container runs as `node` user (non-root, required for `--dangerously-skip-permissions`). `HOME=/home/node`. Claude sessions mount to `/home/node/.claude/`. When running as a non-root/non-1000 host UID, the container explicitly sets `--user ${uid}:${gid}` and `-e HOME=/home/node`. Wrong HOME silently breaks session continuity.

## Channel Interface

The `Channel` interface (`src/types.ts`) defines the channel abstraction:

- `name: string` -- channel identifier
- `connect(): Promise<void>` -- establish connection
- `sendMessage(jid: string, text: string): Promise<void>` -- send outbound message
- `isConnected(): boolean` -- connection status
- `ownsJid(jid: string): boolean` -- JID routing (determines which channel handles a given JID)
- `disconnect(): Promise<void>` -- teardown
- `setTyping?(jid: string, isTyping: boolean): Promise<void>` -- optional typing indicator

Only WhatsApp is built-in (`src/channels/whatsapp.ts`). Other channels can be added via the same interface.

## Mount Security

`src/mount-security.ts` validates additional mounts against an external allowlist stored at `~/.config/nanoclaw/mount-allowlist.json` -- outside the project root and never mounted into containers, making it tamper-proof from agents.

The `MountAllowlist` interface defines: `allowedRoots` (paths that can be mounted, with `allowReadWrite` flag), `blockedPatterns` (globs like `.ssh`, `.gnupg` that are never mounted), and `nonMainReadOnly` (forces read-only for non-main groups regardless of config).

## Key Constants

- `CONTAINER_IMAGE`: `nanoclaw-agent:latest` (default)
- `CONTAINER_TIMEOUT`: 1,800,000ms (30 minutes)
- `IDLE_TIMEOUT`: 1,800,000ms (30 minutes after last output)
- `IPC_POLL_INTERVAL`: 1,000ms (1 second)
- `MAX_CONCURRENT_CONTAINERS`: 5
- `CONTAINER_MAX_OUTPUT_SIZE`: 10MB
- `MAIN_GROUP_FOLDER`: `main`

## Development Commands

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```
