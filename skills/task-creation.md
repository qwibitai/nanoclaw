# Task Creation in Better Copilot

All tasks go to dtasks list **#3 "Trabajo"**. Never use other lists.

Metadata (project, priority, type) is stored as YAML frontmatter in the notes field.
See full format spec: `docs/task-format.md`.

## Task Format

```
---
project: <project-name>
priority: <low|medium|high>
type: <action|event|email|reminder|call|meeting>
---
<task notes/content>
```

## Creating Tasks

### Semantic (natural language)

When the user asks naturally to remember or create a task, extract the intent and build the dtasks command.

User: "Recuérdame llamar a María sobre el proyecto ASC"

Steps:
1. Extract: title="Llamar a María", project="ASC", type="action", priority="medium" (default), notes="Sobre el proyecto ASC"
2. Run:
```bash
dtasks add 'Llamar a María' --list 3 \
  --notes $'---\nproject: ASC\npriority: medium\ntype: action\n---\nSobre el proyecto ASC'
```

### Command syntax: `/crear-tarea`

```
/crear-tarea <title> [@priority] [#type] [notes]
```

Parsing rules:
- `@high`, `@medium`, `@low` → priority field
- `#action`, `#event`, `#email`, `#reminder`, `#call`, `#meeting` → type field
- Project: extract from title keywords or @-tags if present, else leave blank
- Remaining text after flags → notes

Example:
```
/crear-tarea Reunión ASC @high #event Discutir timeline del Q2
```

Parsed as:
- title: "Reunión ASC"
- priority: high
- type: event
- notes: "Discutir timeline del Q2"
- project: "ASC" (inferred from title)

Resulting command:
```bash
dtasks add 'Reunión ASC' --list 3 \
  --notes $'---\nproject: ASC\npriority: high\ntype: event\n---\nDiscutir timeline del Q2'
```

## Examples

### Example 1: Action task

User: `/crear-tarea Enviar presupuesto a cliente @medium #action Incluir desglose de horas`

```bash
dtasks add 'Enviar presupuesto a cliente' --list 3 \
  --notes $'---\npriority: medium\ntype: action\n---\nIncluir desglose de horas'
```

### Example 2: Semantic with date

User: "Necesito llamar a María el viernes sobre ASC"

Steps:
1. Run `TZ=Europe/Madrid date '+%A %d de %B de %Y'` to get current date
2. Calculate next Friday's date
3. Extract: title="Llamar a María", project="ASC", type="event" (it's a call/meeting)

```bash
dtasks add 'Llamar a María' --list 3 \
  --due-date '2026-03-07' \
  --notes $'---\nproject: ASC\npriority: medium\ntype: event\n---\nSobre ASC'
```

### Example 3: With due date and time

```bash
dtasks add 'Reunión kick-off Mossos' --list 3 \
  --due-date '2026-03-10' \
  --due-time '10:00' \
  --notes $'---\nproject: Mossos WS\npriority: high\ntype: meeting\n---\nPreparar demo de integración'
```

## Fields Reference

| Field       | Values                                                        | Default    |
|-------------|---------------------------------------------------------------|------------|
| `project`   | Free string (ASC, Mossos WS, Infraestructura, Personal, ...)  | list name  |
| `priority`  | `low` / `medium` / `high`                                     | `medium`   |
| `type`      | `action` / `event` / `email` / `reminder` / `call` / `meeting` | `action` |
| `--due-date` | `YYYY-MM-DD` format                                          | none       |
| `--due-time` | `HH:MM` format (requires `--due-date`)                       | none       |

## Reading Tasks Back

When displaying tasks to the user, strip the YAML frontmatter — show only the content after `---`.
Extract project/priority/type from metadata to provide context.

```bash
# List all tasks in Trabajo list
dtasks ls --list 3 --json
```

## Important Rules

- ALWAYS use list `--list 3` (never other list IDs)
- ALWAYS run `date` before calculating relative dates (see global/CLAUDE.md)
- Use `$'---\n...'` quoting in bash to interpret `\n` as actual newlines
- Metadata frontmatter is optional per field but highly recommended for project tracking
