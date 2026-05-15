# NanoClaw v2 Specification

NanoClaw is a personal Claude assistant runtime with multi-channel messaging,
per-agent workspaces, scheduled work, and container-isolated execution. v2 is a
ground-up architecture: the host owns routing and persistence, while each agent
session runs in a container with only the mounts and credentials it is allowed
to use.

---

## 1. System Shape

```
messaging apps
  -> channel adapters
  -> host router
  -> data/v2.db
  -> data/v2-sessions/<agent_group_id>/<session_id>/inbound.db
  -> container/agent-runner
  -> data/v2-sessions/<agent_group_id>/<session_id>/outbound.db
  -> host delivery loop
  -> messaging apps
```

There is no file-based IPC, stdin prompt pipe, or shared message database
between host and container. The only host/container IO surface is the mounted
session DB pair:

- `inbound.db`: host writes, container reads
- `outbound.db`: container writes, host reads

The central DB, `data/v2.db`, is host-only and stores identity, permissions,
channel wiring, sessions, approvals, and Chat SDK state.

## 2. Technology Stack

| Component          | Current implementation                                | Purpose                                             |
| ------------------ | ----------------------------------------------------- | --------------------------------------------------- |
| Host runtime       | Node.js + pnpm                                        | Channel setup, routing, delivery, service lifecycle |
| Channel registry   | `src/channels/channel-registry.ts`                    | Channel modules self-register on import             |
| Central storage    | `data/v2.db` via `better-sqlite3`                     | Admin plane and durable routing state               |
| Session storage    | `inbound.db` + `outbound.db`                          | Per-session message flow across the container mount |
| Agent runner       | Bun in `container/agent-runner/`                      | Poll loop, formatting, MCP tools, provider bridge   |
| Agent provider     | `@anthropic-ai/claude-agent-sdk` pinned in `bun.lock` | Claude execution and tool/MCP integration           |
| Credential gateway | OneCLI Agent Vault                                    | Injects real credentials outside the container      |
| Browser automation | `agent-browser` + Chromium                            | Browser control inside the container                |

## 3. Channel System

The core channel barrel is `src/channels/index.ts`. Importing a channel module
calls `registerChannelAdapter()` from `src/channels/channel-registry.ts`.

At host startup:

1. `src/index.ts` imports `src/channels/index.ts`.
2. Each installed channel self-registers a factory and optional container
   contribution.
3. `initChannelAdapters()` instantiates adapters with credentials from `.env`
   or channel-specific auth state.
4. Inbound events are normalized into `InboundEvent` objects and sent to the
   router.

The repo can ship a small default channel set. Additional platform adapters are
installed by `/add-<channel>` skills, which add a module and append a
self-registration import.

## 4. Data Layout

```
data/
  v2.db
  v2-sessions/
    <agent_group_id>/
      .claude-shared/
        projects/
        session-env/
        skills/
      <session_id>/
        inbound.db
        outbound.db
        .heartbeat
        inbox/<message_id>/
        outbox/<message_id>/

groups/
  <folder>/
    CLAUDE.md
    CLAUDE.local.md
    container.json
    skills/
    .claude-fragments/

container/
  CLAUDE.md
  agent-runner/
    src/
    package.json
    bun.lock
  skills/
```

Path helpers for session folders and DB files live in `src/session-manager.ts`.
Central schema reference lives in `src/db/schema.ts`; detailed DB docs are in
`docs/db.md`, `docs/db-central.md`, and `docs/db-session.md`.

## 5. Core Entities

| Entity                        | Stored in             | Meaning                                                     |
| ----------------------------- | --------------------- | ----------------------------------------------------------- |
| `agent_groups`                | central DB            | Workspaces: folder, memory, skills, provider default        |
| `messaging_groups`            | central DB            | Platform chats, rooms, channels, or DMs                     |
| `messaging_group_agents`      | central DB            | Which agents listen to which messaging groups               |
| `users` / roles / memberships | central DB            | Identity and authorization                                  |
| `sessions`                    | central DB            | Active or historical runtime sessions                       |
| `messages_in`                 | session `inbound.db`  | Host-to-container messages, tasks, webhooks, system results |
| `messages_out`                | session `outbound.db` | Container-to-host messages and host action requests         |
| `processing_ack`              | session `outbound.db` | Container-side processing state for inbound messages        |

## 6. Session Modes

Routing can create sessions in three modes:

- `shared`: one session per messaging group.
- `per-thread`: one session per messaging group and platform thread.
- `agent-shared`: one session per agent group, shared across wired channels.

Every session gets its own folder under
`data/v2-sessions/<agent_group_id>/<session_id>/`. Multiple sessions can share
the same agent group workspace, but they do not share session DB files.

