# Capability installer model

This file keeps the old `skills-as-branches.md` path for existing links, but the
model has changed. NanoClaw no longer treats every add-on as a dedicated
`skill/*` branch, and channel-specific forks are not the intended maintenance
model.

## Current model

NanoClaw keeps the base checkout small. Installer skills add only the capability
the user asks for.

| Source | Purpose |
|---|---|
| `main` | Core runtime, registries, setup flow, operational skills, and installer skill definitions. |
| `channels` | Long-lived branch that stores channel adapter modules and channel setup helpers. |
| `providers` | Long-lived branch that stores non-default agent provider modules. |
| `skill/*` | Remaining branch-based capabilities when a normal branch merge is still the right shape. |

## Installer skills are not runtime providers

Host-side installer skills live under `.claude/skills/` and are run by Claude
Code in the user's checkout. They modify the repository: copy files, append
self-registration imports, install dependencies, rebuild images, or merge a
capability branch.

The runtime provider is separate. After installation, an agent group can run on
Claude, Codex, OpenCode, or another installed provider through the
agent-runner's provider interface. Installing `/add-codex` or `/add-opencode`
uses Claude Code as the repo-modification harness, but the resulting agent can
run on Codex or OpenCode.

## Channel installer skills

Channel skills such as `/add-discord`, `/add-telegram`, `/add-slack`, and
`/add-whatsapp` copy the relevant module from the `channels` branch into the
user's checkout. They then wire the adapter barrel, install pinned dependencies,
and hand the user back to `/manage-channels` or setup.

Typical shape:

```bash
git fetch origin channels
git show origin/channels:src/channels/<channel>.ts > src/channels/<channel>.ts
# append import './<channel>.js'; to src/channels/index.ts
# install pinned channel dependency
pnpm run build
```

## Provider installer skills

Provider skills such as `/add-codex` and `/add-opencode` copy host-side and
container-side provider modules from the `providers` branch. They wire both
provider barrels, install pinned runtime dependencies or CLIs, and rebuild the
agent image.

Typical shape:

```bash
git fetch origin providers
git show origin/providers:src/providers/<provider>.ts > src/providers/<provider>.ts
git show origin/providers:container/agent-runner/src/providers/<provider>.ts > container/agent-runner/src/providers/<provider>.ts
# append provider imports to both barrels
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

These snippets match the current installer skills, which expect `origin` to
contain NanoClaw's long-lived branches. In a forked checkout, use the remote that
points to `qwibitai/nanoclaw` if the fork does not have those branches.

## Branch-based capability skills

Some non-channel capabilities still use `skill/*` branches. In that case the
installer skill can still fetch and merge the branch:

```bash
git fetch upstream skill/<name>
git merge upstream/skill/<name>
```

Use this only when a capability is naturally represented as a coordinated branch
of changes. Do not create channel-specific `skill/*` branches for normal channel
adapters; use the `channels` branch. Do not create provider-specific `skill/*`
branches for normal providers; use the `providers` branch.

## Updating installed capabilities

Installer skills should be idempotent. Re-running a channel or provider
installer should:

1. Check whether the expected files/imports/dependencies already exist.
2. Copy or update only the owned files from `channels` or `providers`.
3. Preserve user-owned configuration.
4. Validate with the smallest relevant build or typecheck.

For branch-based `skill/*` capabilities, `/update-skills` can still detect and
merge updates using git history.

## Legacy material

Earlier design notes described a plugin marketplace and many channel-specific
`skill/*` branches. That model is not the source of truth for NanoClaw v2, and
there is no committed marketplace launch path in this document.
For branch maintenance, see [BRANCH-FORK-MAINTENANCE.md](BRANCH-FORK-MAINTENANCE.md).
