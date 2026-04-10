---
name: swarm-inbox
description: Read and send inter-agent messages within a swarm team
user-invocable: true
---

# /swarm-inbox

Read your inbox or send messages to other team members.

## Usage

```bash
# Read your messages
/swarm-inbox

# Read with options
/swarm-inbox --last 10

# Send a message
/swarm-inbox --to <agent> --msg "message"

# Broadcast to all
/swarm-inbox --broadcast --msg "message"
```

## Arguments

| Argument | Description |
|----------|-------------|
| (none) | Read all messages in your inbox |
| `--last N` | Read only the last N messages |
| `--to <agent>` | Send message to specific agent (leader, agent-1, etc.) |
| `--msg "text"` | Message content |
| `--type <type>` | Message type (default: status) |
| `--broadcast` | Send to all team members |

## Message Types

| Type | Usage |
|------|-------|
| `task` | Assign work to an agent |
| `status` | Progress update |
| `handoff` | Pass work to another agent |
| `help` | Request assistance |
| `complete` | Task completion notification |
| `broadcast` | Message to all members |
| `shutdown` | Graceful termination request |

## Process

### Reading Inbox

When you receive `/swarm-inbox` (no send args):

1. **Detect Current Context**
   ```bash
   # Find which team and agent you are
   # This should be set in your session context
   TEAM_ID="$CURRENT_SWARM_TEAM"
   AGENT_NAME="$CURRENT_SWARM_AGENT"

   # Or detect from environment/session name
   SESSION_NAME=$(tmux display-message -p '#S' 2>/dev/null || echo "")
   if [[ "$SESSION_NAME" =~ ^swarm-([0-9]+)-(.+)$ ]]; then
     TEAM_ID="swarm-${BASH_REMATCH[1]}"
     AGENT_NAME="${BASH_REMATCH[2]}"
   fi
   ```

2. **Read Messages**
   ```bash
   source ~/.claude/utils/swarm-lib.sh

   MESSAGES=$(swarm_read_inbox "$TEAM_ID" "$AGENT_NAME" --last 20)

   if [ "$(echo "$MESSAGES" | jq 'length')" -eq 0 ]; then
     echo "No messages in inbox"
   else
     echo "=== Inbox: $AGENT_NAME ==="
     echo "$MESSAGES" | jq -r '.[] | "[\(.ts | split("T")[1] | split("+")[0])] \(.from) -> \(.type): \(.payload | tostring)"'
   fi
   ```

### Sending Messages

When you receive `/swarm-inbox --to <agent> --msg "text"`:

1. **Parse Arguments**
   ```bash
   TO_AGENT="agent-1"  # from --to
   MESSAGE="Task complete, ready for review"  # from --msg
   MSG_TYPE="${TYPE:-status}"  # from --type or default
   ```

2. **Construct Payload**
   ```bash
   # For simple text messages
   PAYLOAD=$(jq -n --arg msg "$MESSAGE" '{message: $msg}')

   # For task assignments (if type is task)
   # PAYLOAD='{"task_id": "bd-123", "action": "start", "context": "..."}'
   ```

3. **Send Message**
   ```bash
   swarm_send_message "$TEAM_ID" "$AGENT_NAME" "$TO_AGENT" "$MSG_TYPE" "$PAYLOAD"
   echo "Message sent to $TO_AGENT"
   ```

### Broadcasting

When you receive `/swarm-inbox --broadcast --msg "text"`:

```bash
PAYLOAD=$(jq -n --arg msg "$MESSAGE" '{message: $msg}')
swarm_broadcast "$TEAM_ID" "$AGENT_NAME" "broadcast" "$PAYLOAD"
echo "Broadcast sent to all team members"
```

## Example Output

### Reading Inbox
```
=== Inbox: agent-1 ===
[11:30:15] leader -> task: {"task_id":"bd-007","action":"start"}
[11:45:22] agent-2 -> handoff: {"task_id":"bd-007","context":"Backend complete"}
[11:50:00] leader -> status: {"message":"Keep up the good work!"}
```

### Sending Messages
```bash
# Simple progress update
/swarm-inbox --to leader --msg "Task bd-007 at 50% progress"

# Request help
/swarm-inbox --to leader --type help --msg "Blocked on API auth issue"

# Task handoff
/swarm-inbox --to agent-2 --type handoff --msg '{"task_id":"bd-007","context":"Frontend ready for integration"}'

# Broadcast announcement
/swarm-inbox --broadcast --msg "Taking 5 min break, will resume shortly"
```

## Message Format

Messages are stored as JSONL (one JSON object per line):

```json
{
  "ts": "2026-02-03T11:30:15+00:00",
  "from": "leader",
  "to": "agent-1",
  "type": "task",
  "payload": {
    "task_id": "bd-007",
    "action": "start",
    "context": "Implement user authentication endpoint"
  }
}
```

## Polling Workflow

Agents should poll their inbox regularly:

```bash
# Poll loop (conceptual - implement in agent behavior)
while true; do
  NEW_MESSAGES=$(swarm_read_inbox "$TEAM_ID" "$AGENT_NAME" --last 5)

  for msg in $(echo "$NEW_MESSAGES" | jq -c '.[]'); do
    TYPE=$(echo "$msg" | jq -r '.type')
    case $TYPE in
      task)
        # Handle task assignment
        ;;
      shutdown)
        # Graceful shutdown
        ;;
      *)
        # Log other messages
        ;;
    esac
  done

  sleep 5
done
```

## Files

| File | Description |
|------|-------------|
| `~/.claude/swarm/{team-id}/inbox/leader.jsonl` | Leader's inbox |
| `~/.claude/swarm/{team-id}/inbox/agent-1.jsonl` | Agent 1's inbox |
| `~/.claude/swarm/{team-id}/inbox/agent-N.jsonl` | Agent N's inbox |
