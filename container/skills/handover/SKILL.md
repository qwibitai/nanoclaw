---
name: handover
description: Generate a handover document for transferring work to another developer or spawning an async agent
user-invocable: true
---

# /handover - Generate Session Handover Document

Generate a handover document for transferring work to another developer or spawning an async agent.

## Usage

```bash
/handover                              # Standard handover
/handover "notes about current work"   # With notes
/handover --agent-spawn "task desc"    # For spawning agent
```

## Modes

### Standard Handover (default)

For transferring work to another human or resuming later:
- Current session health
- Task progress and todos
- Technical context
- Resumption instructions

### Agent Spawn Mode (`--agent-spawn`)

For passing context to spawned agents:
- Focused on task context
- Technical stack details
- Success criteria
- Files to modify

## Implementation

### Detect Mode

```bash
MODE="standard"
AGENT_TASK=""
NOTES="${1:-}"

if [[ "$1" == "--agent-spawn" ]]; then
    MODE="agent"
    AGENT_TASK="${2:-}"
    shift 2
fi
```

### Generate Timestamp

```bash
TIMESTAMP=$(date +"%Y-%m-%d-%H-%M-%S")
DISPLAY_TIME=$(date +"%Y-%m-%d %H:%M:%S")
FILENAME="handover-${TIMESTAMP}.md"
PRIMARY_LOCATION=".claude/session/${FILENAME}"
BACKUP_LOCATION="./${FILENAME}"

mkdir -p ".claude/session"
```

### Standard Handover Content

```markdown
# Handover Document

**Generated**: ${DISPLAY_TIME}
**Session**: $(tmux display-message -p '#S' 2>/dev/null || echo 'unknown')

## Current Work

[Describe what you're working on]

## Task Progress

[List todos and completion status]

## Technical Context

**Current Branch**: $(git branch --show-current)
**Last Commit**: $(git log -1 --oneline)
**Modified Files**:
$(git status --short)

## Resumption Instructions

1. Review changes: git diff
2. Continue work on [specific task]
3. Test with: [test command]

## Notes

${NOTES}
```

### Agent Spawn Handover Content

```markdown
# Agent Handover - ${AGENT_TASK}

**Generated**: ${DISPLAY_TIME}
**Parent Session**: $(tmux display-message -p '#S' 2>/dev/null || echo 'unknown')
**Agent Task**: ${AGENT_TASK}

## Context Summary

**Current Work**: [What's in progress]
**Current Branch**: $(git branch --show-current)
**Last Commit**: $(git log -1 --oneline)

## Task Details

**Agent Mission**: ${AGENT_TASK}

**Requirements**:
- [List specific requirements]
- [What needs to be done]

**Success Criteria**:
- [How to know when done]

## Technical Context

**Stack**: [Technology stack]
**Key Files**:
$(git status --short)

**Modified Recently**:
$(git log --name-only -5 --oneline)

## Instructions for Agent

1. Review current implementation
2. Make specified changes
3. Add/update tests
4. Verify all tests pass
5. Commit with clear message

## References

**Documentation**: [Links to relevant docs]
**Related Work**: [Related PRs/issues]
```

### Save Document

```bash
# Generate appropriate content based on MODE
if [ "$MODE" = "agent" ]; then
    # Generate agent handover content
    CONTENT="[Agent handover content from above]"
else
    # Generate standard handover content
    CONTENT="[Standard handover content from above]"
fi

# Save to primary location
echo "$CONTENT" > "$PRIMARY_LOCATION"

# Save backup
echo "$CONTENT" > "$BACKUP_LOCATION"

echo "✅ Handover document generated"
echo ""
echo "Primary: $PRIMARY_LOCATION"
echo "Backup: $BACKUP_LOCATION"
echo ""
```

## Output Location

**Primary**: `.claude/session/handover-{timestamp}.md`
**Backup**: `./handover-{timestamp}.md`

## Integration with spawn-agent

The `/spawn-agent` command automatically calls `/handover --agent-spawn` when `--with-handover` flag is used:

```bash
/spawn-agent codex "refactor auth" --with-handover
# Internally calls: /handover --agent-spawn "refactor auth"
# Copies handover to agent worktree as .agent-handover.md
```

## Notes

- Always uses programmatic timestamps (never manual)
- Saves to both primary and backup locations
- Agent mode focuses on task context, not session health
- Standard mode includes full session state
