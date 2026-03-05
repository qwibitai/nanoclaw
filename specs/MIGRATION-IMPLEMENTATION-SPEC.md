# OpenClaw → NanoClaw Migration: Implementation Spec

**Purpose:** Step-by-step, non-ambiguous plan for a worker agent to execute the full migration.

---

## Prerequisites

- NanoClaw is cloned at `/Users/vinchenkov/Documents/dev/claws/NanoClaw/`
- OpenClaw workspace lives at `~/.openclaw/workspace/`
- Discord bot token and guild/channel IDs are available from `~/.openclaw/openclaw.json`
- MiniMax M2.5 API credentials (base URL + auth token) are available
- Node.js ≥ 22, npm, Docker (or Apple Container) installed

---

## Phase 1: Base NanoClaw Setup

### Step 1.1 — Install Dependencies

```bash
cd /Users/vinchenkov/Documents/dev/claws/NanoClaw
npm install
```

### Step 1.2 — Create `.env`

Create `/Users/vinchenkov/Documents/dev/claws/NanoClaw/.env` with:

```env
ANTHROPIC_BASE_URL=<base_url from openclaw.json providers.anthropic-messages.base_url>
ANTHROPIC_AUTH_TOKEN=<token from openclaw.json providers.anthropic-messages.api_key>
ASSISTANT_NAME=Homie
CONTAINER_TIMEOUT=4500000
MAX_CONCURRENT_CONTAINERS=2
TZ=America/Los_Angeles
LOG_LEVEL=info
```

**Source values from:** `~/.openclaw/openclaw.json` → `providers["anthropic-messages"]` block.

The `CONTAINER_TIMEOUT` is set to 75 minutes (60 min task + 15 min grace from `routing.json`).

`MAX_CONCURRENT_CONTAINERS=2` — one for orchestrator tick, one for worker. Matches the single-worker-at-a-time invariant while allowing the orchestrator to fire.

### Step 1.3 — Build Container Image

```bash
cd /Users/vinchenkov/Documents/dev/claws/NanoClaw
./container/build.sh
```

### Step 1.4 — Add Discord Channel

Run the `/add-discord` skill inside the NanoClaw project. Use the Discord bot token, guild ID, and channel IDs from `~/.openclaw/openclaw.json` → `channels.discord`:

- **Bot token:** `channels.discord.bot_token`
- **Guild allowlist:** `channels.discord.guild_allowlist` (single guild)
- **Channel allowlist:** `channels.discord.channel_allowlist` (the specific channels Homie posts to)

This creates `src/channels/discord.ts` and adds `DISCORD_BOT_TOKEN` to `.env`.

### Step 1.5 — Create Mount Allowlist

Create `~/.config/nanoclaw/mount-allowlist.json`:

```json
{
  "allowedRoots": [
    {
      "path": "~/Documents/dev/dirtsignals",
      "allowReadWrite": true,
      "description": "ProjectCal / DirtSignals code repo"
    },
    {
      "path": "~/.openclaw/workspace",
      "allowReadWrite": false,
      "description": "Legacy OpenClaw workspace (read-only reference)"
    }
  ],
  "blockedPatterns": [
    ".ssh", ".gnupg", ".aws", ".kube", ".docker",
    ".env", ".netrc", ".npmrc", ".pypirc",
    "id_rsa", "id_ed25519", "private_key", ".secret", "credentials"
  ],
  "nonMainReadOnly": false
}
```

**Note:** `nonMainReadOnly` is set to `false` because the worker group (non-main) needs read-write access to the homie group folder via additional mounts. The allowlist's `allowedRoots` entries individually control read-write permissions per path.

### Step 1.6 — Run Setup

```bash
cd /Users/vinchenkov/Documents/dev/claws/NanoClaw
npm run setup
```

Register the Discord channel as the main group during setup.

---

## Phase 2: Group Structure

### Step 2.1 — Create Group Folders

