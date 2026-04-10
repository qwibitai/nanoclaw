# Reflect - Agent Self-Improvement Skill

> "Correct once, never again."

Transform your AI assistant into a continuously improving partner. The reflect skill analyzes conversations for corrections and successful patterns, permanently encoding learnings into agent definitions.

## Features

- **Signal Detection**: Automatically identifies corrections with confidence levels (HIGH/MEDIUM/LOW)
- **Category Classification**: Routes learnings to appropriate agent files (Code Style, Architecture, Process, Domain, Tools)
- **Skill Generation**: Creates new skills from non-trivial debugging discoveries
- **Metrics Tracking**: Quantifies improvement with acceptance rates and statistics
- **Human-in-the-Loop**: All changes require explicit approval
- **Git Integration**: Full version control with easy rollback

## Installation

### Via ClawdHub CLI

```bash
clawdhub install reflect
```

### Manual Installation

Copy the `reflect/` folder to your skills directory:
- Claude Code: `~/.claude/skills/reflect/`
- Clawdbot: `~/.clawdbot/skills/reflect/`

## Usage

### Basic Reflection

Just say "reflect" or "review session" to trigger analysis:

```
User: reflect
Agent: [Analyzes conversation, presents learnings for approval]
```

### Toggle Auto-Reflection

```
User: reflect on
Agent: Auto-reflection enabled. Will analyze before context compaction.

User: reflect off
Agent: Auto-reflection disabled.
```

### Check Status

```
User: reflect status
Agent:
  Sessions analyzed: 42
  Signals detected: 156
  Changes accepted: 89 (78%)
  Skills created: 5
```

### Review Pending

```
User: reflect review
Agent: [Shows low-confidence learnings awaiting validation]
```

## How It Works

1. **Scan**: Analyzes conversation for correction signals
2. **Classify**: Maps signals to categories and target files
3. **Propose**: Generates diffs for agent updates or new skills
4. **Review**: Presents changes for user approval
5. **Apply**: Commits approved changes with descriptive messages

## Signal Detection

| Confidence | Triggers | Examples |
|------------|----------|----------|
| HIGH | Explicit corrections | "never", "always", "wrong", "stop" |
| MEDIUM | Approved approaches | "perfect", "exactly", "that's right" |
| LOW | Observations | Patterns that worked, not validated |

## Configuration

Set custom state directory:

```bash
export REFLECT_STATE_DIR=/path/to/state
```

Default locations:
- `~/.reflect/` (portable)
- `~/.claude/session/` (Claude Code)

## License

MIT

## Author

Claude Code Toolkit
