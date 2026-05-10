# Branch maintenance guidelines

NanoClaw uses a small set of long-lived branches to keep optional capability
code out of `main` while still making it easy for installer skills to copy or
merge the pieces a user asks for.

## Branch roles

| Branch | Purpose |
|---|---|
| `main` | Core runtime, setup flow, registries, shared infrastructure, and installer skill definitions. |
| `channels` | Channel adapters and channel-specific setup helpers. |
| `providers` | Non-default agent providers and provider-specific host/container setup. |
| `skill/*` | Residual branch-based capabilities that do not fit the `channels` or `providers` branches. |

Do not maintain one fork per channel as the normal channel distribution model.
Channel installers should copy modules from `channels`. Provider installers
should copy modules from `providers`.

## How users add capabilities

Users run Claude Code installer skills from `.claude/skills/`.

```text
/add-discord   -> copy Discord files from channels
/add-telegram  -> copy Telegram files from channels
/add-codex     -> copy Codex files from providers
/add-opencode  -> copy OpenCode files from providers
/add-compact   -> merge or apply the relevant skill capability
```

The installer skill is a repository-modification workflow. It is separate from
the runtime provider selected for an agent group. A user can install
`/add-codex` with Claude Code and then run an agent on the Codex provider.

## Merge directions

Long-lived capability branches should be kept current with `main`.

```text
main -> channels
main -> providers
main -> skill/*
```

Use merge-forward, not rebase, for branches that users or installer skills may
already rely on. Preserving history keeps later merges understandable and avoids
rewriting branch ancestry.

## Forward merge procedure

The examples below use `origin` for the canonical `qwibitai/nanoclaw` remote.
If you are working from a fork, replace `origin` with the remote that points to
`qwibitai/nanoclaw`, usually `upstream`, and push your PR branch to your fork.

```bash
git fetch origin
git checkout channels          # or providers / skill/<name>
git merge origin/main
# resolve conflicts
pnpm run build
pnpm test
git push origin HEAD
```

For provider changes, also run the container typecheck when provider files under
`container/agent-runner/` are touched:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

For channel changes, run the smallest channel-specific verification described in
the relevant `.claude/skills/add-*/SKILL.md` file.

## Conflict resolution

Common conflict points:

| File | Resolution |
|---|---|
| `package.json` | Keep `main` changes and preserve capability-specific dependencies. |
| `pnpm-lock.yaml` | Regenerate after resolving `package.json` rather than hand-editing. |
| `container/agent-runner/package.json` / `bun.lock` | Keep provider-specific runtime deps and regenerate with the correct package manager. |
| `src/channels/index.ts` | Preserve one self-registration import per installed channel module. |
| `src/providers/index.ts` | Preserve one self-registration import per installed host provider. |
| `container/agent-runner/src/providers/index.ts` | Preserve one self-registration import per installed container provider. |
| `repo-tokens/badge.svg` | Take `main` unless the branch intentionally regenerated it. |

Always build after resolving conflicts. A clean git merge can still be
semantically wrong if a shared interface changed.

## Creating a new channel installer

1. Add the channel module and tests on `channels`.
2. Add or update `.claude/skills/add-<channel>/SKILL.md` on `main`.
3. The skill should fetch `channels`, copy only the owned channel files, append
   the barrel import, install pinned dependencies, build, and hand off to
   `/manage-channels`.
4. Do not create a permanent channel fork as the distribution mechanism.

## Creating a new provider installer

1. Add host-side and container-side provider modules on `providers`.
2. Add or update `.claude/skills/add-<provider>/SKILL.md` on `main`.
3. The skill should fetch `providers`, copy only the owned provider files, append
   both provider barrel imports, install pinned dependencies or CLIs, typecheck,
   build, and rebuild the agent image.

## Creating a `skill/*` capability branch

Use `skill/*` only when the capability is not a normal channel or provider and
is easier to maintain as a branch merge than as file copies. The installer skill
must state exactly which branch it merges and how to validate the result.

## User forks

Users should still keep their own fork for personal customizations and backups.
Those forks are not the channel distribution model. They are user-owned working
copies where installer skills and local changes accumulate.
