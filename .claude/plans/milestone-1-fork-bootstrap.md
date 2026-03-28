# Milestone 1: LearnClaw Fork Bootstrap
**Created**: 28 March 2026 | **Target**: 28 March 2026 | **Project**: LearnClaw

## Objective
Establish LearnClaw as a working fork of NanoClaw with GitHub ownership, synced upstream history, and a local milestone branch ready for product changes.

## Acceptance Criteria
1. A GitHub repository exists at `iabheejit/learnclaw` and remains linked to `qwibitai/nanoclaw` as its fork source.
2. The local workspace at `/Users/Shared/Scripts/LearnClaw` is a git repository with `origin` pointing to `iabheejit/learnclaw` and `upstream` pointing to `qwibitai/nanoclaw`.
3. Local `main` tracks `origin/main`, and a working branch named `milestone/1-fork-bootstrap` exists for ongoing LearnClaw changes.
4. Mr Fox operating files record the bootstrap work and current project state.

## Approach
Use the existing authenticated GitHub account to sync the stale personal fork with upstream, rename the fork to LearnClaw, then initialize the current workspace in place so the pre-existing `.claude` operating files are preserved. Avoid any content rebrand or code edits at this stage.

## Files Affected
- `.claude/milestones.md`
- `.claude/session-log.md`
- `.claude/versions.md`
- `.claude/plans/milestone-1-fork-bootstrap.md`
- Git remotes and branch metadata in `.git/`

## Tests Required
- Confirm `iabheejit/learnclaw` exists and is still a fork of `qwibitai/nanoclaw`.
- Confirm local remotes are set correctly.
- Confirm current branch is `milestone/1-fork-bootstrap`.
- Confirm workspace status reflects the Mr Fox tracking files.

## Out of Scope
- Renaming application code, package names, or product copy from NanoClaw to LearnClaw.
- Installing project dependencies or running the application.
- Completing milestone audits.

## Dependencies
- GitHub CLI authenticated to the target account.
- Network access to GitHub.

## Fundability / Demo Value
This creates an owned, updatable base repository so future LearnClaw work can move quickly without losing upstream lineage or session continuity.
