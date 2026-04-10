---
name: swarm-orchestration
description: A tmux-based persistent multi-agent swarm system with file-based inter-agent messaging
user-invocable: true
---

# Swarm Orchestration Skill

A tmux-based persistent multi-agent swarm system with file-based inter-agent messaging, leveraging Beads for task coordination.

## Overview

Swarm Orchestration enables Claude Code agents to work as persistent teams that:
- **Stay alive** in tmux sessions across disconnects
- **Communicate** via file-based inboxes (@mentions)
- **Share work** through a task queue (via Beads)
- **Coordinate** through a designated team leader

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      SWARM ORCHESTRATOR                         │
│  .claude/swarm/{team-id}/                                       │
│  ├── team.json        # Team metadata, members, state           │
│  ├── inbox/           # Inter-agent message inboxes             │
│  │   ├── leader.jsonl                                           │
│  │   ├── agent-1.jsonl                                          │
│  │   └── agent-2.jsonl                                          │
│  └── shared/          # Shared context files                    │
│      └── plan.md                                                │
├─────────────────────────────────────────────────────────────────┤
│                      BEADS COORDINATION                         │
│  bd swarm create epic-id    # Create DAG structure              │
│  bd ready --unassigned      # Work discovery                    │
│  bd update --assignee       # Claim work                        │
│  bd swarm status            # Progress tracking                 │
├─────────────────────────────────────────────────────────────────┤
│                      TMUX SESSIONS                              │
│  swarm-{team-id}-leader     # Team leader session               │
│  swarm-{team-id}-agent-1    # Worker agent 1                    │
│  swarm-{team-id}-agent-2    # Worker agent 2                    │
└─────────────────────────────────────────────────────────────────┘
```

## Isolation Modes

When creating a swarm, you choose how agents are isolated:

### Shared Mode (Default)

All agents work in the **same directory** on the **same branch**:

```
┌─────────────────────────────────────────┐
│        Working Directory (shared)        │
│                                          │
│  Agent-1 writes: convex/schema.ts       │
│  Agent-2 writes: src/hooks/useAuth.ts   │
│  Agent-3 writes: src/pages/Login.tsx    │
│                                          │
│  (All writing to same filesystem)        │
└─────────────────────────────────────────┘
```

**Pros:** Fast startup, no merge step, simpler
**Cons:** Risk of file conflicts if tasks overlap
**Best for:** Well-partitioned tasks, small teams

### Worktree Mode

Each agent gets its **own git worktree** with a **separate branch**:

```
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│  agent-1 worktree │  │  agent-2 worktree │  │  agent-3 worktree │
│  branch: swarm-   │  │  branch: swarm-   │  │  branch: swarm-   │
│    xxx-agent-1    │  │    xxx-agent-2    │  │    xxx-agent-3    │
│                   │  │                   │  │                   │
│  Full repo copy   │  │  Full repo copy   │  │  Full repo copy   │
└─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                                 ▼
                    ┌───────────────────────┐
                    │    git merge at end   │
                    │    (all branches)     │
                    └───────────────────────┘
```

**Pros:** Full isolation, agents commit independently, handles conflicts
**Cons:** Slower startup (creates worktrees), requires merge step
**Best for:** Large teams, overlapping files, safer rollback

### Choosing a Mode

| Scenario | Recommended Mode |
|----------|-----------------|
| Tasks touch different files | Shared |
| Tasks might touch same files | Worktree |
| Quick prototyping | Shared |
| Production feature work | Worktree |
| 2-3 agents | Shared |
| 4+ agents | Worktree |

## Quick Start

### Create a Swarm

```bash
# Ask about isolation mode (recommended)
/swarm-create --epic bd-epic-platform-rebuild --agents 3

# Explicit shared mode
/swarm-create --epic bd-epic-123 --agents 3 --isolation shared

# Explicit worktree mode (full isolation)
/swarm-create --epic bd-epic-123 --agents 3 --isolation worktree

# Dry run to preview
/swarm-create --epic bd-epic-123 --agents 2 --dry-run
```

### Monitor Status

```bash
/swarm-status swarm-1738585396
```

### Inter-Agent Communication

```bash
# Read inbox
/swarm-inbox

# Send message
/swarm-inbox --to agent-1 --msg "Task complete"

# Broadcast
/swarm-inbox --broadcast --msg "Taking a break"
```

### Shutdown

```bash
# Graceful shutdown
/swarm-shutdown swarm-1738585396

