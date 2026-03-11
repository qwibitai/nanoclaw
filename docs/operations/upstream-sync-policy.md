# Upstream Sync Policy

This policy defines how to sync from `upstream/main` while preserving local branch behavior.

Remote boundary for this repo:

- `origin` = `https://github.com/ingpoc/nanoclaw.git` and is the only allowed push/PR target.
- `upstream` = `https://github.com/qwibitai/nanoclaw.git` and is fetch-only.
- Never push to `upstream`.

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

1. Rewrite `docs/CHANGELOG.md` so it contains only the newest sync entry.
2. Rely on git history for older sync records.
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

## Fork Auth and Sync Workflow

Use this when Andy analysis must read or push to `openclaw-gurusharan/nanoclaw` `main`.

Do not reinterpret this section as permission to push to `upstream`. The `upstream` remote remains read-only in this repo.

1. Verify remote mapping and normalize alias names.
   - `git remote -v`
   - Expected:
     - `origin` -> `https://github.com/ingpoc/nanoclaw.git`
     - `nanoclaw` -> `https://github.com/openclaw-gurusharan/nanoclaw.git`
     - `upstream` -> `https://github.com/qwibitai/nanoclaw`
   - If an old alias exists, rename once:
     - `git remote rename openclaw nanoclaw`
2. Verify the active GitHub CLI account before pushing.
   - `gh auth status -h github.com`
   - `gh auth switch -h github.com -u openclaw-gurusharan`
   - If tokens are invalid:
     - `gh auth login -h github.com --git-protocol https --web`
     - `gh auth switch -h github.com -u openclaw-gurusharan`
   - In Codex/harness sessions, request escalated execution directly for `gh` and remote git commands instead of probing the sandbox first. Git may still push through stored credentials while `gh` fails on isolated token/keychain state, so treat auth-sensitive GitHub operations as out-of-sandbox by default.
3. Sync code to the fork.
   - Preferred: push a branch and merge via PR into `main`
   - Emergency/admin-only: direct update to `main` only if explicitly allowed
4. Confirm `main` contains the expected commit.
   - `git ls-remote --heads nanoclaw main`
   - `git log --oneline -n 1`

Troubleshooting:

- `permission denied` on push usually means the wrong active account or missing branch permission
- if `gh auth switch` fails, re-run `gh auth status` and refresh login first
