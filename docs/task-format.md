# Better Copilot Task Format

## Overview

All tasks are stored in dtasks list **#3 "Trabajo"**. No other list is used.

Metadata (project, priority, type) is encoded in the `notes` field using YAML frontmatter, followed by the task content.

## Format

```
---
project: <project-name>
priority: <low|medium|high>
type: <action|event|email|reminder|call|meeting>
---
<actual task notes/content>
```

All three frontmatter fields are optional. If a field is omitted, the panel uses defaults (`priority: medium`, `type: action`).

## Example

```
---
project: ASC
priority: high
type: action
---
Estoy haciendo un test
```

## When Creating a Task

Always target list `3`. Format the `--notes` value as YAML frontmatter + content:

```bash
dtasks add 'Reunión ASC' \
  --list 3 \
  --notes $'---\nproject: ASC\npriority: high\ntype: action\n---\nPreparar presentación' \
  --due-date '2026-03-03' \
  --due-time '12:00'
```

Note: use `$'...'` quoting in bash to interpret `\n` as newlines. Alternatively, pass a multi-line string.

## When Reading Tasks

- Strip the YAML frontmatter block before displaying content to the user.
- Parse `project`, `priority`, and `type` from the frontmatter to understand context.

The panel's `parseTaskNotes` utility (`panel/lib/task-metadata.ts`) handles this automatically.

## Field Reference

| Field      | Values                                          | Default   |
|------------|-------------------------------------------------|-----------|
| `project`  | Free string (e.g., `ASC`, `Mossos WS`)         | list name |
| `priority` | `low` / `medium` / `high`                      | `medium`  |
| `type`     | `action` / `event` / `email` / `reminder` / `call` / `meeting` | `action` |
