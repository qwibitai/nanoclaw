# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to a channel provider (WhatsApp/Telegram/Slack), routes messages to Claude Agent SDK running in isolated Linux containers. Runtime providers select Apple Container or Docker.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/channels/telegram.ts` | Telegram provider (polling Bot API) |
| `src/channels/slack.ts` | Slack provider (polling Web API or signed webhook/events) |
| `src/channel-provider.ts` | Channel provider factory (primary channel selection) |
| `src/conversation.ts` | Conversation identity model (canonical IDs + kind) |
| `src/types.ts` | Channel interface, ChannelCapabilities, MessageAttachment |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Container runtime provider + factory (Apple/Docker) |
| `src/host-notifier.ts` | Host notification provider + factory |
| `src/service-manager.ts` | Service manager provider + factory (launchd/systemd) |
| `src/delivery.ts` | Reliable outbound sender (retry/backoff/dead-letter) |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
npm run service:status
npm run service:start
npm run service:stop
npm run service:restart
```

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`
