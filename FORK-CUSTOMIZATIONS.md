# Fork Customizations

> Upstream: [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
> Fork maintained by: @ashsolei
> Last reviewed: 2026-04-08
> Fork type: **light-customization**
> Sync cadence: **quarterly**

## Purpose of Fork

Tiny claw-code variant with iAiFy governance overlays only.

## Upstream Source

| Property | Value |
|---|---|
| Upstream | [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) |
| Fork org | AiFeatures |
| Fork type | light-customization |
| Sync cadence | quarterly |
| Owner | @ashsolei |

## Carried Patches

Local commits ahead of `upstream/main` at last review:

- `a53131d chore(release): add release.yml + .releaserc.json (#4)`
- `cf83723 docs: refresh README to match current repo state (#3)`
- `20384e2 docs: add AGENT-HUB-COUPLING.md and AGENT_HUB_URL env`
- `67aebde chore: sync CLAUDE.md and copilot-instructions updates`
- `a22a979 ci: add dependabot.yml for iAiFy governance`
- `6c13c72 docs: add AGENTS.md for iAiFy governance`
- `bc2081d docs: add copilot-instructions.md for iAiFy governance`

## Supported Components

- Root governance files (`.github/`, `CLAUDE.md`, `AGENTS.md`, `FORK-CUSTOMIZATIONS.md`)
- Enterprise CI/CD workflows imported from `Ai-road-4-You/enterprise-ci-cd`

## Out of Support

- All upstream source directories are tracked as upstream-of-record; local edits to core source are discouraged.

## Breaking-Change Policy

1. On upstream sync, classify per `governance/docs/fork-governance.md`.
2. Breaking API/license/security changes auto-classify as `manual-review-required`.
3. Owner triages within 5 business days; conflicts are logged to the `fork-sync-failure` issue label.
4. Revert local customizations only after stakeholder sign-off.

## Sync Strategy

This fork follows the [Fork Governance Policy](https://github.com/Ai-road-4-You/governance/blob/main/docs/fork-governance.md)
and the [Fork Upstream Merge Runbook](https://github.com/Ai-road-4-You/governance/blob/main/docs/runbooks/fork-upstream-merge.md).

- **Sync frequency**: quarterly
- **Conflict resolution**: Prefer upstream; reapply iAiFy customizations on a sync branch
- **Automation**: [`Ai-road-4-You/fork-sync`](https://github.com/Ai-road-4-You/fork-sync) workflows
- **Failure handling**: Sync failures create issues tagged `fork-sync-failure`

## Decision: Continue, Rebase, Refresh, or Replace

| Option | Current Assessment |
|---|---|
| Continue maintaining fork | yes - governance overlay only |
| Full rebase onto upstream | feasible on request |
| Fresh fork (discard local changes) | acceptable |
| Replace with upstream directly | possible |

## Maintenance

- **Owner**: @ashsolei
- **Last reviewed**: 2026-04-08
- **Reference runbook**: `ai-road-4-you/governance/docs/runbooks/fork-upstream-merge.md`
