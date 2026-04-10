---
name: swarm-shutdown
description: Gracefully shutdown a swarm team
user-invocable: true
---

# /swarm-shutdown

Gracefully shutdown a swarm team with optional force flag.

## Usage

```bash
/swarm-shutdown <team-id> [--force]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<team-id>` | Yes | The swarm team ID to shutdown |
| `--force` | No | Skip graceful shutdown, kill immediately |

## Process

When you receive this command:

### Graceful Shutdown (Default)

1. **Broadcast Shutdown Message**
   ```bash
   source ~/.claude/utils/swarm-lib.sh

   echo "Initiating graceful shutdown of $TEAM_ID..."

   # Notify all agents
   swarm_broadcast "$TEAM_ID" "system" "shutdown" \
     '{"reason": "graceful shutdown requested", "checkpoint": true}'

   echo "Shutdown message broadcast to all agents"
   ```

2. **Wait for Checkpoint**
   ```bash
   echo "Waiting 10 seconds for agents to checkpoint..."
   sleep 10
   ```

3. **Verify Agent Status**
   ```bash
   # Check if agents have acknowledged
   TEAM_DIR="~/.claude/swarm/$TEAM_ID"

   for inbox in "$TEAM_DIR"/inbox/*.jsonl; do
     AGENT=$(basename "$inbox" .jsonl)
     LAST_MSG=$(tail -1 "$inbox" 2>/dev/null | jq -r '.type' || echo "")

     if [ "$LAST_MSG" = "checkpoint" ]; then
       echo "  + $AGENT checkpointed"
     else
       echo "  o $AGENT (no checkpoint confirmation)"
     fi
   done
   ```

4. **Kill tmux Sessions**
   ```bash
   TEAM_JSON=$(cat "$TEAM_DIR/team.json")

   # Kill leader
   LEADER_SESSION=$(echo "$TEAM_JSON" | jq -r '.leader.session')
   if tmux has-session -t "$LEADER_SESSION" 2>/dev/null; then
     tmux kill-session -t "$LEADER_SESSION"
     echo "  + Killed leader: $LEADER_SESSION"
   fi

   # Kill agents
   for session in $(echo "$TEAM_JSON" | jq -r '.members[].session'); do
     if tmux has-session -t "$session" 2>/dev/null; then
       tmux kill-session -t "$session"
       echo "  + Killed agent: $session"
     fi
   done
   ```

5. **Update Team State**
   ```bash
   swarm_update_team "$TEAM_ID" '{"status": "shutdown", "shutdown_at": "'"$(date -Iseconds)"'"}'
   ```

6. **Report**
   ```bash
   echo ""
   echo "========================================"
   echo "  Swarm Shutdown Complete: $TEAM_ID"
   echo "========================================"
   echo ""
   echo "  Team data preserved at:"
   echo "    $TEAM_DIR/"
   echo ""
   echo "  To archive: /swarm-archive $TEAM_ID"
   echo "  To restart: /swarm-create with same epic"
   echo ""
   ```

### Force Shutdown (--force)

Skip the graceful steps and kill immediately:

```bash
echo "Force shutdown of $TEAM_ID..."

# Kill all sessions without waiting
swarm_shutdown "$TEAM_ID" --force

echo "Force shutdown complete"
```

## Output

### Graceful Shutdown
```
================================================================
  SWARM SHUTDOWN: swarm-1738585396
================================================================

Phase 1: Broadcasting shutdown...
  -> Sent to leader
  -> Sent to agent-1
  -> Sent to agent-2
  -> Sent to agent-3

Phase 2: Waiting for checkpoints (10s)...
  ==================== 100%

Phase 3: Verifying checkpoints...
  + leader: checkpointed
  + agent-1: checkpointed
  + agent-2: checkpointed
  o agent-3: no response (will force kill)

Phase 4: Terminating sessions...
  + Killed: swarm-1738585396-leader
  + Killed: swarm-1738585396-agent-1
  + Killed: swarm-1738585396-agent-2
  + Killed: swarm-1738585396-agent-3

Phase 5: Updating team state...
  + Status set to: shutdown

================================================================
  SHUTDOWN COMPLETE
================================================================

  Team data preserved at: ~/.claude/swarm/swarm-1738585396/

  Options:
    Archive team:    swarm-lib.sh archive swarm-1738585396
    View final state: cat ~/.claude/swarm/swarm-1738585396/team.json
    Restart:         /swarm-create --epic bd-epic-123

================================================================
```

### Force Shutdown
```
================================================================
  FORCE SHUTDOWN: swarm-1738585396
================================================================

Killing sessions immediately...
  + Killed: swarm-1738585396-leader
  + Killed: swarm-1738585396-agent-1
  + Killed: swarm-1738585396-agent-2

Status updated to: shutdown

================================================================
```

## Agent Checkpoint Protocol

When agents receive a shutdown message, they should:

1. **Complete or Pause Current Work**
   - If close to completion: finish the task
   - Otherwise: save progress state

2. **Update Beads**
   ```bash
   # Mark task as paused/blocked
   bd update $CURRENT_TASK --status blocked --reason "Swarm shutdown"
   ```

3. **Send Checkpoint Confirmation**
   ```bash
   swarm_send_message "$TEAM_ID" "$AGENT_NAME" "system" "checkpoint" \
     '{"task": "'"$CURRENT_TASK"'", "progress": 75, "state": "saved"}'
   ```

4. **Clean Up**
   - Close any open files
   - Save session notes to shared/

## Post-Shutdown Options

### Archive Team
```bash
# Move team to .archive/ directory
swarm-lib.sh archive swarm-1738585396
```

### Delete Team
```bash
# Permanently remove team data
rm -rf ~/.claude/swarm/swarm-1738585396
```

### Restart Team
```bash
# Create new swarm from same epic
/swarm-create --epic bd-epic-platform-rebuild --agents 3
```

## Error Handling

| Error | Resolution |
|-------|------------|
| Team not found | Verify team ID exists |
| Sessions already dead | Proceeds with state update only |
| Permission denied | Check tmux socket permissions |
| Checkpoint timeout | Force flag used automatically after timeout |
