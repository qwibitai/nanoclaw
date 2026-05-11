# NanoClaw — Agent Policy

## GitHub

- **Owner:** Kromatic-Innovation (this fork)
- **Repo:** nanoclaw
- **Upstream:** [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)

This repo is the Kromatic-Innovation fork of NanoClaw. Skill updates and
feature work originate here; selected changes flow upstream to
`qwibitai/nanoclaw` via PR.

## Branch policy

- Default branch: `main`
- Skill PRs to upstream live on `feature/<skill>` branches per the
  `contribute-to-nanoclaw` workspace skill
- Upstream sync via `sync/upstream-main` branches

## Pre-upstream-PR review gate

Before opening any PR from this fork to `qwibitai/nanoclaw`, run the
workspace `/zenodotus` skill against the change scope:

```
/zenodotus --repo . --ref <feature-branch> --version <target-version> \
  --prior-tag <upstream-base> --personas drive-by-contributor
```

The **drive-by-contributor** persona is the critical lens here: the
upstream maintainer will read your PR as a stranger. Run that persona
specifically. Add `production-evaluator` and `maintainers-maintainer` for
broader skill releases.

Zenodotus reviewers operate under **no-context isolation** — they see only
the public surface (README, CHANGELOG, CONTRIBUTING, public API, tests,
release diff) and **nothing else**. No `AGENTS.md`, no `CLAUDE.md`, no
`.claude/`, no internal docs, no commit history outside the diff window.
This mirrors what the upstream maintainer sees.

Verdict gates the PR:

- **Pass** → open the upstream PR using the drafted summary from
  `.zenodotus/<version>/tag-message.md` as the PR body.
- **Conditional** / **Fail** → fix the must-fix items on the feature
  branch, re-run `/zenodotus`, retry.

Zenodotus is **additive** to internal review, not a substitute. Workspace
PR [Kromatic-Innovation/code-workspace-config#264](https://github.com/Kromatic-Innovation/code-workspace-config/pull/264)
tracks the skill itself; issue
[Kromatic-Innovation/code-workspace-config#234](https://github.com/Kromatic-Innovation/code-workspace-config/issues/234)
captures the policy rationale.

The `.zenodotus/` directory is gitignored — verdict artifacts are local
record, not durable repo state.

## Related workspace skills

- `/zenodotus` — the no-context review gate above
- `/contribute-to-nanoclaw` — the upstream PR convention (branch shape,
  SKILL.md format, downstream-patches-local rule)

## Repo conventions

See `CLAUDE.md` for the durable architectural notes (orchestrator, channel
registry, IPC, OneCLI secrets, container layout). This file (`AGENTS.md`)
covers process policy only.
