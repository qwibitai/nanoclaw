# NanoClaw Root CLAUDE.md Compression Rule

Applies when editing repository root `CLAUDE.md`.

## Pre-Edit Gate (Must Pass)

Only keep content inline in root `CLAUDE.md` when ALL are true:

1. Needed in most sessions (high-frequency context)
2. Silent failure risk if omitted
3. Can be expressed in <=3 lines
4. Not specific to one narrow workflow

If any gate fails, move details to `docs/*.md` and keep only one trigger line in `CLAUDE.md`.

## What Stays in Root CLAUDE.md

- One-paragraph project identity/context
- Compact Docs Index trigger lines
- High-frequency command table (short)
- Stable file map

## What Moves to docs/

- Step-by-step procedures
- Long troubleshooting sequences
- Large checklists and rollout plans
- Detailed contracts/schemas
- Topic-specific architecture notes

## Required Trigger Format

```text
BEFORE <action> → read docs/<topic>.md
```

No narrative paragraphs in the Docs Index. Keep one line per trigger.

## Update Workflow (Required)

When adding/removing/reworking docs:

1. Update `docs/` file(s)
2. Update matching trigger line(s) in root `CLAUDE.md`
3. Remove duplicated procedure text from root `CLAUDE.md`
4. Ensure root `CLAUDE.md` stays under ~80 lines

## Definition of Done for CLAUDE.md Edits

- Root `CLAUDE.md` is index-like and concise
- No duplicated long procedure blocks from `docs/`
- Every new repeated workflow has a docs file + trigger line
