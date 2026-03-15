---
name: submit-idea
description: Submit improvement ideas to the dev-inbox so they become tracked work items. Use when you identify bugs, missing features, or opportunities to improve NanoClaw or other ecosystem services.
allowed-tools: Bash(submit-idea:*)
---

# Submit Idea to Dev-Inbox

Submit improvement ideas, bug reports, or feature requests as tracked work items in the dev-inbox.

## Setup

The script is at `~/.claude/skills/submit-idea/submit-idea`. Add it to PATH first:

```bash
export PATH="$HOME/.claude/skills/submit-idea:$PATH"
```

## Usage

```bash
submit-idea "description of the idea or improvement"
```

With an optional repository target:

```bash
submit-idea --repo "Jeffrey-Keyser/nanoclaw" "description of the idea or improvement"
```

## Parameters

- **description** (required): A clear, actionable description of the idea. Include context about what prompted it (e.g., an error you observed, a pattern you noticed, a user request).
- **--repo** (optional): The repository this idea applies to (e.g., `Jeffrey-Keyser/nanoclaw`). Defaults to `Jeffrey-Keyser/nanoclaw`.

## When to Use

- After observing repeated failures or errors that suggest a systemic issue
- When you identify a missing feature that would improve the user experience
- When a user explicitly requests a new capability or improvement
- When you notice patterns that suggest an architectural improvement
- When you find workarounds that should be proper fixes
- When you discover documentation gaps

## Examples

```bash
# Report a recurring issue
submit-idea "Container builds intermittently fail with stale COPY cache — add cache-busting to build.sh"

# Suggest a feature improvement
submit-idea --repo "Jeffrey-Keyser/nanoclaw" "Add retry logic to IPC message delivery when the host process is temporarily unavailable"

# Surface a user request
submit-idea "Jeff asked for a way to search conversation history by date range — add date filters to the conversations/ search"
```

## Notes

- Ideas are posted to the dev-inbox manager on the Beelink host via `DEV_INBOX_URL` (defaults to `http://host.docker.internal:3100/tasks`)
- Failed submissions are logged but do not crash your session
- Keep descriptions concise but actionable — include the "what" and "why"