## 7. Message Flow

1. A channel adapter receives a message and emits an `InboundEvent`.
2. The host router resolves sender identity, channel wiring, engagement rules,
   and session mode.
3. The host creates or finds a session row in `data/v2.db`.
4. The host writes the inbound event to the session's `inbound.db`.
5. The host wakes the agent container if a due `trigger=1` message exists.
6. The container agent-runner polls `inbound.db` read-only, filters rows already
   acknowledged in `outbound.db`, formats a prompt, and invokes the provider.
7. The agent-runner writes responses, files, reactions, questions, approvals, or
   system actions to `outbound.db`.
8. The host delivery loop reads `outbound.db`, validates destination and
   permissions, sends through the channel adapter, and records delivery state in
   `inbound.db`.

## 8. Memory And Prompt Composition

Agent workspaces live in `groups/<folder>/`. `CLAUDE.md` is regenerated on each
spawn from:

- the shared base prompt in `container/CLAUDE.md`
- enabled skill fragments and MCP server instructions
- per-group local memory in `CLAUDE.local.md`

The regenerated `CLAUDE.md` and fragments are mounted read-only into the
container. `CLAUDE.local.md` remains writable through the group folder for
memory updates.

Claude state is shared per agent group at
`data/v2-sessions/<agent_group_id>/.claude-shared/` and mounted to
`/home/node/.claude`.

## 9. Container Mounts

A running session sees:

| Container path                    | Host source                       | Mode                                              |
| --------------------------------- | --------------------------------- | ------------------------------------------------- |
| `/workspace`                      | session folder                    | read-write                                        |
| `/workspace/agent`                | `groups/<folder>`                 | read-write, with selected nested read-only mounts |
| `/workspace/agent/CLAUDE.md`      | composed group prompt             | read-only                                         |
| `/workspace/agent/container.json` | group container config            | read-only                                         |
| `/app/CLAUDE.md`                  | shared base prompt                | read-only                                         |
| `/home/node/.claude`              | per-agent `.claude-shared` folder | read-write                                        |
| `/app/src`                        | shared agent-runner source        | read-only                                         |
| `/app/skills`                     | shared built-in skills            | read-only                                         |
| `/workspace/extra/*`              | allowlisted additional mounts     | per config                                        |

Credentials are not mounted. OneCLI injects real API keys at the gateway.

## 10. Scheduling

Scheduled work is represented as messages, not a separate task database.

- One-shot tasks are `messages_in` rows with `kind='task'` and `process_after`.
- Recurring tasks add a cron `recurrence`.
- The host sweep wakes stopped sessions when due work exists.
- After a recurring task completes, the host inserts the next occurrence.
- Scheduling MCP tools emit structured system actions; the host validates and
  applies them.

## 11. MCP And Host Actions

The agent-runner hosts MCP tools from `container/agent-runner/src/mcp-tools/`.
Tool modules register with the local MCP server, and many tools write structured
`messages_out` rows with `kind='system'`.

The host is the authority for actions such as sending messages, scheduling,
resetting sessions, changing permissions, or modifying container configuration.
The agent can request; the host validates and decides.

## 12. Setup And Operations

Useful entry points:

| Command                   | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `bash nanoclaw.sh`        | Full local setup                                           |
| `pnpm run setup:auto`     | Non-interactive setup sequencer                            |
| `pnpm run setup:bun`      | Install/check repo-pinned Bun for local agent-runner tests |
| `pnpm run auth`           | Run the WhatsApp auth setup step                           |
| `pnpm run chat`           | Talk to the local CLI channel                              |
| `pnpm test`               | Host tests                                                 |
| `pnpm run test:container` | Bun agent-runner tests                                     |

## 13. Security Invariants

- The central DB is host-only.
- Every session SQLite file has exactly one writer.
- Session DBs use `journal_mode=DELETE`; WAL is not safe across the mount.
- Host writes to `inbound.db` with short-lived connections.
- The container opens `inbound.db` read-only and never writes to it.
- The container writes only its own `outbound.db`, outbox files, heartbeat, and
  allowed workspace files.
- Credentials stay outside containers and are injected by OneCLI.
- Channel auth state such as `store/auth/` is host-only.
- Additional mounts are validated against the external allowlist.

## 14. Related Docs

- `docs/architecture.md` — design rationale and deeper runtime details
- `docs/db.md` — database overview and invariants
- `docs/db-central.md` — central DB tables
- `docs/db-session.md` — session DB tables and sequence rules
- `docs/agent-runner-details.md` — agent-runner internals
- `docs/build-and-runtime.md` — Node/Bun split, CI, Docker build surface