```
NanoClaw/groups/
├── global/
│   └── CLAUDE.md          ← Global memory (SOUL + USER + MEMORY merged)
├── main/
│   └── CLAUDE.md          ← Main admin group (Discord self-chat)
├── homie/
│   ├── CLAUDE.md          ← Orchestrator instructions (ORCHESTRATOR.md equivalent)
│   ├── mission-control/
│   │   ├── tasks/         ← Port existing task files
│   │   ├── initiatives/   ← Port existing initiative files
│   │   ├── outputs/       ← Port existing outputs
│   │   ├── lock.json      ← Worker lock file
│   │   └── activity.log.ndjson  ← Append-only audit trail
│   ├── bin/
│   │   └── mc.ts          ← Rebuilt mc CLI tool
│   ├── briefings/         ← Daily briefing outputs
│   └── workers/
│       └── WORKERS.md     ← Worker execution contract
└── worker/
    └── CLAUDE.md          ← Worker agent instructions
```

Create these directories:

```bash
cd /Users/vinchenkov/Documents/dev/claws/NanoClaw
mkdir -p groups/homie/mission-control/{tasks,initiatives,outputs}
mkdir -p groups/homie/bin
mkdir -p groups/homie/briefings
mkdir -p groups/homie/workers
mkdir -p groups/worker
```

### Step 2.2 — Write `groups/global/CLAUDE.md`

Merge `SOUL.md`, `USER.md`, and `MEMORY.md` into the global CLAUDE.md. This file is read-only for non-main groups and serves as the shared system prompt.

Source files:
- `~/.openclaw/workspace/SOUL.md`
- `~/.openclaw/workspace/USER.md`
- `~/.openclaw/workspace/MEMORY.md`

Write `groups/global/CLAUDE.md` with sections:

```markdown
# Identity

<paste full content of SOUL.md here>

# User Profile

<paste full content of USER.md here>

# Long-Term Memory

<paste full content of MEMORY.md here>
```

**Exact content:** Read each source file and paste verbatim into the appropriate section. Do not summarize or edit.

### Step 2.3 — Write `groups/homie/CLAUDE.md`

This replaces `ORCHESTRATOR.md`. It defines the tick loop for the scheduled orchestrator task.

