# Andy-Developer GitHub Workflow

This is mandatory for Andy-developer.

## Branch Policy

- Never commit directly to `main`.
- Use worker branches only (`jarvis-<feature>`).
- Keep `main` as review-protected integration branch.
- Merge to `main` only via pull request.

## Operating Model

1. Andy-developer prepares strict dispatch JSON.
2. Andy-developer sends dispatch to `jarvis-worker-*`.
3. Worker applies fix and pushes updates to `jarvis-<feature>` branch.
4. Worker returns completion contract with test evidence and commit SHA.
5. Andy-developer reviews code and sends `approve` or `rework`.
6. If approved, Andy-developer syncs the approved branch/commit into `NanoClawWorkspace` and runs checks on that same branch/commit only.
7. Andy-developer runs local preflight (`build` + `server start/health`), verifies no duplicate same-lane running containers, and sends user testing handoff (user-run local commands).
8. If not approved, Andy-developer delegates rework to Jarvis using the same `run_id`.

## Ownership Split

- `Andy-developer` owns control-plane changes:
  - `.github/workflows/*`
  - review/merge policy docs
  - dispatch/review process docs
- `jarvis-worker-*` owns product implementation changes in repository source.

## Completion Criteria

Before saying "done", include:

- `run_id`
- branch name
- confirmation that preflight/handoff was run on the same approved branch/commit under test
- tests executed + result
- local review preflight (`build` + `server start/health`) result for user testing
- duplicate-container check result (`container ls -a` snapshot or equivalent)
- risk summary
- `pr_url` or `pr_skipped_reason`

## Prohibited

- Direct product source implementation by Andy-developer
- Direct `git commit` / `git push` to product repos from Andy lane
- Any direct push to `main`

## Required Repo Controls

- Branch protection/ruleset on `main` must require PRs and required checks.
- Direct push to `main` must remain blocked for all automation lanes.
