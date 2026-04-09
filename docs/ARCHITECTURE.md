# Nexus Architecture (As-Built v0.2.0)

## System Overview

```
Console (Deno Fresh, localhost:8000 / Deno Deploy)
  [Operator: Ymir | Foundry | BEC]
       |
       v  /api/proxy/*
       |
  simt-nexus-mgf (Fly.io lhr)
  +--------------------------------------------+
  | Gateway :3001 (public)                      |
  |   Discord bot, web-chat, work queue         |
  |       |                         |           |
  |       v                         v           |
  | Agent (internal)         Store :3002        |
  |   polls /work/next       (internal+volume)  |
  |   Agent SDK query()      sessions, events,  |
  |   JSONL sync             JSONL transcripts  |
  +--------------------------------------------+
```

## Three Processes

| Process | Port | Public? | Fly VM | Purpose |
|---|---|---|---|---|
| **Gateway** | 3001 | Yes (HTTPS) | shared-cpu-2x, 1GB | Channels, work queue, public API |
| **Agent** | — | No | shared-cpu-2x, 1GB | Claude Agent SDK, workspace, JSONL sync |
| **Store** | 3002 | No | shared-cpu-1x, 512MB + Volume | Persistence: sessions, events, JSONL |

## Message Flow (Discord)

```
1. Discord message → Gateway (discord.ts)
   - Build context prefix: [Server, Channel, From]
   - Get/create session via Store
   - Download attachment URLs (if images)
   - Enqueue WorkItem

2. Agent polls GET /work/next → receives WorkItem
   - Restore JSONL from Store (if not local)
   - Build workspace (once per session, reuse on follow-ups)
   - Run Agent SDK query() with resume:sessionId
   - Persist JSONL to Store (if size changed)
   - POST /work/complete with self-describing WorkResult

3. Gateway receives WorkResult
   - Completion callback sends Discord reply
   - Event logged to Store with correct session ID
```

## Persistence (Store)

The Store process owns all data that must survive restarts:

```
/data/store/ (Fly Volume)
  store.json          sessions index + activity events (last 200)
  jsonl/
    web-chat-default.jsonl
    discord-1491489737796616372.jsonl
```

| API | Method | Purpose |
|---|---|---|
| `/sessions` | GET, POST | List/create sessions |
| `/sessions/:id` | GET, DELETE | Get/delete session |
| `/sessions/:id/touch` | PUT | Update lastActivity, increment messageCount |
| `/sessions/:id/agent-session` | GET, PUT | Agent SDK session UUID mapping |
| `/sessions/:id/jsonl` | GET, PUT | Raw JSONL transcript (binary) |
| `/sessions/:id/messages` | GET | Parsed messages from JSONL [{role, content}] |
| `/events` | GET, POST | Activity event log |
| `/health` | GET | Health check |

## Workspace Caching

Workspaces are built once per session, not per message:

- First message: reads operator context, skills, knowledge → builds CLAUDE.md
- Follow-up messages: reuses existing workspace (CLAUDE.md exists check)
- Skills and knowledge read from project root via `additionalDirectories` — not copied
- Old workspaces (>7 days inactive) cleaned up on agent startup

## JSONL Sync

Agent SDK session transcripts are synced to/from the Store:

- **Before query**: if JSONL file missing locally, restore from Store (handles restart/deploy)
- **After query**: if file size increased, upload to Store
- Optimised: skips download if file exists, skips upload if unchanged

## Channels & Sessions

Channels are platform adapters. Sessions are persistent conversation contexts.

| Channel | Session format | Example |
|---|---|---|
| web-chat | `web-chat-{channelId}` | `web-chat-default` |
| discord | `discord-{channelId}` | `discord-1491489737796616372` |

Discord messages include a context prefix:
```
[Discord — Server: YMIR, Channel: #training]
[From: Damon Rand (@damonrand, ID: 490404963543814327)]
```

## Fly.io Deployment

Three process groups in `fly.toml`. Store has a Fly Volume.

```bash
deno task deploy:mgf    # Foundry
deno task deploy:bec    # BEC
```

Deploy script stages only target operator's data into `.build-data/`.

Gateway and agent find store via Fly internal DNS:
`http://store.process.simt-nexus-mgf.internal:3002`

## Operators

| Operator | App | Slug | Discord Bot |
|---|---|---|---|
| Ymir (local) | localhost | `ymir` | Nexus for Ymir#0994 |
| Microgrid Foundry | `simt-nexus-mgf` | `foundry` | Nexus for Foundry#8925 |
| Bristol Energy | `simt-nexus-bec` | `bec` | Not connected |

## Known Limitations

1. **In-memory queue**: Work queue lost on gateway restart. Scale to 1 gateway.
2. **Single store machine**: FilesystemBackend is single-threaded. Fly Volume attached to one machine.
3. **No auth on gateway API**: Plan to add API key auth for Console access.
4. **JSONL grows unbounded**: Need periodic compaction or archiving strategy.
5. **Workspace /tmp ephemeral**: Workspaces lost on agent redeploy, rebuilt on next message.