# Force shutdown
/swarm-shutdown swarm-1738585396 --force
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `/swarm-create` | Create a new swarm team from a Beads epic |
| `/swarm-join` | Join an existing swarm as a worker agent |
| `/swarm-inbox` | Read/send inter-agent messages |
| `/swarm-status` | Display team status dashboard |
| `/swarm-shutdown` | Gracefully terminate a swarm |

## Team Structure

### Team Metadata (`team.json`)

```json
{
  "team_id": "swarm-1738585396",
  "created_at": "2026-02-03T11:23:16Z",
  "epic_id": "bd-epic-123",
  "leader": {
    "session": "swarm-1738585396-leader",
    "status": "active",
    "role": "orchestrator"
  },
  "members": [
    {
      "name": "agent-1",
      "session": "swarm-1738585396-agent-1",
      "status": "active",
      "current_task": "bd-task-001",
      "worktree": ".claude/swarm/swarm-1738585396/worktrees/agent-1",
      "branch": "swarm-1738585396-agent-1"
    },
    {
      "name": "agent-2",
      "session": "swarm-1738585396-agent-2",
      "status": "idle",
      "current_task": null,
      "worktree": ".claude/swarm/swarm-1738585396/worktrees/agent-2",
      "branch": "swarm-1738585396-agent-2"
    }
  ],
  "config": {
    "max_members": 4,
    "inbox_poll_seconds": 5,
    "idle_timeout_minutes": 15,
    "isolation_mode": "worktree",
    "base_branch": "feat/my-feature"
  }
}
```

**Note:** `worktree` and `branch` fields only present when `isolation_mode` is `"worktree"`.

### Inbox Message Format

Messages are stored as JSONL (one JSON object per line):

```json
{
  "ts": "2026-02-03T11:25:00Z",
  "from": "leader",
  "to": "agent-1",
  "type": "task",
  "payload": {
    "task_id": "bd-task-001",
    "action": "start"
  }
}
```

### Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `task` | leader → agent | Assign work |
| `status` | agent → leader | Progress update |
| `complete` | agent → leader | Task finished |
| `handoff` | agent → agent | Pass work |
| `help` | agent → leader | Request assistance |
| `broadcast` | any → all | Team announcement |
| `shutdown` | system → all | Termination signal |

## Library Functions

The core library is at `.claude/utils/swarm-lib.sh`:

### Team Management

```bash
# Create team
TEAM_ID=$(swarm_create_team "bd-epic-123" 4)

# Get team info
swarm_get_team "$TEAM_ID"

# List all teams
swarm_list_teams

# Update team
swarm_update_team "$TEAM_ID" '{"status": "active"}'
```

### Agent Spawning

```bash
# Spawn leader
swarm_spawn_leader "$TEAM_ID" "Custom instructions"

# Spawn worker
swarm_spawn_agent "$TEAM_ID" "agent-1" "Custom instructions"
```

### Messaging

```bash
# Send message
swarm_send_message "$TEAM_ID" "leader" "agent-1" "task" '{"task_id": "bd-001"}'

# Broadcast
swarm_broadcast "$TEAM_ID" "leader" "status" '{"message": "All hands meeting"}'

# Read inbox
swarm_read_inbox "$TEAM_ID" "agent-1" --last 10

# Clear inbox
swarm_clear_inbox "$TEAM_ID" "agent-1"
```

### Status & Control

```bash
# Get comprehensive status
swarm_get_status "$TEAM_ID"

# Update member status
swarm_update_member_status "$TEAM_ID" "agent-1" "working" "bd-task-001"

# Shutdown team
swarm_shutdown "$TEAM_ID"         # Graceful
swarm_shutdown "$TEAM_ID" --force # Immediate

# Archive team
swarm_archive "$TEAM_ID"
```

## Beads Integration

Swarms integrate with Beads for task management:

```bash
# Create swarm structure from epic
bd swarm create bd-epic-123

# Check swarm progress
bd swarm status bd-epic-123 --json

# Link tasks to parent epic (use --parent, NOT --epic)
bd update bd-task-001 --parent bd-epic-123

# Find ready work (for leader)
bd ready --unassigned --json

# Claim task (for worker)
bd update bd-task-001 --assignee agent-1 --status in_progress

# Complete task (for worker)
bd close bd-task-001 --reason "Implementation complete"
```

## Agent Roles

### Leader

The team leader (`.claude/agents/swarm/leader.md`):

- **Coordinates** work distribution
- **Monitors** agent progress
- **Handles** blockers and escalations
- **Facilitates** handoffs between agents

### Worker

Worker agents (`.claude/agents/swarm/worker.md`):

- **Execute** assigned tasks
- **Report** progress to leader
- **Request** help when blocked
- **Handoff** work when appropriate

