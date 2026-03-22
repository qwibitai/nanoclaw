# Development Journal

This document captures the development journey of this NanoClaw installation — configuration decisions, custom changes, and the memory architecture as it has evolved. It is intended to help future-us understand why things are the way they are.

---

## This Installation

- **Host**: VBraspi5NVME (Raspberry Pi 5, Linux/ARM64)
- **Assistant name**: vbotpi
- **Primary channel**: WhatsApp (self-chat as main, plus group channels)
- **Container runtime**: Docker (rootless)
- **Service manager**: systemd (user service)

### Registered Groups

| Group | Folder | Trigger required |
|-------|--------|-----------------|
| vbotpi (self-chat) | `whatsapp_main` | No (is_main) |
| Dad/Mark/Dave | `whatsapp_dad-mark-dave` | Yes (`vbotpi` or `@vbotpi`) |
| Bala bots | `whatsapp_bala-bots` | Yes (`vbotpi` or `@vbotpi`) |

---

## Architecture Notes

### Message flow

```
WhatsApp → SQLite → Poll loop → Trigger check → Container (Claude Agent SDK) → Response
```

Single Node.js process. Channels self-register at startup based on credentials present. Per-group message queue with global concurrency control.

### Container lifecycle

Each group runs agents in its own Docker container, spawned on demand:

- **Session persistence**: 30 minutes (`IDLE_TIMEOUT = 1800000ms`), reset on each agent response. The Claude Agent SDK resumes the existing session (`resumeAt: latest`) within this window — no cold-start cost for follow-up messages.
- **Hard timeout**: `max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30s)` = 30.5 minutes. After that the container is killed and the next message starts fresh.
- **Tasks**: Scheduled tasks use a 10-second close delay after result, not the full idle timeout.

### IPC — two distinct directories

Agents communicate back to the host via files in `/workspace/ipc/`:

| Directory | Purpose | Example use |
|-----------|---------|-------------|
| `ipc/{group}/messages/` | Send a WhatsApp message directly (bypasses agent) | `{ "type": "message", "chatJid": "...", "text": "..." }` |
| `ipc/{group}/tasks/` | Invoke a task operation (schedule, pause, cancel, register group…) | `{ "type": "schedule_task", "prompt": "...", "schedule_type": "once", ... }` |

**Important**: To have the agent deliver a message (in its own voice, with session context), use `schedule_task` with `schedule_type: "once"`. Using `messages/` directly sends raw text and completely bypasses the agent.

### Trigger pattern

```
TRIGGER_PATTERN = /\bvbotpi\b/i
```

- Matches the word `vbotpi` anywhere in a message (not just at the start)
- Case-insensitive
- `@` is already optional — `@vbotpi` and `vbotpi` both match because `@` acts as a word boundary
- Controlled by `ASSISTANT_NAME` env var in `.env`

---

## Memory Architecture

Three separate, independent memory systems:

### 1. Claude Code memory (host only)

```
~/.claude/projects/-home-snecvb-vbprojects-nanoclaw/memory/
```

Written by Claude Code during host sessions (this terminal). Not visible to any container agent. Used to track project context, pending work, and user preferences across Claude Code conversations.

### 2. Global mnemon store

```
groups/global/.mnemon/
```

Shared knowledge available to all agents. **Read-only inside containers** — only writable from the host (Claude Code). Mounted into every container at `/workspace/global/.mnemon`.

Agents query it with:
```bash
mnemon recall "keyword" --data-dir /workspace/global/.mnemon
```

The global store is mounted **writable** inside containers (so mnemon can update access counts and log ops), but by convention agents should only write to their local store. Use `--readonly` if you want to suppress all writes.

### 3. Local mnemon stores (per group)

```
data/sessions/{group-folder}/.mnemon/
```

Each group has its own isolated mnemon DB, writable by that agent only. Mounted into the container at `/home/node/.mnemon`.

### Memory hooks (all groups)

All group agents have identical hooks in their `settings.json`:

- **UserPromptSubmit**: runs `mnemon recall` on each incoming message, injects relevant memories as `<system-reminder>` context
- **Stop**: prompts the agent to store anything important before the session ends (agent's judgment — no automated threshold)

mnemon categories: `preference | decision | fact | insight | context | general`
Importance: 1 (low) → 5 (critical)

### Global mnemon contents (as of Mar 16 2026)

| Content | Category | Importance |
|---------|----------|------------|
| Vivian Balakrishnan is married to Joy. Four children: Natalie, Mark, David, Luke. | fact | 5 |
| Grandchildren in birth order: Theo, Erin, Ethan, Kayla, Emma, Penelope, Evan (stillborn Dec 2022), Matthew (Feb 2024). | fact | 5 |
| Luke is Vivian and Joy's youngest son. No children yet. | fact | 4 |

---

## Custom Skills Added

### `/promote-to-global-memory`

**Location**: `.claude/skills/promote-to-global-memory/SKILL.md`

Promotes memories from a group's local mnemon DB to the global shared store, then clears the local copies (since agents already have read-only access to global, local copies are redundant).

**Rules:**
- Only promotes categories: `fact`, `preference`
- Only promotes importance ≥ 4
- Skipped categories (group-specific): `context`, `decision`, `insight`, `general`
- Conflict handling (Option A): if a local memory contradicts an existing global entry, skip promotion and flag for human review — never silently overwrite

**Invocation:**
```
/promote-to-global-memory [group-folder]   # specific group
/promote-to-global-memory                  # all groups
```

**First run (Mar 16 2026 — whatsapp_main):**
- 3 family facts already existed in global (identical) → cleared from local
- 1 tooling note (mnemon `--readonly` flag) → left in local (nanoclaw-specific, not globally useful)
- 0 conflicts

---

## Completed Work

### `/extract-memories-from-transcripts`

Skill built and run. Transcripts transferred from other nanoclaw instance to `groups/global/transcripts/`. All 9 transcripts processed and approved entries written to mnemon. Tracked in `processed.txt`.

---

## Operational Notes

### Service management (Linux/systemd)

```bash
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw
```

Logs:
```bash
tail -f logs/nanoclaw.log        # main app
tail -f logs/nanoclaw.error.log  # errors (Docker startup failures etc.)
```

### Common issue: Docker not ready at startup

The systemd service starts before Docker's rootless socket is ready, causing `FATAL: Container runtime failed to start`. The service restarts automatically (RestartSec=5) and recovers. Pending messages are queued and replayed on reconnect.

### Credential proxy

Containers use `ANTHROPIC_BASE_URL=http://host.docker.internal:3001` with a placeholder OAuth token. The credential proxy (`src/credential-proxy.ts`) runs on port 3001 and dynamically reads the real OAuth token from the Claude CLI credentials file at request time.
