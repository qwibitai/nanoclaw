---
name: swarm-join
description: Join an existing swarm team as a worker agent
user-invocable: true
---

# /swarm-join

Join an existing swarm team as a worker agent.

## Usage

```bash
/swarm-join <team-id> --as <agent-name>
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<team-id>` | Yes | The swarm team ID to join (e.g., `swarm-1738585396`) |
| `--as` | Yes | Agent name to use (e.g., `agent-3`) |

## Process

When you receive this command:

1. **Parse Arguments**
   ```bash
   TEAM_ID="$1"        # First positional argument
   AGENT_NAME="$2"     # Value after --as
   ```

2. **Validate Team Exists**
   ```bash
   source ~/.claude/utils/swarm-lib.sh

   if ! swarm_get_team "$TEAM_ID" > /dev/null 2>&1; then
     echo "Error: Team $TEAM_ID not found"
     echo "Available teams:"
     swarm_list_teams
     exit 1
   fi
   ```

3. **Check Capacity**
   ```bash
   TEAM_JSON=$(swarm_get_team "$TEAM_ID")
   MAX_MEMBERS=$(echo "$TEAM_JSON" | jq -r '.config.max_members')
   CURRENT_COUNT=$(echo "$TEAM_JSON" | jq -r '.members | length')

   if [ "$CURRENT_COUNT" -ge "$MAX_MEMBERS" ]; then
     echo "Error: Team at max capacity ($MAX_MEMBERS members)"
     exit 1
   fi
   ```

4. **Check Name Availability**
   ```bash
   if echo "$TEAM_JSON" | jq -e ".members[] | select(.name == \"$AGENT_NAME\")" > /dev/null; then
     echo "Error: Agent name '$AGENT_NAME' already in use"
     exit 1
   fi
   ```

5. **Spawn Agent**
   ```bash
   AGENT_SESSION=$(swarm_spawn_agent "$TEAM_ID" "$AGENT_NAME")
   echo "Joined team as: $AGENT_NAME"
   echo "Session: $AGENT_SESSION"
   ```

6. **Notify Leader**
   ```bash
   swarm_send_message "$TEAM_ID" "$AGENT_NAME" "leader" "status" \
     '{"event": "joined", "message": "Agent '"$AGENT_NAME"' joined the team"}'
   ```

7. **Report**
   ```bash
   echo ""
   echo "========================================"
   echo "Joined Swarm: $TEAM_ID"
   echo "========================================"
   echo "Agent Name: $AGENT_NAME"
   echo "Session: $AGENT_SESSION"
   echo ""
   echo "Your inbox: ~/.claude/swarm/$TEAM_ID/inbox/$AGENT_NAME.jsonl"
   echo ""
   echo "Commands:"
   echo "  Check inbox:    /swarm-inbox"
   echo "  Send to leader: /swarm-inbox --to leader --msg \"message\""
   echo "  Team status:    /swarm-status $TEAM_ID"
   echo "========================================"
   ```

## Example

```bash
# Join an existing team as agent-3
/swarm-join swarm-1738585396 --as agent-3

# List available teams first
~/.claude/utils/swarm-lib.sh list-teams
```

## Post-Join Behavior

After joining, the agent should:

1. **Poll Inbox** - Check for task assignments every 5 seconds
2. **Report Ready** - Notify leader you're available for work
3. **Wait for Assignment** - Leader will send task via inbox

## Agent Responsibilities

As a team member, you must:

1. **Monitor Your Inbox**
   ```bash
   # Your inbox location
   ~/.claude/swarm/{team-id}/inbox/{agent-name}.jsonl
   ```

2. **Execute Assigned Tasks**
   - Tasks arrive as inbox messages with type `task`
   - Claim in Beads: `bd update <task-id> --assignee <agent-name> --status in_progress`

3. **Report Progress**
   - Send status updates to leader at key milestones
   - Use `/swarm-inbox --to leader --msg "..."` or library function

4. **Handle Completion**
   - Close task in Beads: `bd close <task-id> --reason "Done"`
   - Notify leader of completion
   - Wait for next assignment

## Error Handling

| Error | Resolution |
|-------|------------|
| Team not found | Check team ID with `swarm_list_teams` |
| At max capacity | Wait for a slot or increase max_members in team.json |
| Name already used | Choose a different agent name |
| Session conflict | An agent with this name may still be running |