## Workflow Example

### 1. Create Swarm

```bash
/swarm-create --epic bd-epic-auth-refactor --agents 2
```

Output:
```
Created team: swarm-1738585396
Leader spawned: swarm-1738585396-leader
Agent spawned: swarm-1738585396-agent-1
Agent spawned: swarm-1738585396-agent-2
```

### 2. Leader Discovers Work

Leader checks for ready tasks:
```bash
bd ready --unassigned --json
# Returns: [{"id": "bd-task-001", "title": "Implement JWT tokens"}]
```

### 3. Leader Assigns Task

Leader sends task to idle agent:
```bash
swarm_send_message "swarm-1738585396" "leader" "agent-1" "task" \
  '{"task_id": "bd-task-001", "action": "start"}'
```

### 4. Agent Executes

Agent-1 receives task, claims it, works on it:
```bash
# Claim
bd update bd-task-001 --assignee agent-1 --status in_progress

# Work...

# Report progress
swarm_send_message "swarm-1738585396" "agent-1" "leader" "status" \
  '{"task_id": "bd-task-001", "progress": 50}'

# Complete
bd close bd-task-001 --reason "JWT implementation complete"

# Notify
swarm_send_message "swarm-1738585396" "agent-1" "leader" "complete" \
  '{"task_id": "bd-task-001"}'
```

### 5. Monitor Progress

```bash
/swarm-status swarm-1738585396
```

### 6. Shutdown When Done

```bash
/swarm-shutdown swarm-1738585396
```

### 7. Merge Worktrees (if using worktree mode)

If you used worktree isolation, merge agent branches back:

```bash
# Merge all agent branches to current branch
bash .claude/utils/swarm-lib.sh merge-worktrees swarm-1738585396

# Keep worktrees after merge (for debugging)
bash .claude/utils/swarm-lib.sh merge-worktrees swarm-1738585396 --no-delete

# Check what was merged
git log --oneline -10
```

## File Structure

```
.claude/
├── utils/
│   └── swarm-lib.sh           # Core library functions
├── commands/
│   ├── swarm-create.md        # Create swarm command
│   ├── swarm-join.md          # Join swarm command
│   ├── swarm-inbox.md         # Inbox operations
│   ├── swarm-status.md        # Status dashboard
│   └── swarm-shutdown.md      # Shutdown command
├── agents/swarm/
│   ├── leader.md              # Leader agent definition
│   └── worker.md              # Worker agent definition
├── skills/swarm-orchestration/
│   └── SKILL.md               # This documentation
└── swarm/                     # Runtime data (created per-team)
    └── swarm-{id}/
        ├── team.json
        ├── inbox/
        │   ├── leader.jsonl
        │   └── agent-*.jsonl
        └── shared/
```

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| "Team not found" | Check team ID exists: `swarm_list_teams` |
| "Session already exists" | Previous swarm not cleaned up: `/swarm-shutdown` |
| "At max capacity" | Increase `max_members` in team.json or use fewer agents |
| tmux not available | Install: `brew install tmux` |
| jq not available | Install: `brew install jq` |
| Beads not available | Install Beads plugin or work without task tracking |
| Agent stuck at shell prompt | Claude may not auto-start due to dotenv/zsh prompts. Attach (`tmux attach -t <session>`) and manually run `claude --dangerously-skip-permissions` |
| Detection timeout | Increase timeout in `wait_for_claude_ready()` or check for blocking prompts (dotenv, etc.) |

### Debugging

```bash
# Check tmux sessions
tmux list-sessions | grep swarm

# View agent output
tmux attach -t swarm-1738585396-agent-1

# Check inbox contents
cat .claude/swarm/swarm-1738585396/inbox/agent-1.jsonl | jq .

# Check team state
cat .claude/swarm/swarm-1738585396/team.json | jq .
```

## Limitations

- **Single machine** - All agents run on same host
- **File-based messaging** - Not real-time, polling-based
- **Manual recovery** - No automatic agent restart
- **Max 4 agents** - Default limit per team (configurable)

## Future Enhancements

Potential improvements for future versions:

- [ ] Automatic agent health monitoring and restart
- [ ] Cost tracking per agent
- [ ] WebSocket-based real-time messaging option
- [ ] Cross-machine agent distribution
- [ ] Visual dashboard UI
- [ ] Integration with more task trackers (GitHub Issues, Jira)

## Related Skills

- **tmux-monitor** - Monitor tmux sessions
- **spawn-agent** - Spawn individual agents
- **beads** - Task tracking integration
- **orchestrator** - Original multi-agent orchestration
