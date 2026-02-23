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
3. Worker creates/updates `jarvis-<feature>` branch.
4. Worker returns completion contract with test evidence.
5. Andy-developer reviews and sends approve/rework.

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
- tests executed + result
- risk summary
- `pr_url` or `pr_skipped_reason`

## Prohibited

- Direct product source implementation by Andy-developer
- Direct `git commit` / `git push` to product repos from Andy lane
- Any direct push to `main`

## Required Repo Controls

- Branch protection/ruleset on `main` must require PRs and required checks.
- Direct push to `main` must remain blocked for all automation lanes.
