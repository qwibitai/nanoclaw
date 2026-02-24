# Cloud Hosting and Persistent State

## How Groups Run

NanoClaw is a **single Node.js process** that spawns ephemeral Docker containers on demand — one per active group conversation.

### Container Lifecycle

1. Message arrives for a registered group
2. `GroupQueue` (`src/group-queue.ts`) checks concurrency (max `MAX_CONCURRENT_CONTAINERS`, default 5)
3. Host calls `docker run -i --rm` with bind mounts for the group's directories
4. Container runs the agent (Claude SDK), receives input via stdin, communicates results via stdout markers
5. While active, follow-up messages are fed via IPC files written to the shared mount
6. After 30 min idle (configurable `IDLE_TIMEOUT`), the container is reaped
7. `--rm` flag ensures automatic cleanup on exit

### Container Runtime

Hardcoded to Docker in `src/container-runtime.ts:10`:

```typescript
export const CONTAINER_RUNTIME_BIN = 'docker';
```

The runtime is abstracted into a single file with three functions (`readonlyMountArgs`, `stopContainer`, `ensureContainerRuntimeRunning`). Swapping to Podman or another OCI runtime means changing this one file. There's also a `/convert-to-apple-container` skill for macOS.

### Concurrency Model

`GroupQueue` enforces:
- **One container per group** at a time — messages queue and are fed via IPC while the container is active
- **Global concurrency cap** — groups beyond the limit wait in a FIFO queue
- **Priority** — scheduled tasks run before queued messages when draining
- **Retry with backoff** — failed containers retry up to 5 times with exponential backoff (5s base)

### Bind Mounts per Container

Each container gets these host directories mounted:

| Mount | Container Path | Read/Write | Purpose |
|---|---|---|---|
| `groups/{folder}/` | `/workspace/group` | RW | Group's working directory and memory |
| `groups/global/` | `/workspace/global` | RO | Shared global CLAUDE.md |
| `data/sessions/{folder}/.claude/` | `/home/node/.claude` | RW | Claude session, settings, skills |
| `data/ipc/{folder}/` | `/workspace/ipc` | RW | IPC messages, tasks, input files |
| `data/sessions/{folder}/agent-runner-src/` | `/app/src` | RW | Per-group agent runner source |
| Project root (main only) | `/workspace/project` | RO | Application source code |
| Additional mounts (if configured) | `/workspace/extra/{name}` | Configurable | User-defined directories |

---

## Persistent State — What Lives Where

### Host Filesystem (must survive restarts)

| Path | Content | Criticality |
|---|---|---|
| `store/auth/` | WhatsApp authentication credentials (creds.json + signal keys) | **Critical** — loss requires re-scanning QR code |
| `store/messages.db` | SQLite database (messages, groups, sessions, tasks, router state) | **Critical** — all application state |
| `groups/*/` | Per-group working directories and CLAUDE.md memory files | Important — agent memory and context |
| `data/sessions/*/` | Per-group Claude sessions and agent runner source | Important — session continuity |
| `data/ipc/*/` | IPC files (transient, recreated on each container run) | Ephemeral |
| `~/.config/nanoclaw/` | Mount allowlist, credentials key (future) | **Critical** — security configuration |

### Channel Authentication Persistence

Each channel has different authentication characteristics:

#### WhatsApp — Stateful, File-Based, Fragile

- **Auth state**: `store/auth/` directory containing `creds.json` and multiple signal key files
- **Managed by**: Baileys' `useMultiFileAuthState()` (`src/channels/whatsapp.ts:57`)
- **Updates continuously**: `sock.ev.on('creds.update', saveCreds)` at line 153 — signal keys rotate and must be persisted after every update
- **Loss impact**: Must re-authenticate by scanning QR code or entering pairing code. WhatsApp limits linked devices and may require re-verification
- **Cloud concern**: **High** — this directory must be on durable storage. Losing it mid-session can corrupt the link and require full re-auth. It's also written to frequently (key rotation), so it needs low-latency writes

#### Telegram — Stateless, Token-Based, Simple

- **Auth state**: A single bot token string (from BotFather), stored in `.env` as `TELEGRAM_BOT_TOKEN`
- **No persistent session files** — `new Bot(this.botToken)` in `telegram.ts:31` is all that's needed
- **Loss impact**: None — the token is permanent until manually revoked via BotFather
- **Cloud concern**: **Low** — just needs the token in the environment. No filesystem persistence required for auth

#### Slack (from PR #423) — Stateless, Token-Based, Simple