```markdown
# Homie — Orchestrator

You are the orchestrator. You run on a scheduled interval (every 15 minutes). Each run is a fresh container — you have no memory of previous ticks beyond what's in these files and the mission-control directory.

## Tick Loop

Execute these steps in order on every tick:

### Step 1 — Daily Briefing (8:00–8:15 AM PST only)

Check the current time. If between 08:00 and 08:15 AND no briefing exists at `briefings/YYYY-MM-DD.md` for today:
1. Read all active initiatives and their tasks
2. Read USER.md context from /workspace/global/CLAUDE.md
3. Compile a briefing covering: active initiatives, task progress, blocked items, priorities for today
4. Write briefing to `briefings/YYYY-MM-DD.md`
5. Send briefing to Discord via `send_message` MCP tool
6. Log `daily.briefing` event to `mission-control/activity.log.ndjson`

### Step 2 — Load State

Read all of:
1. All files in `mission-control/tasks/` (YAML frontmatter)
2. All files in `mission-control/initiatives/` (YAML frontmatter)
3. `mission-control/lock.json`
4. Last 50 lines of `mission-control/activity.log.ndjson`
5. Global context from `/workspace/global/CLAUDE.md`

### Step 3 — Handle Lock (if worker running)

If `lock.json` has `locked: true`:
1. Calculate elapsed time: `now - acquired_at`
2. If elapsed > `timeout_minutes + grace_minutes`: hard kill
   - Update task to `failed` (if retry_count < 2) or `blocked`
   - Release lock (`locked: false`)
   - Send Discord notification
   - Log `worker.killed` event
3. If elapsed > `timeout_minutes` AND `wrap_up_sent` is false:
   - Log `worker.wrap_up_sent` event
   - Update lock: `wrap_up_sent: true`
   - (The worker itself should be writing a RESUME file)
4. Otherwise: do nothing, worker is still running. Self-terminate.

**Important:** You cannot actually kill a running container from inside another container. If a worker has exceeded its timeout + grace, set the lock to `locked: false` and update the task status. The container runtime will handle the actual timeout kill. The next tick will see the released lock and proceed.

### Step 4 — Verify Completed Work

For tasks with `status: done`:
- Read outputs listed in the task's `outputs` field
- If outputs exist and are reasonable: update status to `verified` via mc
- If outputs missing/empty: update status to `failed`, set failure_reason

For tasks with `status: cancelled` or `status: blocked`:
- Confirm the reason is valid
- Send Discord notification if newly blocked

For tasks with `status: failed`:
- If `retry_count < 2`: update status to `ready` (mc auto-increments retry_count)
- If `retry_count >= 2`: send Discord notification, leave as failed

### Step 5 — Select Next Task

Find the highest-priority `ready` task:
- Priority sort: P0 > P1 > P2 > P3
- Among same priority: prefer tasks from active (non-paused) initiatives
- Check `depends_on` — all dependencies must be `verified` or `cancelled`
- If no ready tasks exist: consider creating new tasks/initiatives based on USER.md objectives

### Step 6 — Dispatch Worker

1. Update task to `in_progress` via mc, set `started_at`
2. Write `lock.json`:
   ```json
   {
     "locked": true,
     "task_id": "<TASK_ID>",
     "worker_type": "<from task's worker_type field>",
     "acquired_at": "<ISO timestamp>",
     "timeout_minutes": 60,
     "grace_minutes": 15,
     "wrap_up_sent": false
   }
   ```
3. Read the task file content
4. Read `workers/WORKERS.md`
5. Check for `mission-control/RESUME-<task_id>.md`
6. Construct a worker prompt combining: WORKERS.md + task file content + RESUME content (if any)
7. Schedule an immediate worker via `schedule_task` MCP tool:
   ```
   schedule_type: "once"
   schedule_value: <now + 5 seconds, ISO format, no Z suffix>
   context_mode: "isolated"
   prompt: <constructed worker prompt>
   target_group_jid: <worker group JID>
   ```
8. Log `worker.spawned` event to activity log
9. Self-terminate (done for this tick)

## File Format Reference

### Task YAML Frontmatter
```yaml
id: T-YYYYMMDD-XXXX or I-SEQ-TITLE-KEBAB-UPPER
title: "..."
status: backlog|ready|in_progress|done|blocked|failed|cancelled|verified
priority: P0|P1|P2|P3
worker_type: coding|research|writing|long|ops|admin
origin: user|autonomous
initiative: null or initiative ID
description: "..."
acceptance_criteria: [{description: "...", done: false}]
outputs: ["mission-control/outputs/..."]
project: null
depends_on: []
retry_count: 0
blocked_reason: null
failure_reason: null
cancellation_reason: null
created_at: ISO
started_at: null
completed_at: null
updated_at: ISO
due: null
```

### Initiative YAML Frontmatter
```yaml
id: I-TITLE-KEBAB-UPPER
title: "..."
status: active|paused|complete|archived
objective: projectcal|robotics|ai-writing|north-star|other
goal: "..."
timeframe: "..."
tasks: ["TASK-ID-1", "TASK-ID-2"]
created_at: ISO
updated_at: ISO
```

### Lock Schema
```json
{
  "locked": true|false,
  "task_id": "...",
  "worker_type": "...",
  "acquired_at": "ISO",
  "timeout_minutes": 60,
  "grace_minutes": 15,
  "wrap_up_sent": false
}
```

### Activity Log (NDJSON, one per line)
```json
{"ts":"ISO","actor":"homie|worker|mc","event":"EVENT_TYPE","task_id":"...","detail":"..."}
```

Event types: `daily.briefing`, `task.created`, `task.status_changed`, `task.completed`, `task.verified`, `progress.note`, `worker.spawned`, `worker.wrap_up_sent`, `worker.killed`, `initiative.created`, `initiative.status_changed`, `initiative.completed`

### Status Transitions
- backlog → ready, cancelled
- ready → in_progress, backlog, cancelled
- in_progress → done, blocked, failed, cancelled
- blocked → ready, cancelled
- failed → ready (auto-increments retry_count)
- done → verified
- verified → (terminal)
- cancelled → (terminal)

## MC Tool Usage

All task/initiative mutations go through the mc CLI tool. Never edit task/initiative YAML files directly.

```bash
# From inside the container, mc.ts is at /workspace/group/bin/mc.ts
node /workspace/group/bin/mc.ts task create --title "..." --description "..." --worker-type research --priority P1 --initiative I-EXAMPLE --origin autonomous
node /workspace/group/bin/mc.ts task update <ID> --status done --outputs "mission-control/outputs/..."
node /workspace/group/bin/mc.ts task list --status ready
node /workspace/group/bin/mc.ts initiative create --title "..." --goal "..." --objective projectcal --timeframe "2 weeks"
node /workspace/group/bin/mc.ts lock status
node /workspace/group/bin/mc.ts lock acquire --task-id <ID> --worker-type coding
node /workspace/group/bin/mc.ts lock release
```

**Note:** These mc paths are for the orchestrator (whose working dir is `/workspace/group/` = the homie folder). Workers must use `node /workspace/extra/homie/bin/mc.ts --base-dir /workspace/extra/homie` instead (see Phase 7).
```

