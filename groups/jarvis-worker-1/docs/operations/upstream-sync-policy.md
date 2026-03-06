# Upstream Sync Policy

This policy defines how to sync from `upstream/main` while preserving local branch behavior.

## Required Cadence

- Perform a daily pull/fetch from `upstream/main` (nanoclaw mainline).

## Merge And Conflict Resolution

- Use upstream bug-fix behavior as first preference during conflict resolution.
- Retain required local functionality by applying only minimal compatibility changes after upstream-first resolution.
- Do not silently drop local branch behavior/integrations.
- If safe retention is unclear or conflicts are non-trivial, stop and request a manual decision.

## Validation Before Finalizing Sync

Run at minimum:

- `npm run typecheck`
- Targeted tests for locally customized flows affected by the sync

## Changelog Requirement

After each daily sync:

1. Archive the current `docs/CHANGELOG.md` to `docs/archives/` using a date-stamped name:
   - `docs/archives/CHANGELOG-YYYY-MM-DD.md`
2. Rewrite `docs/CHANGELOG.md` so it contains only the newest sync entry.
3. The new latest entry must include:

- Date
- Synced source/target branch
- `Bug Fixes`
- `Features`
- `Functionality/Behavior`
- `Docs/Infra`
- Conflict notes and local compatibility decisions

## Authority

- `CLAUDE.md` keeps only trigger/reference lines.
- This file contains the full sync policy details.
