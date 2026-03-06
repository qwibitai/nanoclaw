# Andy CLAUDE.md — Progressive Disclosure & Compression

Applies when editing `groups/main/CLAUDE.md` or Andy's docs.

For repository root `CLAUDE.md`, follow `.claude/rules/nanoclaw-root-claude-compression.md` instead.

## Gate: What Stays in CLAUDE.md

Only if ALL three are true:

- Needed in ≥80% of conversations (core identity, formatting, communication)
- Silent failure without it (Andy sends wrong output or fails)
- Fits in ≤3 lines OR cannot be split (e.g. formatting rules)

Everything else → `groups/main/docs/{topic}.md` + one-line trigger in Docs Index.

## Gate: What Goes in docs/

- Procedures and step-by-step workflows
- Reference data (auth patterns, config formats, field descriptions)
- Lists longer than 5 items
- Content needed only sometimes (not every conversation)

## Compression Trigger

When `groups/main/CLAUDE.md` grows beyond ~80 lines:

1. Identify the block that's reference (not always-needed)
2. Extract to `groups/main/docs/{topic}.md`
3. Add one imperative trigger line to the Docs Index in CLAUDE.md
4. Delete the block from CLAUDE.md

## Docs Index Trigger Format

Triggers must be imperative — Andy reads the doc BEFORE acting, not after failing:

```text
BEFORE any <action> → read /workspace/group/docs/<topic>.md
<keyword> / <keyword> / <keyword> → read /workspace/group/docs/<topic>.md
```

## Adding a New Doc

When a new repeated workflow appears in a session:

1. Create `groups/main/docs/{topic}.md` with the full procedure
2. Add one trigger line to the Docs Index in CLAUDE.md in the same session
3. Do not leave the workflow inline in CLAUDE.md