### Step 2.4 — Write `groups/homie/workers/WORKERS.md`

Port the content from `~/.openclaw/workspace/workers/WORKERS.md` with path adjustments:

Replace all references to:
- `~/. openclaw/workspace/mission-control/outputs/` → `mission-control/outputs/` (relative to `/workspace/group/`)
- `bun run .../bin/mc.ts` → `node /workspace/group/bin/mc.ts`
- Any absolute OpenClaw paths → relative NanoClaw container paths

The WORKERS.md should instruct the worker:
1. Read the task details from the prompt (injected by orchestrator)
2. Execute the work described in the task
3. Write outputs to `mission-control/outputs/<task_id>-<desc>.<ext>` (path is relative to `/workspace/group/`, which is the homie group folder mounted into the worker container)
4. On success: `node /workspace/group/bin/mc.ts task update <task_id> --status done --outputs "mission-control/outputs/..."`
5. On blocked: write RESUME file to `mission-control/RESUME-<task_id>.md`, update status to blocked
6. On failure: update status to failed with reason
7. Release lock: `node /workspace/group/bin/mc.ts lock release`

**Critical:** The worker MUST always release the lock before terminating, regardless of outcome.

### Step 2.5 — Write `groups/worker/CLAUDE.md`

```markdown
# Worker Agent

You are a worker agent executing a specific task. Your instructions, task details, and context are provided in the prompt that launched this container.

## Working Directory

Your working directory is `/workspace/group/` which contains the worker group files. The homie group's mission-control is available at `/workspace/extra/homie/mission-control/`.

## Tools Available

- `send_message`: Send status updates to Discord
- All standard Claude Code tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch)
- Git worktrees for code changes in `/workspace/extra/dirtsignals/`

## Important Rules

1. Follow the task instructions exactly
2. Write outputs to the specified output paths
3. Update task status via mc when done
4. Always release the lock when finished
5. If you're running out of time, write a RESUME file with your progress
```

### Step 2.6 — Initialize `mission-control/lock.json`

```bash
echo '{"locked": false}' > /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/lock.json
```

### Step 2.7 — Initialize `mission-control/activity.log.ndjson`

```bash
touch /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/activity.log.ndjson
```

---

## Phase 3: Port Mission Control Data

### Step 3.1 — Copy Task Files

Copy all task files from OpenClaw to NanoClaw:

```bash
cp ~/.openclaw/workspace/mission-control/tasks/*.md \
   /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/tasks/
```

No modifications needed — the YAML frontmatter format is preserved as-is.

### Step 3.2 — Copy Initiative Files

```bash
cp ~/.openclaw/workspace/mission-control/initiatives/*.md \
   /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/initiatives/
```

### Step 3.3 — Copy Output Files

```bash
cp -r ~/.openclaw/workspace/mission-control/outputs/* \
   /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/outputs/
```

