---
name: swarm-status
description: Display comprehensive status dashboard for a swarm team
user-invocable: true
---

# /swarm-status

Display a comprehensive status dashboard for a swarm team.

## Usage

```bash
/swarm-status [team-id]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `team-id` | No | Team ID to check. If omitted, shows all teams. |

## Process

When you receive this command:

1. **Load Team Data**
   ```bash
   source {{HOME_TOOL_DIR}}/utils/swarm-lib.sh

   if [ -n "$TEAM_ID" ]; then
     STATUS=$(swarm_get_status "$TEAM_ID")
   else
     # List all teams
     for team in $(swarm_list_teams); do
       swarm_get_status "$team"
     done
   fi
   ```

2. **Fetch Beads Progress** (if epic linked)
   ```bash
   EPIC_ID=$(echo "$STATUS" | jq -r '.epic_id')
   if [ -n "$EPIC_ID" ] && [ "$EPIC_ID" != "null" ]; then
     BEADS_STATUS=$(bd swarm status "$EPIC_ID" --json 2>/dev/null || echo '{}')
     TOTAL_TASKS=$(echo "$BEADS_STATUS" | jq -r '.total // 0')
     COMPLETED_TASKS=$(echo "$BEADS_STATUS" | jq -r '.completed // 0')
     PROGRESS_PCT=$((COMPLETED_TASKS * 100 / (TOTAL_TASKS + 1)))
   fi
   ```

3. **Format Dashboard Output**

## Output Format

```
================================================================
  SWARM STATUS: swarm-1738585396
================================================================

OVERVIEW
----------------------------------------------------------------
  Epic:        bd-epic-platform-rebuild
  Created:     2026-02-03 11:23:16
  Progress:    6/15 complete (40%)
  ========---------- 40%

LEADER
----------------------------------------------------------------
  Session:     swarm-1738585396-leader
  Status:      * active (coordinating)
  Tmux:        running
  Unread:      2 messages

AGENTS
----------------------------------------------------------------
  NAME       STATUS       TASK              DURATION   UNREAD
  --------   ----------   ---------------   --------   ------
  agent-1    * working    bd-task-007       45m 12s    0
  agent-2    o idle       (waiting)         --         1
  agent-3    * working    bd-task-009       12m 03s    0

READY WORK (Unassigned)
----------------------------------------------------------------
  bd-task-010  [P1] Implement user profile API
  bd-task-011  [P2] Add validation middleware
  bd-task-012  [P2] Write integration tests

RECENT MESSAGES
----------------------------------------------------------------
  11:45  agent-1 -> leader:  "Backend API complete, ready for review"
  11:47  leader -> agent-2:  "Pick up bd-task-010 when ready"
  11:50  agent-3 -> leader:  "50% progress on bd-task-009"

COMMANDS
----------------------------------------------------------------
  Attach to leader:    tmux attach -t swarm-1738585396-leader
  Attach to agent-1:   tmux attach -t swarm-1738585396-agent-1
  Check inbox:         /swarm-inbox
  Shutdown:            /swarm-shutdown swarm-1738585396

================================================================
```

## Status Indicators

| Symbol | Meaning |
|--------|---------|
| `*` | Active/Working |
| `o` | Idle/Waiting |
| `~` | Starting/Initializing |
| `x` | Error/Dead |
| `+` | Running (tmux) |
| `-` | Not running (tmux) |

## Implementation Details

### Get Comprehensive Status

```bash
get_full_status() {
  local team_id="$1"
  local team_dir="{{HOME_TOOL_DIR}}/swarm/$team_id"

  # Basic team info
  local team_json=$(cat "$team_dir/team.json")
  local epic_id=$(echo "$team_json" | jq -r '.epic_id')

  # Beads progress
  local beads_info='{}'
  if command -v bd &>/dev/null && [ -n "$epic_id" ]; then
    beads_info=$(bd swarm status "$epic_id" --json 2>/dev/null || echo '{}')
  fi

  # Check tmux sessions
  local leader_session=$(echo "$team_json" | jq -r '.leader.session')
  local leader_alive=false
  tmux has-session -t "$leader_session" 2>/dev/null && leader_alive=true

  # Check each agent
  local agents_status="[]"
  for member in $(echo "$team_json" | jq -c '.members[]'); do
    local name=$(echo "$member" | jq -r '.name')
    local session=$(echo "$member" | jq -r '.session')
    local alive=false
    tmux has-session -t "$session" 2>/dev/null && alive=true

    # Count unread
    local inbox="$team_dir/inbox/$name.jsonl"
    local unread=$(wc -l < "$inbox" 2>/dev/null | tr -d ' ' || echo 0)

    agents_status=$(echo "$agents_status" | jq \
      --argjson m "$member" \
      --argjson alive "$alive" \
      --argjson unread "$unread" \
      '. += [$m + {tmux_alive: $alive, unread: $unread}]')
  done

  # Get ready work
  local ready_work='[]'
  if command -v bd &>/dev/null; then
    ready_work=$(bd ready --unassigned --json 2>/dev/null || echo '[]')
  fi

  # Recent messages (from all inboxes)
  local recent_messages='[]'
  for inbox in "$team_dir"/inbox/*.jsonl; do
    if [ -f "$inbox" ]; then
      local msgs=$(tail -5 "$inbox" 2>/dev/null || echo '')
      if [ -n "$msgs" ]; then
        recent_messages=$(echo "$recent_messages" | jq --slurpfile new <(echo "$msgs" | jq -s '.') '. + $new[0]')
      fi
    fi
  done
  recent_messages=$(echo "$recent_messages" | jq 'sort_by(.ts) | .[-5:]')

  # Combine all
  jq -n \
    --argjson team "$team_json" \
    --argjson beads "$beads_info" \
    --argjson leader_alive "$leader_alive" \
    --argjson agents "$agents_status" \
    --argjson ready "$ready_work" \
    --argjson messages "$recent_messages" \
    '{
      team: $team,
      beads: $beads,
      leader_alive: $leader_alive,
      agents: $agents,
      ready_work: $ready,
      recent_messages: $messages
    }'
}
```

## List All Teams

When no team-id provided:

```
================================================================
  ACTIVE SWARMS
================================================================

  TEAM ID              EPIC                    AGENTS   PROGRESS
  ------------------   ---------------------   ------   --------
  swarm-1738585396     bd-epic-platform        3/4      40%
  swarm-1738590000     bd-epic-auth-refactor   2/4      75%

  Use: /swarm-status <team-id> for details
================================================================
```

## Error Handling

| Error | Output |
|-------|--------|
| Team not found | "Error: Team {id} not found. Use /swarm-status to list teams." |
| No teams exist | "No active swarms. Create one with /swarm-create" |
| Beads unavailable | Progress section shows "N/A" |
