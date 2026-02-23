# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp/Signal/Telegram, routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory. One container per group at a time, managed by `GroupQueue`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection via Baileys |
| `src/channels/signal.ts` | Signal via signal-cli-rest-api WebSocket/REST |
| `src/channels/telegram.ts` | Telegram via grammY |
| `src/ipc.ts` | IPC watcher: messages, reactions, tasks, group registration |
| `src/router.ts` | Message formatting (XML) and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns Docker containers with mounts |
| `src/container-runtime.ts` | Docker/container runtime abstraction |
| `src/mount-security.ts` | Validates additional mounts against allowlist |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations (store/messages.db) |
| `groups/{name}/CLAUDE.md` | Per-group agent instructions (versioned in git) |
| `groups/global/CLAUDE.md` | Shared instructions for all non-main groups |
| `container/agent-runner/src/index.ts` | In-container agent runner (Claude SDK) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server exposing tools to agent |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Architecture

### Message Flow
1. Channel receives message → stored in SQLite (`store/messages.db`)
2. Message loop polls for new messages per group
3. Trigger check: `@name` pattern, `is_reply_to_bot`, or `requiresTrigger: false`
4. `processGroupMessages` batches pending messages → formats as XML → spawns container
5. Container runs Claude Agent SDK, outputs results via stdout markers
6. IPC: agent writes JSON files to `/workspace/ipc/messages/`, host watcher processes them

### Container Lifecycle
- One container per group at a time (managed by `GroupQueue`)
- Container stays alive between messages via IPC polling
- Follow-up messages piped into running container
- Idle timeout closes container after inactivity
- Session ID persisted in DB for conversation continuity across containers

### Channels
- **WhatsApp**: Baileys library, QR auth, `wa:` JID prefix
- **Signal**: signal-cli-rest-api sidecar (Docker), WebSocket for receive, REST for send, `sig:` JID prefix
- **Telegram**: grammY bot library, `tg:` JID prefix

### Signal-Specific Features
- ⚡ reaction on triggering message when bot starts processing
- Quote-reply: bot's response quotes the triggering message via `setReplyTarget()`
- `@mention` and reply-to-bot satisfy trigger (no `@g` prefix needed)
- `sendReaction()` for emoji reactions via `/v1/reactions/{number}`
- Signal group JIDs: `sig:group.{base64(groupId)}`
- Signal DM JIDs: `sig:+{phone}`

### IPC Tools (MCP server in container)
- `send_message` — send text to a chat
- `send_reaction` — react to a message with emoji (known issue: agent can't discover this tool yet)
- `schedule_task` — schedule recurring/one-time tasks

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run vitest
./container/build.sh # Rebuild agent container
```

### Running the Service

Currently run manually (no launchd plist configured yet):
```bash
# Start
npm run build && node dist/index.js >> /tmp/nanoclaw.log 2>&1 &

# Stop
pkill -f 'node dist/index'

# Restart (kill, rebuild, start)
pkill -f 'node dist/index'; sleep 2; npm run build && node dist/index.js >> /tmp/nanoclaw.log 2>&1 &

# Check logs
tail -f /tmp/nanoclaw.log

# Kill stale containers
docker ps -a --filter "name=nanoclaw" --format "{{.Names}}" | xargs -r docker rm -f
```

### After Code Changes
1. `npm run build` — compile TypeScript
2. Kill running process and restart
3. If container-side code changed (agent-runner, MCP server): `./container/build.sh`
4. If agent can't find new tools: clear session in DB (`DELETE FROM sessions WHERE group_folder = '...'`)

### Database
- Path: `store/messages.db` (SQLite)
- Key tables: `messages`, `chats`, `registered_groups`, `sessions`, `tasks`, `state`
- Sessions table maps `group_folder` → `session_id` for Claude SDK resumption
- Clear a session to force fresh tool discovery: `sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = 'familiar'"`

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Known Issues

- **send_reaction MCP tool not discoverable**: The `send_reaction` tool exists in the container's MCP server but the agent can't see it. Needs investigation — may be SDK tool discovery issue or allowedTools wildcard problem.
- **Duplicate processes**: If multiple NanoClaw processes run simultaneously, Signal WebSocket messages get split between them (only one consumer gets each message). Always ensure single instance.
