# Agreement Sync (Jarvis)

Applies after `andy-developer` accepts a Jarvis workflow/policy agreement.

## Mandatory Actions

1. Update the affected workflow doc under `/workspace/group/docs/workflow/`.
2. Update `/workspace/group/CLAUDE.md` Docs Index trigger lines if retrieval paths changed.
3. Keep changes in the same branch/PR as the agreement implementation.

## Completion Evidence

Include in `<completion>`:

- list of updated workflow docs
- whether `CLAUDE.md` Docs Index changed
- short note confirming agreement-sync completed

## Failure Rule

If agreement implementation is done but docs index is not updated, task is incomplete and must be reworked.