### Step 3.4 — Copy Activity Log

```bash
cp ~/.openclaw/workspace/mission-control/activity.log.ndjson \
   /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/activity.log.ndjson
```

### Step 3.5 — Copy Briefings

```bash
cp -r ~/.openclaw/workspace/memory/briefings/* \
   /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/briefings/ 2>/dev/null || true
```

---

## Phase 4: Rebuild `mc` CLI Tool

### Step 4.1 — Create `groups/homie/bin/mc.ts`

Rebuild the mc CLI tool as a standalone Node.js script (no bun dependency — the container has Node.js). Port from `~/.openclaw/workspace/bin/mc.ts` and its library `~/.openclaw/workspace/bin/mc-lib.ts`.

The tool must support all the same commands:

```
node mc.ts task create --title "..." --description "..." --worker-type <type> --priority <P0-P3> [--initiative <ID>] [--origin user|autonomous] [--depends-on <ID1,ID2>]
node mc.ts task get <ID>
node mc.ts task list [--initiative <ID>] [--status <status>]
node mc.ts task update <ID> [--status <status>] [--priority <P0-P3>] [--outputs <path1,path2>] [--blocked-reason "..."] [--failure-reason "..."] [--cancellation-reason "..."]
node mc.ts initiative create --title "..." --goal "..." --objective <obj> --timeframe "..." [--status active|paused]
node mc.ts initiative get <ID>
node mc.ts initiative list [--status <status>]
node mc.ts initiative update <ID> --status <status>
node mc.ts lock status
node mc.ts lock acquire --task-id <ID> --worker-type <type>
node mc.ts lock release
```

**Key implementation details:**

1. **File paths:** All paths relative to `process.cwd()` which will be `/workspace/group/` (the homie group folder) inside the container. Tasks at `mission-control/tasks/<id>.md`, initiatives at `mission-control/initiatives/<id>.md`.

2. **YAML frontmatter:** Use a simple YAML parser. The existing mc-lib.ts uses `--- YAML ---` frontmatter with markdown body. Parse with regex: extract between first `---` and second `---`, rest is markdown body.

3. **ID generation:**
   - Standalone tasks: `T-YYYYMMDD-XXXX` (4-digit daily sequence, scan existing files to find next)
   - Initiative tasks: `I-SEQ-TITLE-KEBAB-UPPER` (3-digit sequence within initiative)

4. **Status transitions:** Enforce the allowed transitions map. Reject invalid transitions with an error.

5. **Activity log:** Append NDJSON line to `mission-control/activity.log.ndjson` on every mutation.

6. **Lock operations:**
   - `lock acquire`: Write lock.json with task_id, worker_type, acquired_at, timeout (60), grace (15)
   - `lock release`: Write `{"locked": false}`
   - `lock status`: Print current lock state

7. **No external dependencies.** Use only Node.js built-in modules (`fs`, `path`). Parse YAML manually (the frontmatter is simple key-value pairs, arrays, and nested objects — write a minimal parser or use regex extraction). Stringify YAML manually for writing.

**Port from:** Read `~/.openclaw/workspace/bin/mc.ts` and `~/.openclaw/workspace/bin/mc-lib.ts` for the exact logic. Rewrite in plain Node.js (no bun, no external packages).

---

## Phase 5: Register Groups & Configure Container Mounts

### Step 5.1 — Register the Homie Group

The homie group needs to be registered so the scheduler can run tasks in it. Register it via the main group or directly in the database.

Use the NanoClaw setup process or register via IPC from the main group:

```
register_group:
  jid: "homie-orchestrator"  (synthetic JID — this group only runs scheduled tasks, not channel messages)
  name: "Homie Orchestrator"
  folder: "homie"
  trigger: "@Homie"
  containerConfig:
    timeout: 300000  (5 min — orchestrator ticks should be fast)
    additionalMounts:
      - hostPath: "~/Documents/dev/dirtsignals"
        containerPath: "dirtsignals"
        readonly: false
```

### Step 5.2 — Register the Worker Group

