# Andy-Developer GitHub Workflow

This is mandatory for Andy-developer.

## Branch Policy

- Never commit directly to `main`.
- Use worker branches only (`jarvis-<feature>`) for product execution tasks.
- Keep `main` as review-protected integration branch.
- Merge to `main` only via pull request.
- Seed worker branches remotely before dispatch (create from approved base, then push).

## Operating Model

1. Andy-developer identifies `base_branch` (default `main`) and creates `jarvis-<feature>` branch.
2. Andy-developer pushes the seeded branch to origin.
3. Andy-developer prepares strict dispatch JSON with `base_branch` + `branch`.
4. Andy-developer sends dispatch to `jarvis-worker-*`.
5. Worker checks out the dispatched `jarvis-<feature>` branch, applies fix, and pushes updates.
6. Worker returns completion contract with test evidence and commit SHA.
7. Andy-developer reviews code and sends `approve` or `rework`.
8. If approved, Andy-developer syncs the approved branch/commit into `NanoClawWorkspace` and runs checks on that same branch/commit only.
9. Andy-developer runs local preflight (`build` + `server start/health`), verifies no duplicate same-lane running containers, and sends user testing handoff (user-run local commands).
10. If not approved and rework is large enough to warrant Jarvis, Andy-developer delegates rework to Jarvis using a new child `run_id`, the same `request_id`, and `parent_run_id` pointing at the reviewed run.

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

- Initial product source implementation by Andy-developer when the task should be worker-owned
- Large product feature/fix commits from Andy lane during review
- Any direct push to `main`

## Allowed Push Scope

- Control-plane changes (`.github/workflows`, review/branch-governance docs)
- Branch seeding pushes for worker lanes (`jarvis-*` pre-created from `base_branch`)
- Review-time bounded direct patches on the same approved worker branch when the delta is small, local, and clearly cheaper than redispatch
- Review/handoff staging operations that do not author product feature code

## Required Repo Controls

- Branch protection/ruleset on `main` must require PRs and required checks.
- Direct push to `main` must remain blocked for all automation lanes.
