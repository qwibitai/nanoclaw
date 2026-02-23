# Docs Pruning Loop

Applies when adding/updating `docs/*.md` or root `CLAUDE.md`.

## Keep Docs Lean

- Prefer one canonical doc per topic.
- Remove duplicated docs that describe the same architecture from older eras.
- Replace giant mixed docs with focused docs + CLAUDE trigger lines.

## Required Sync

When docs are created, renamed, or removed:

1. Update root `CLAUDE.md` Docs Index triggers
2. Remove stale references to deleted docs
3. Keep docs names intent-specific (`*-contract.md`, `*-runtime.md`, `*-checklist.md`)

When an operating agreement is accepted (Andy/Jarvis policy/workflow changes):

1. Apply `docs/operations/agreement-sync-protocol.md`
2. Update affected root `docs/*` and `groups/*` lane docs in the same change set
3. Ensure root `CLAUDE.md` trigger lines reflect new retrieval paths

## Deletion Rule

A doc should be deleted when it is:

- superseded by a newer canonical doc
- tied to deprecated architecture behavior
- mostly duplicate content with no unique operational value

## Review Gate

Before finishing docs changes:

- `rg -n \"<deleted-or-renamed-doc>\" .` returns no stale references
- Root `CLAUDE.md` remains concise and index-like