```
register_group:
  jid: "worker-agent"  (synthetic JID)
  name: "Worker Agent"
  folder: "worker"
  trigger: "@Worker"
  containerConfig:
    timeout: 4500000  (75 min — 60 min task + 15 min grace)
    additionalMounts:
      - hostPath: "~/Documents/dev/dirtsignals"
        containerPath: "dirtsignals"
        readonly: false
      - hostPath: "<NanoClaw>/groups/homie"
        containerPath: "homie"
        readonly: false
```

**Critical:** The worker group mounts the homie group folder at `/workspace/extra/homie/` so workers can read task files, write outputs, write RESUME files, update tasks via mc, and release the lock. This mount must be read-write.

To enable this, add the NanoClaw groups directory to the mount allowlist:

Update `~/.config/nanoclaw/mount-allowlist.json` to include:

```json
{
  "path": "~/Documents/dev/claws/NanoClaw/groups/homie",
  "allowReadWrite": true,
  "description": "Homie group folder (shared with worker for mission-control access)"
}
```

### Step 5.3 — Database Registration

If the groups can't be registered via IPC (synthetic JIDs may not work with channel routing), register them directly in SQLite:

```sql
INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
VALUES (
  'homie-orchestrator',
  'Homie Orchestrator',
  'homie',
  '@Homie',
  datetime('now'),
  '{"timeout":300000,"additionalMounts":[{"hostPath":"~/Documents/dev/dirtsignals","containerPath":"dirtsignals","readonly":false}]}',
  0,
  0
);

INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
VALUES (
  'worker-agent',
  'Worker Agent',
  'worker',
  '@Worker',
  datetime('now'),
  '{"timeout":4500000,"additionalMounts":[{"hostPath":"~/Documents/dev/dirtsignals","containerPath":"dirtsignals","readonly":false},{"hostPath":"~/Documents/dev/claws/NanoClaw/groups/homie","containerPath":"homie","readonly":false}]}',
  0,
  0
);
```

---

## Phase 6: Schedule the Orchestrator Heartbeat

### Step 6.1 — Create the Scheduled Task

From the main group (via Discord or setup), schedule the orchestrator heartbeat:

Use the `schedule_task` MCP tool from the main group:

```
schedule_task:
  prompt: "Execute your orchestrator tick loop. Read CLAUDE.md for full instructions."
  schedule_type: "interval"
  schedule_value: "900000"  (15 minutes in milliseconds)
  context_mode: "isolated"  (each tick is fresh — state lives in files, not session)
  target_group_jid: "homie-orchestrator"
```

Alternatively, insert directly into SQLite:

```sql
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, context_mode, created_at)
VALUES (
  'heartbeat-15min',
  'homie',
  'homie-orchestrator',
  'Execute your orchestrator tick loop. Read CLAUDE.md for full instructions.',
  'interval',
  '900000',
  datetime('now', '+15 minutes'),
  'active',
  'isolated',
  datetime('now')
);
```

### Step 6.2 — Create Daily Briefing Task (Optional)

The orchestrator CLAUDE.md already handles the daily briefing in Step 1 of the tick loop. However, for reliability, you can also schedule a dedicated briefing task:

```sql
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, context_mode, created_at)
VALUES (
  'daily-briefing',
  'homie',
  'homie-orchestrator',
  'Compile and send the daily briefing. Read mission-control/tasks/ and initiatives/ for current state. Write briefing to briefings/YYYY-MM-DD.md and send via send_message.',
  'cron',
  '0 8 * * *',
  NULL,
  'active',
  'isolated',
  datetime('now')
);
```

---

## Phase 7: Worker Dispatch Mechanism

### Step 7.1 — How the Orchestrator Dispatches Workers

The orchestrator (running in the `homie` group) dispatches workers by scheduling a `once` task in the `worker` group via the `schedule_task` MCP tool.

**Inside the orchestrator container, the dispatch call looks like:**

```
Use the schedule_task MCP tool with:
  prompt: <assembled worker prompt — see below>
  schedule_type: "once"
  schedule_value: <ISO timestamp 5 seconds from now, local time, no Z suffix>
  context_mode: "isolated"
  target_group_jid: "worker-agent"
```