- **Auth state**: Two tokens in `.env`: `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
- **No persistent session files** — Socket Mode connects fresh on each start
- **Loss impact**: None — tokens are permanent until regenerated in Slack admin
- **Cloud concern**: **Low** — just needs tokens in the environment

#### Discord (from built-in skill) — Stateless, Token-Based, Simple

- **Auth state**: A single bot token in `.env` as `DISCORD_BOT_TOKEN`
- **No persistent session files**
- **Loss impact**: None — token is permanent until regenerated
- **Cloud concern**: **Low**

**Summary**: WhatsApp is the only channel with persistent, frequently-updated auth state that must survive across restarts. All other channels use static API tokens.

### Does `/add-persistent-secrets` (PR #449) Address This?

**No.** The persistent-secrets skill solves a different problem — it persists secrets generated *by the agent inside containers* (GPG keys, gopass stores) across container restarts. It mounts `data/secrets/{group}/` into containers at `/workspace/secrets/`.

WhatsApp auth lives on the **host side** (`store/auth/`), not inside containers. The WhatsApp channel runs in the host Node.js process, not in agent containers. The persistent-secrets skill is irrelevant to channel authentication persistence.

| Concern | Persistent-secrets skill | What's actually needed |
|---|---|---|
| WhatsApp auth (`store/auth/`) | Not addressed — host-side state | Durable volume for `store/` |
| SQLite database (`store/messages.db`) | Not addressed — host-side state | Durable volume for `store/` |
| Agent-generated secrets (GPG, etc.) | Addressed | — |
| Channel tokens (Telegram, Slack) | Not addressed — env vars | Secrets manager or `.env` on durable storage |

---

## Cloud Hosting Options

### Option A: Single VM with Docker (works today, zero code changes)

Run NanoClaw on a VM with Docker installed. This is what the project is designed for.

| Cloud | Instance | Cost (approx.) |
|---|---|---|
| AWS | EC2 `t3.medium` (2 vCPU, 4GB) with EBS | ~$30/month |
| Azure | `B2s` (2 vCPU, 4GB) with managed disk | ~$30/month |
| GCP | `e2-medium` with persistent disk | ~$25/month |
| Hetzner | `CX22` (2 vCPU, 4GB) | ~$5/month |

**Persistent storage**: Local disk or attached block storage (EBS/Azure Disk). The `store/` directory and `groups/` directory need to survive instance restarts. A simple systemd service (already supported by the `/setup` skill) handles auto-start.

**Pros**: Zero changes, full compatibility, simple ops.
**Cons**: Single point of failure, manual scaling, you manage the VM.

### Option B: VM with Container Orchestration Assist

Same as Option A but use Docker Compose or similar to manage the NanoClaw process and auto-restart. Add a cron job or cloud-native snapshot for backup of `store/` and `groups/`.

### Option C: Container Service with Docker-in-Docker

Run the host process in a container that itself can spawn Docker containers.

| Cloud | Service | Feasibility |
|---|---|---|
| AWS ECS (EC2 launch type) | Mount Docker socket from host | Possible but requires EC2 instances, not Fargate |
| AWS ECS (Fargate) | No Docker socket access | **Not possible** without sidecar hacks |
| Azure Container Instances | No Docker socket | **Not possible** natively |
| Azure Container Apps | No Docker socket | **Not possible** natively |
| Kubernetes (EKS/AKS/GKE) | Docker socket or DinD sidecar | Possible with privileged pods + DinD sidecar |

**Persistent storage**: Requires EFS (AWS), Azure Files, or a PersistentVolume (K8s) for `store/`, `groups/`, and `data/`.

**Pros**: More cloud-native, can use managed services for monitoring/logging.
**Cons**: Complexity of DinD, security implications of privileged containers, shared volume latency.

### Option D: Rearchitect for Serverless Containers (major rewrite)

Replace `docker run` with cloud API calls to spawn agent containers as separate tasks/pods.

**Changes required**:
- `src/container-runtime.ts` — replace Docker CLI with AWS ECS RunTask / Azure ACI API
- `src/container-runner.ts` — replace bind mounts with shared volumes (EFS/Azure Files), replace stdin/stdout with a message queue or shared storage for input/output
- `src/group-queue.ts` — adapt concurrency tracking to async task status polling
- `src/ipc.ts` — replace filesystem IPC with SQS, Redis pub/sub, or similar
- `store/messages.db` — migrate from SQLite to RDS/DynamoDB/CosmosDB (SQLite doesn't work on network filesystems reliably)

**Pros**: Cloud-native, horizontally scalable, no privileged containers.
**Cons**: Significant rewrite, higher operational complexity, higher cost (managed DB, message queue, shared filesystem).

---

## Recommendation

**Start with Option A** (VM with Docker). It works today with zero changes and covers most use cases. The project is designed for single-node deployment and the concurrency model (5 concurrent containers) fits comfortably on a small VM.

If cloud-native hosting becomes a requirement later, the cleanest path is **Option D** — but scope it as a separate project. The container runtime abstraction (`src/container-runtime.ts`) and the single-file secret reading (`src/env.ts`) were designed with swappability in mind, but the bind-mount and filesystem-IPC assumptions run deep.
