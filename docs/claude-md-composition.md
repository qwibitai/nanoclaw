# CLAUDE.md Composition

NanoClaw v2 regenerates each agent group's `CLAUDE.md` when a session starts.
The generated file is an import-only entry point; do not put durable rules in
it by hand.

## Inputs

- `container/CLAUDE.md` - shared base instructions mounted in the container as
  `/app/CLAUDE.md`.
- `container/skills/<name>/instructions.md` - optional skill fragments for the
  skills enabled in `groups/<folder>/container.json`.
- `container/agent-runner/src/mcp-tools/*.instructions.md` - built-in MCP tool
  guidance.
- Inline MCP instructions in `container.json`.
- `groups/<folder>/CLAUDE.local.md` - per-agent durable rules and persona.
- `groups/<folder>/STANDING_FACTS.md` - curated durable facts.
- `groups/<folder>/OPEN_TASKS.md` - the current active plan.

## Generated Files

At spawn time, `src/claude-md-compose.ts` writes:

- `groups/<folder>/CLAUDE.md`
- `groups/<folder>/.claude-shared.md`
- `groups/<folder>/.claude-fragments/*`

These files are runtime artifacts and should stay out of git. Edit
`CLAUDE.local.md`, `STANDING_FACTS.md`, or `OPEN_TASKS.md` instead.

## Memory Rule

Only the three hot memory files are imported automatically:

- `CLAUDE.local.md`
- `STANDING_FACTS.md`
- `OPEN_TASKS.md`

Journals, archives, generated transcripts, and conversation dumps are searched
only when a task explicitly needs history. They are not imported at startup.