**Assembled worker prompt structure:**

```
# Worker Task Assignment

## Worker Contract
<content of workers/WORKERS.md>

## Task Details
<full content of the task YAML file from mission-control/tasks/<task_id>.md>

## Resume Context (if applicable)
<content of mission-control/RESUME-<task_id>.md, or "No resume file — fresh start.">

## Mission Control Paths
- Task files: /workspace/extra/homie/mission-control/tasks/
- Outputs: /workspace/extra/homie/mission-control/outputs/
- Lock: /workspace/extra/homie/mission-control/lock.json
- Activity log: /workspace/extra/homie/mission-control/activity.log.ndjson
- MC tool: node /workspace/extra/homie/bin/mc.ts
- RESUME files: /workspace/extra/homie/mission-control/RESUME-<task_id>.md

## DirtSignals Repo
Available at: /workspace/extra/dirtsignals/
Use git worktrees for code changes.

## Discord Notifications
Use the send_message MCP tool to send status updates.
```

### Step 7.2 — Worker Container Path Mapping

When the worker container runs, it has these mounts:

| Host Path | Container Path | Access |
|-----------|---------------|--------|
| `groups/worker/` | `/workspace/group` | rw |
| `groups/global/` | `/workspace/global` | ro |
| `groups/homie/` | `/workspace/extra/homie` | rw |
| `~/Documents/dev/dirtsignals/` | `/workspace/extra/dirtsignals` | rw |
| `data/ipc/worker/` | `/workspace/ipc` | rw |
| `data/sessions/worker/.claude/` | `/home/node/.claude` | rw |

The worker reads task files and writes outputs via `/workspace/extra/homie/mission-control/`. The mc tool runs from `/workspace/extra/homie/bin/mc.ts` and operates on files relative to `/workspace/extra/homie/`.

### Step 7.3 — MC Tool Working Directory

The mc tool uses `process.cwd()` to find mission-control files. Since the worker's working directory is `/workspace/group` (the worker group), the mc tool needs to be invoked with the correct working directory or accept a `--base-dir` flag.

**Solution:** Add a `--base-dir` flag to mc.ts:

```bash
# Worker invokes mc like:
node /workspace/extra/homie/bin/mc.ts --base-dir /workspace/extra/homie task update <ID> --status done
```

When `--base-dir` is provided, mc resolves all paths (tasks/, initiatives/, lock.json, activity.log.ndjson) relative to that directory instead of `process.cwd()`.

When `--base-dir` is NOT provided, it defaults to `process.cwd()` (which works for the orchestrator since its working dir is `/workspace/group/` = the homie group folder).

---

## Phase 8: Verification & Testing

### Step 8.1 — Verify Global CLAUDE.md

Read `groups/global/CLAUDE.md` and confirm it contains SOUL.md, USER.md, and MEMORY.md content merged correctly.

### Step 8.2 — Verify Orchestrator CLAUDE.md

Read `groups/homie/CLAUDE.md` and confirm the tick loop is complete and unambiguous.

### Step 8.3 — Verify MC Tool

Run the mc tool locally to test:

```bash
cd /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie
node bin/mc.ts task list
node bin/mc.ts lock status
node bin/mc.ts initiative list
```

Confirm it reads existing task/initiative files correctly.

### Step 8.4 — Verify Container Build

```bash
docker images | grep nanoclaw-agent
```

### Step 8.5 — Verify Discord Channel

Start NanoClaw and confirm the Discord bot connects and responds to messages.

### Step 8.6 — Test Orchestrator Tick

Manually trigger the orchestrator by inserting a task with `next_run` in the past:

```sql
UPDATE scheduled_tasks SET next_run = datetime('now', '-1 minute') WHERE id = 'heartbeat-15min';
```

Watch the logs to confirm the orchestrator:
1. Reads mission-control state
2. Finds a ready task (or reports none)
3. Would dispatch a worker (or does dispatch one)

### Step 8.7 — Test Worker Dispatch

