# NanoClaw Specification

A personal Claude assistant accessible via WhatsApp, with persistent memory per conversation, scheduled tasks, and email integration.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Commands](#commands)
8. [Scheduled Tasks](#scheduled-tasks)
9. [MCP Servers](#mcp-servers)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    HOST (Ubuntu Server 24.04)                        │
│                   (Main Node.js Process)                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                     ┌────────────────────┐        │
│  │  WhatsApp    │────────────────────▶│   SQLite Database  │        │
│  │  (baileys)   │◀────────────────────│   (messages.db)    │        │
│  └──────────────┘   store/send        └─────────┬──────────┘        │
│                                                  │                   │
│         ┌────────────────────────────────────────┘                   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  Message Loop    │    │  Scheduler Loop  │    │  IPC Watcher  │  │
│  │  (polls SQLite)  │    │  (checks tasks)  │    │  (file-based) │  │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘  │
│           │                       │                                  │
│           └───────────┬───────────┘                                  │
│                       │ spawns Firecracker microVM                   │
│                       ▼                                              │
├─────────────────────────────────────────────────────────────────────┤
│                  FIRECRACKER microVM (own Linux kernel)              │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    CLAUDE CODE CLI                            │   │
│  │                                                                │   │
│  │  Working directory: /workspace/group (copied from host)        │   │
│  │  Injected files:                                               │   │
│  │    • groups/{name}/ → /workspace/group                         │   │
│  │    • groups/global/ → /workspace/global/ (non-main only)       │   │
│  │    • data/sessions/{group}/.claude/ → /home/agent/.claude/     │   │
│  │    • Project root → /mnt/project (main only)                   │   │
│  │                                                                │   │
│  │  Tools (all groups):                                           │   │
│  │    • Bash (safe - sandboxed in microVM!)                       │   │
│  │    • Read, Write, Edit, Glob, Grep (file operations)           │   │
│  │    • WebSearch, WebFetch (internet access via bridge NAT)      │   │
│  │                                                                │   │
│  │  Network: 172.16.0.{N}/24 via tap{N} on fcbr0 bridge          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| WhatsApp Connection | Node.js (@whiskeysockets/baileys) | Connect to WhatsApp, send/receive messages |
| Message Storage | SQLite (better-sqlite3) | Store messages for polling |
| VM Runtime | Firecracker microVMs | Isolated microVMs with own Linux kernel per agent |
| Agent | Claude Code CLI (`--print --dangerously-skip-permissions`) | Run Claude with tools |
| API Gateway | Vercel AI Gateway | Route through Claude Max subscription ($0 API costs) |
| Runtime | Node.js 22+ | Host process for routing and scheduling |

---

## Folder Structure

```
nanoclaw/
├── CLAUDE.md                      # Project context for Claude Code
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   └── SECURITY.md                # Security model
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .env.example                   # Environment variable template
├── .gitignore
│
├── src/
│   ├── index.ts                   # Main application (WhatsApp + routing)
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces
│   ├── utils.ts                   # Generic utility functions
│   ├── db.ts                      # Database initialization and queries
│   ├── whatsapp-auth.ts           # Standalone WhatsApp authentication
│   ├── task-scheduler.ts          # Runs scheduled tasks when due
│   ├── mount-security.ts          # Validates mounts against allowlist
│   └── firecracker-runner.ts      # Spawns agents in Firecracker microVMs
│
├── scripts/
│   ├── build-agent-rootfs.sh      # Builds base Firecracker rootfs image
│   └── setup-firecracker-networking.sh  # Configures bridge + NAT
│
├── .claude/
│   └── skills/
│       ├── setup/                 # /setup skill
│       ├── customize/             # /customize skill
│       └── debug/                 # /debug skill (VM debugging)
│
├── groups/
│   ├── CLAUDE.md                  # Global memory (all groups read this)
│   ├── main/                      # Self-chat (main control channel)
│   │   ├── CLAUDE.md              # Main channel memory
│   │   └── logs/                  # Task execution logs
│   └── {Group Name}/              # Per-group folders (created on registration)
│       ├── CLAUDE.md              # Group-specific memory
│       ├── logs/                  # Task logs for this group
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   ├── auth/                      # WhatsApp authentication state
│   └── messages.db                # SQLite database
│
├── data/                          # Application state (gitignored)
│   ├── sessions.json              # Active session IDs per group
│   ├── registered_groups.json     # Group JID → folder mapping
│   ├── router_state.json          # Last processed timestamp
│   └── ipc/                       # IPC namespaces
│
└── logs/                          # Runtime logs (gitignored)
    ├── nanoclaw.log               # Host stdout
    └── nanoclaw.error.log         # Host stderr
    # Note: Per-VM logs are in groups/{folder}/logs/firecracker-*.log
```

---

## Configuration

Configuration constants are in `src/config.ts`:

```typescript
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '600000', 10);
```

### VM Configuration

Groups can have additional directories mounted via `containerConfig` in `data/registered_groups.json`:

```json
{
  "1234567890@g.us": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "/home/zack/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ],
      "timeout": 600000
    }
  }
}
```

Additional mounts are copied into the VM rootfs before boot.

### Claude Authentication

Claude Code authenticates via Vercel AI Gateway. Configure in `.env`:

```bash
VERCEL_AI_GATEWAY_KEY=your-vercel-ai-gateway-api-key
```

The key is injected into each VM rootfs at `/home/agent/.vercel-ai-gateway-key`.

---

## Memory System

NanoClaw uses a hierarchical memory system based on CLAUDE.md files.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/CLAUDE.md` | All groups | Main only | Preferences, facts, context shared across all conversations |
| **Group** | `groups/{name}/CLAUDE.md` | That group | That group | Group-specific context, conversation memory |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents created during conversation |

### How Memory Works

1. **Agent Context Loading**
   - Files are copied into the VM rootfs at `/workspace/group/`
   - Claude Code reads CLAUDE.md files from the working directory

2. **Writing Memory**
   - When user says "remember this", agent writes to `CLAUDE.md` inside the VM
   - Changed files are synced back to host after task completion

3. **Main Channel Privileges**
   - Only the "main" group gets the project root at `/mnt/project`
   - Main can manage registered groups and schedule tasks for any group
   - All groups have Bash access (safe because it runs inside the microVM)

---

## Session Management

Sessions enable conversation continuity - Claude remembers what you talked about.

### How Sessions Work

1. Each group has a session ID stored in `data/sessions.json`
2. Claude credentials at `data/sessions/{group}/.claude/` are injected into the VM
3. Claude continues the conversation with full context

---

## Message Flow

### Incoming Message Flow

```
1. User sends WhatsApp message
   │
   ▼
2. Baileys receives message via WhatsApp Web protocol
   │
   ▼
3. Message stored in SQLite (store/messages.db)
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Router checks:
   ├── Is chat_jid in registered_groups.json? → No: ignore
   └── Does message start with @Assistant? → No: ignore
   │
   ▼
6. Router catches up conversation:
   ├── Fetch all messages since last agent interaction
   ├── Format with timestamp and sender name
   └── Build prompt with full conversation context
   │
   ▼
7. firecracker-runner.ts runTask():
   a. Allocate VM ID and IP (172.16.0.{N+1})
   b. Create TAP device, attach to fcbr0 bridge
   c. Copy base rootfs, inject SSH key, credentials, project files
   d. Boot Firecracker VM via API socket
   e. Wait for SSH (~2-5s)
   f. Execute: claude --print --dangerously-skip-permissions
   │
   ▼
8. Claude Code inside microVM:
   ├── Reads CLAUDE.md files for context
   ├── Uses tools as needed
   └── Authenticates via Vercel AI Gateway (Claude Max)
   │
   ▼
9. Capture output, sync changed files back, destroy VM
   │
   ▼
10. Router prefixes response with assistant name and sends via WhatsApp
```

---

## Commands

### Commands Available in Any Group

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant [message]` | `@Andy what's the weather?` | Talk to Claude |

### Commands Available in Main Channel Only

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant add group "Name"` | `@Andy add group "Family Chat"` | Register a new group |
| `@Assistant list groups` | `@Andy list groups` | Show registered groups |
| `@Assistant remember [fact]` | `@Andy remember I prefer dark mode` | Add to global memory |

---

## Scheduled Tasks

NanoClaw has a built-in scheduler that runs tasks as full agents in their group's context.

### Schedule Types

| Type | Value Format | Example |
|------|--------------|---------|
| `cron` | Cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | ISO timestamp | `2024-12-25T09:00:00Z` |

---

## MCP Servers

### NanoClaw MCP (built-in)

**Available Tools:**
| Tool | Purpose |
|------|---------|
| `schedule_task` | Schedule a recurring or one-time task |
| `list_tasks` | Show tasks (group's tasks, or all if main) |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task |
| `send_message` | Send a WhatsApp message to the group |

---

## Deployment

NanoClaw runs as a systemd service on Ubuntu Server 24.04.

### Startup Sequence

1. **Verifies Firecracker setup** - /dev/kvm, firecracker binary, kernel, rootfs, bridge
2. Initializes the SQLite database
3. Loads state (registered groups, sessions, router state)
4. Connects to WhatsApp
5. Starts the message polling loop, scheduler loop, and IPC watcher

### Managing the Service

```bash
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
sudo systemctl status nanoclaw
tail -f logs/nanoclaw.log
```

---

## Security Considerations

### Firecracker MicroVM Isolation

All agents run inside Firecracker microVMs (each with its own Linux kernel), providing:
- **Kernel isolation**: Each agent has its own kernel, isolated at the hypervisor level
- **Filesystem isolation**: Files are copied into the rootfs, not live-mounted
- **Safe Bash access**: Commands run inside the VM, not on the host
- **Network isolation**: VMs on a private bridge with NAT
- **Ephemeral VMs**: Fresh VM per invocation, destroyed after completion

### Credential Storage

| Credential | Storage Location | Notes |
|------------|------------------|-------|
| Claude Auth | data/sessions/{group}/.claude/ | Per-group, copied into VM rootfs |
| Vercel AI Gateway Key | .env (host) | Injected into VM at boot |
| WhatsApp Session | store/auth/ | Host only, never in VMs |

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `systemctl status nanoclaw` |
| VM fails to boot | Missing /dev/kvm | Add user to kvm group |
| SSH timeout | Bridge not configured | Run `npm run setup-network` |
| "QR code expired" | WhatsApp session expired | Delete store/auth/ and restart |

### Debug Mode

```bash
LOG_LEVEL=debug npm run dev
```
