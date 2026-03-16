---
name: feedback
description: File bug reports or feature requests to the Feedback Registry via IPC. Use when you encounter bugs or have improvement ideas to report.
allowed-tools: Bash(feedback:*)
---

# Submit Feedback via IPC

File bug reports or feature requests to the Feedback Registry at api.feedback.jeffreykeyser.net.

## Setup

The script is at `~/.claude/skills/feedback/feedback`. Add it to PATH first:

```bash
export PATH="$HOME/.claude/skills/feedback:$PATH"
```

## Usage

```bash
feedback --type bug --title "Short summary" --description "Detailed description of the issue"
feedback --type feature --title "Short summary" --description "What the feature should do" --email "user@example.com"
```

## Parameters

- **--type** (required): Either `bug` or `feature`.
- **--title** (required): A short summary of the bug or feature request.
- **--description** (required): A detailed description with context.
- **--email** (optional): Contact email for follow-up.

## When to Use

- When you encounter a bug or error that should be reported upstream
- When a user requests a feature or improvement
- When you identify missing functionality worth tracking
- When you notice patterns that suggest a systemic issue

## Examples

```bash
# Report a bug
feedback --type bug --title "IPC messages dropped under load" --description "When more than 10 IPC messages queue simultaneously, some are silently dropped. Observed in the task scheduler during burst scheduling."

# Request a feature
feedback --type feature --title "Add retry logic to scheduled tasks" --description "Scheduled tasks that fail should automatically retry with exponential backoff instead of being marked as failed permanently."

# With contact email
feedback --type feature --title "Date range search" --description "Users need to search conversation history by date range" --email "jeff@example.com"
```

## Notes

- Feedback is submitted to the Feedback Registry via the host IPC mechanism
- The `source` field is automatically set to `nanoclaw`
- Failed submissions are logged but do not crash your session
- Keep titles concise and descriptions actionable