If the orchestrator dispatched a worker, verify:
1. A `once` scheduled task appeared in the database for the worker group
2. The worker container ran
3. The worker could read task files from `/workspace/extra/homie/mission-control/`
4. The worker could run mc to update task status
5. The lock was released after worker completion

---

## Phase 9: Cutover Checklist

### Step 9.1 — Stop OpenClaw

```bash
# Stop the OpenClaw gateway/heartbeat
# (method depends on how it's running — systemd, launchd, tmux, etc.)
```

### Step 9.2 — Final Data Sync

Re-copy any task/initiative files that changed since Phase 3:

```bash
cp ~/.openclaw/workspace/mission-control/tasks/*.md \
   /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/tasks/
cp ~/.openclaw/workspace/mission-control/initiatives/*.md \
   /Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/initiatives/
```

### Step 9.3 — Start NanoClaw

```bash
cd /Users/vinchenkov/Documents/dev/claws/NanoClaw
npm run dev
```

### Step 9.4 — Verify Heartbeat Fires

Watch logs for the first orchestrator tick. Confirm it completes successfully.

---

## Appendix A: Key Differences from OpenClaw

| Aspect | OpenClaw | NanoClaw |
|--------|----------|----------|
| Orchestrator session | Persistent (session history) | Stateless (each tick fresh) |
| Worker spawning | `sessions_spawn` (in-process) | `schedule_task` once (IPC → container) |
| Context injection | Bootstrap hook (in-memory) | Full prompt construction by orchestrator |
| Worker timeout kill | Gateway kills subagent process | Container runtime hard timeout |
| Lock enforcement | Application-level (hook reads lock) | File-based (orchestrator checks lock.json) |
| Model routing | Per-route in routing.json | Single model via ANTHROPIC_BASE_URL |
| Activity log | Identical NDJSON format | Identical NDJSON format (ported) |
| Task/Initiative format | Identical YAML frontmatter | Identical YAML frontmatter (ported) |
| MC tool | Runs via bun | Runs via node (no external deps) |

## Appendix B: Files to Create (Summary)

| File | Source |
|------|--------|
| `.env` | New (values from openclaw.json) |
| `~/.config/nanoclaw/mount-allowlist.json` | New |
| `groups/global/CLAUDE.md` | Merged from SOUL.md + USER.md + MEMORY.md |
| `groups/homie/CLAUDE.md` | Rewritten from ORCHESTRATOR.md |
| `groups/homie/workers/WORKERS.md` | Ported from workspace/workers/WORKERS.md |
| `groups/homie/bin/mc.ts` | Rebuilt from workspace/bin/mc.ts + mc-lib.ts |
| `groups/homie/mission-control/lock.json` | New (`{"locked": false}`) |
| `groups/homie/mission-control/activity.log.ndjson` | Copied from OpenClaw |
| `groups/homie/mission-control/tasks/*.md` | Copied from OpenClaw |
| `groups/homie/mission-control/initiatives/*.md` | Copied from OpenClaw |
| `groups/homie/mission-control/outputs/*` | Copied from OpenClaw |
| `groups/worker/CLAUDE.md` | New |
| `src/channels/discord.ts` | Created by /add-discord skill |

## Appendix C: Not Migrated (Intentionally)

- **`routing.json`** — All routes use the same model. NanoClaw uses a single model config. If per-route models are needed later, modify the orchestrator prompt to set `ANTHROPIC_BASE_URL` per worker via the prompt.
- **`inject-worker-context` hook** — Replaced by the orchestrator constructing the full worker prompt in Step 6 of the tick loop.
- **`HEARTBEAT.md`** — Replaced by the scheduled task prompt.
- **`sessions_spawn` mechanism** — Replaced by `schedule_task` with `schedule_type: "once"`.
- **Session compaction (`safeguard`)** — NanoClaw uses Claude Agent SDK's built-in compaction with PreCompact hooks for archival. The `isolated` context mode makes this irrelevant for the orchestrator.
- **Exec-approvals / tool deny (`browser`)** — Container isolation is stronger than application-level tool restrictions. Browser is not installed in the container by default.
