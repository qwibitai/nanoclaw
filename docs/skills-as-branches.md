# Skills as Branches

## Overview

This document covers **feature skills** — skills that add capabilities via git branch merges. This is the most complex skill type and the primary way NanoClaw is extended.

NanoClaw has four types of skills overall. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full taxonomy:

| Type | Location | How it works |
|------|----------|-------------|
| **Feature** (this doc) | `.claude/skills/` + `skill/*` branch | SKILL.md has instructions; code lives on a branch, applied via `git merge` |
| **Utility** | `.claude/skills/<name>/` with code files | Self-contained tools; code in skill directory, copied into place on install |
| **Operational** | `.claude/skills/` on `main` | Instruction-only workflows (setup, debug, update) |
| **Container** | `container/skills/` | Loaded inside agent containers at runtime |

---

Feature skills are distributed as git branches on the upstream repository. Applying a skill is a `git merge`. Updating core is a `git merge`. Everything is standard git.

This replaces the previous `skills-engine/` system (three-way file merging, `.nanoclaw/` state, manifest files, replay, backup/restore) with plain git operations and Claude for conflict resolution.

## How It Works

### Repository structure

The upstream repo (`qwibitai/nanoclaw`) maintains:

- `main` — core NanoClaw (no skill code)
- `skill/discord` — main + Discord integration
- `skill/telegram` — main + Telegram integration
- `skill/slack` — main + Slack integration
- `skill/gmail` — main + Gmail integration
- etc.

Each skill branch contains all the code changes for that skill: new files, modified source files, updated `package.json` dependencies, `.env.example` additions — everything. No manifest, no structured operations, no separate `add/` and `modify/` directories.

### Skill discovery and installation

Skills are split into two categories:

**Operational skills** (on `main`, always available):
- `/setup`, `/debug`, `/update-nanoclaw`, `/customize`, `/update-skills`
- These are instruction-only SKILL.md files — no code changes, just workflows
- Live in `.claude/skills/` on `main`, immediately available to every user

**Feature skills** (in marketplace, installed on demand):
- `/add-discord`, `/add-telegram`, `/add-slack`, `/add-gmail`, etc.
- Each has a SKILL.md with setup instructions and a corresponding `skill/*` branch with code
- Live in the marketplace repo (`qwibitai/nanoclaw-skills`)

Users never interact with the marketplace directly. The operational skills `/setup` and `/customize` handle plugin installation transparently:

```bash
# Claude runs this behind the scenes — users don't see it
claude plugin install nanoclaw-skills@nanoclaw-skills --scope project
```

Skills are hot-loaded after `claude plugin install` — no restart needed. This means `/setup` can install the marketplace plugin, then immediately run any feature skill, all in one session.

### Selective skill installation

`/setup` asks users what channels they want, then only offers relevant skills:

1. "Which messaging channels do you want to use?" → Discord, Telegram, Slack, WhatsApp
2. User picks Telegram → Claude installs the plugin and runs `/add-telegram`
3. After Telegram is set up: "Want to add Agent Swarm support for Telegram?" → offers `/add-telegram-swarm`
4. "Want to enable community skills?" → installs community marketplace plugins

Dependent skills (e.g., `telegram-swarm` depends on `telegram`) are only offered after their parent is installed. `/customize` follows the same pattern for post-setup additions.

### Marketplace configuration

NanoClaw's `.claude/settings.json` registers the official marketplace:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    }
  }
}
```

The marketplace repo uses Claude Code's plugin structure:

```
qwibitai/nanoclaw-skills/
  .claude-plugin/
    marketplace.json              # Plugin catalog
  plugins/
    nanoclaw-skills/              # Single plugin bundling all official skills
      .claude-plugin/
        plugin.json               # Plugin manifest
      skills/
        add-discord/
          SKILL.md                # Setup instructions; step 1 is "merge the branch"
        add-telegram/
          SKILL.md
        add-slack/
          SKILL.md
        ...
```

Multiple skills are bundled in one plugin — installing `nanoclaw-skills` makes all feature skills available at once. Individual skills don't need separate installation.

Each SKILL.md tells Claude to merge the corresponding skill branch as step 1, then walks through interactive setup (env vars, bot creation, etc.).

### Applying a skill

User runs `/add-discord` (discovered via marketplace). Claude follows the SKILL.md:

1. `git fetch upstream skill/discord`
2. `git merge upstream/skill/discord`
3. Interactive setup (create bot, get token, configure env vars, etc.)

Or manually:

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
```

### Applying multiple skills

```bash
git merge upstream/skill/discord
git merge upstream/skill/telegram
```

Git handles the composition. If both skills modify the same lines, it's a real conflict and Claude resolves it.

### Updating core

```bash
git fetch upstream main
git merge upstream/main
```

Since skill branches are kept merged-forward with main (see CI section), the user's merged-in skill changes and upstream changes have proper common ancestors.

### Checking for skill updates

Users who previously merged a skill branch can check for updates. For each `upstream/skill/*` branch, check whether the branch has commits that aren't in the user's HEAD:

```bash
git fetch upstream
for branch in $(git branch -r | grep 'upstream/skill/'); do
  # Check if user has merged this skill at some point
  merge_base=$(git merge-base HEAD "$branch" 2>/dev/null) || continue
  # Check if the skill branch has new commits beyond what the user has
  if ! git merge-base --is-ancestor "$branch" HEAD 2>/dev/null; then
    echo "$branch has updates available"
  fi
done
```

This requires no state — it uses git history to determine which skills were previously merged and whether they have new commits.

This logic is available in two ways:
- Built into `/update-nanoclaw` — after merging main, optionally check for skill updates
- Standalone `/update-skills` — check and merge skill updates independently

### Conflict resolution

At any merge step, conflicts may arise. Claude resolves them — reading the conflicted files, understanding the intent of both sides, and producing the correct result. This is what makes the branch approach viable at scale: conflict resolution that previously required human judgment is now automated.

### Skill dependencies

Some skills depend on other skills. E.g., `skill/telegram-swarm` requires `skill/telegram`. Dependent skill branches are branched from their parent skill branch, not from `main`.

This means `skill/telegram-swarm` includes all of telegram's changes plus its own additions. When a user merges `skill/telegram-swarm`, they get both — no need to merge telegram separately.

Dependencies are implicit in git history — `git merge-base --is-ancestor` determines whether one skill branch is an ancestor of another. No separate dependency file is needed.

### Uninstalling a skill

```bash
# Find the merge commit
git log --merges --oneline | grep discord

# Revert it
git revert -m 1 <merge-commit>
```

This creates a new commit that undoes the skill's changes. Claude can handle the whole flow.

If the user has modified the skill's code since merging (custom changes on top), the revert might conflict — Claude resolves it.

If the user later wants to re-apply the skill, they need to revert the revert first (git treats reverted changes as "already applied and undone"). Claude handles this too.

## CI: Keeping Skill Branches Current

A GitHub Action runs on every push to `main`:

1. List all `skill/*` branches
2. For each skill branch, merge `main` into it (merge-forward, not rebase)
3. Run build and tests on the merged result
4. If tests pass, push the updated skill branch
5. If a skill fails (conflict, build error, test failure), open a GitHub issue for manual resolution

**Why merge-forward instead of rebase:**
- No force-push — preserves history for users who already merged the skill
- Users can re-merge a skill branch to pick up skill updates (bug fixes, improvements)
- Git has proper common ancestors throughout the merge graph

**Why this scales:** With a few hundred skills and a few commits to main per day, the CI cost is trivial. Haiku is fast and cheap. The approach that wouldn't have been feasible a year or two ago is now practical because Claude can resolve conflicts at scale.

## Installation Flow

### New users (recommended)

1. Fork `qwibitai/nanoclaw` on GitHub (click the Fork button)
2. Clone your fork:
   ```bash
   git clone https://github.com/<you>/nanoclaw.git
   cd nanoclaw
   ```
3. Run Claude Code:
   ```bash
   claude
   ```
4. Run `/setup` — Claude handles dependencies, authentication, container setup, service configuration, and adds `upstream` remote if not present

Forking is recommended because it gives users a remote to push their customizations to. Clone-only works for trying things out but provides no remote backup.

### Existing users migrating from clone

Users who previously ran `git clone https://github.com/qwibitai/nanoclaw.git` and have local customizations:

1. Fork `qwibitai/nanoclaw` on GitHub
2. Reroute remotes:
   ```bash
   git remote rename origin upstream
   git remote add origin https://github.com/<you>/nanoclaw.git
   git push --force origin main
   ```
   The `--force` is needed because the fresh fork's main is at upstream's latest, but the user wants their (possibly behind) version. The fork was just created so there's nothing to lose.
3. From this point, `origin` = their fork, `upstream` = qwibitai/nanoclaw

### Existing users migrating from the old skills engine

Users who previously applied skills via the `skills-engine/` system have skill code in their tree but no merge commits linking to skill branches. Git doesn't know these changes came from a skill, so merging a skill branch on top would conflict or duplicate.

**For new skills going forward:** just merge skill branches as normal. No issue.

**For existing old-engine skills**, two migration paths:

**Option A: Per-skill reapply (keep your fork)**
1. For each old-engine skill: identify and revert the old changes, then merge the skill branch fresh
2. Claude assists with identifying what to revert and resolving any conflicts
3. Custom modifications (non-skill changes) are preserved

**Option B: Fresh start (cleanest)**
1. Create a new fork from upstream
2. Merge the skill branches you want
3. Manually re-apply your custom (non-skill) changes
4. Claude assists by diffing your old fork against the new one to identify custom changes

In both cases:
- Delete the `.nanoclaw/` directory (no longer needed)
- The `skills-engine/` code will be removed from upstream once all skills are migrated
- `/update-skills` only tracks skills applied via branch merge — old-engine skills won't appear in update checks

## User Workflows

### Custom changes

Users make custom changes directly on their main branch. This is the standard fork workflow — their `main` IS their customized version.

```bash
# Make changes
vim src/config.ts
git commit -am "change trigger word to @Bob"
git push origin main
```

Custom changes, skills, and core updates all coexist on their main branch. Git handles the three-way merging at each merge step because it can trace common ancestors through the merge history.

### Applying a skill

Run `/add-discord` in Claude Code (discovered via the marketplace plugin), or manually:

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
# Follow setup instructions for configuration
git push origin main
```

If the user is behind upstream's main when they merge a skill branch, the merge might bring in some core changes too (since skill branches are merged-forward with main). This is generally fine — they get a compatible version of everything.

### Updating core

```bash
git fetch upstream main
git merge upstream/main
git push origin main
```

This is the same as the existing `/update-nanoclaw` skill's merge path.

### Updating skills

Run `/update-skills` or let `/update-nanoclaw` check after a core update. For each previously-merged skill branch that has new commits, Claude offers to merge the updates.

### Contributing back to upstream

Users who want to submit a PR to upstream:

```bash
git fetch upstream main
git checkout -b my-fix upstream/main
# Make changes
git push origin my-fix
# Create PR from my-fix to qwibitai/nanoclaw:main
```

Standard fork contribution workflow. Their custom changes stay on their main and don't leak into the PR.

## Contributing a Skill

The flow below is for **feature skills** (branch-based). For utility skills (self-contained tools) and container skills, the contributor opens a PR that adds files directly to `.claude/skills/<name>/` or `container/skills/<name>/` — no branch extraction needed. See [CONTRIBUTING.md](../CONTRIBUTING.md) for all skill types.

### Contributor flow (feature skills)

1. Fork `qwibitai/nanoclaw`
2. Branch from `main`
3. Make the code changes (new channel file, modified integration points, updated package.json, .env.example additions, etc.)
4. Open a PR to `main`

The contributor opens a normal PR — they don't need to know about skill branches or marketplace repos. They just make code changes and submit.

### Maintainer flow

When a skill PR is reviewed and approved:

1. Create a `skill/<name>` branch from the PR's commits:
   ```bash
   git fetch origin pull/<PR_NUMBER>/head:skill/<name>
   git push origin skill/<name>
   ```
2. Force-push to the contributor's PR branch, replacing it with a single commit that adds the contributor to `CONTRIBUTORS.md` (removing all code changes)
3. Merge the slimmed PR into `main` (just the contributor addition)
4. Add the skill's SKILL.md to the marketplace repo (`qwibitai/nanoclaw-skills`)

This way:
- The contributor gets merge credit (their PR is merged)
- They're added to CONTRIBUTORS.md automatically by the maintainer
- The skill branch is created from their work
- `main` stays clean (no skill code)
- The contributor only had to do one thing: open a PR with code changes

**Note:** GitHub PRs from forks have "Allow edits from maintainers" checked by default, so the maintainer can push to the contributor's PR branch.

### Skill SKILL.md

The contributor can optionally provide a SKILL.md (either in the PR or separately). This goes into the marketplace repo and contains:

1. Frontmatter (name, description, triggers)
2. Step 1: Merge the skill branch
3. Steps 2-N: Interactive setup (create bot, get token, configure env vars, verify)

If the contributor doesn't provide a SKILL.md, the maintainer writes one based on the PR.

## Community Marketplaces

Anyone can maintain their own fork with skill branches and their own marketplace repo. This enables a community-driven skill ecosystem without requiring write access to the upstream repo.

### How it works

A community contributor:

1. Maintains a fork of NanoClaw (e.g., `alice/nanoclaw`)
2. Creates `skill/*` branches on their fork with their custom skills
3. Creates a marketplace repo (e.g., `alice/nanoclaw-skills`) with a `.claude-plugin/marketplace.json` and plugin structure

### Adding a community marketplace

If the community contributor is trusted, they can open a PR to add their marketplace to NanoClaw's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    },
    "alice-nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "alice/nanoclaw-skills"
      }
    }
  }
}
```

Once merged, all NanoClaw users automatically discover the community marketplace alongside the official one.

### Installing community skills

`/setup` and `/customize` ask users whether they want to enable community skills. If yes, Claude installs community marketplace plugins via `claude plugin install`:

```bash
claude plugin install alice-skills@alice-nanoclaw-skills --scope project
```

Community skills are hot-loaded and immediately available — no restart needed. Dependent skills are only offered after their prerequisites are met (e.g., community Telegram add-ons only after Telegram is installed).

Users can also browse and install community plugins manually via `/plugin`.

### Properties of this system

- **No gatekeeping required.** Anyone can create skills on their fork without permission. They only need approval to be listed in the auto-discovered marketplaces.
- **Multiple marketplaces coexist.** Users see skills from all trusted marketplaces in `/plugin`.
- **Community skills use the same merge pattern.** The SKILL.md just points to a different remote:
  ```bash
  git remote add alice https://github.com/alice/nanoclaw.git
  git fetch alice skill/my-cool-feature
  git merge alice/skill/my-cool-feature
  ```
- **Users can also add marketplaces manually.** Even without being listed in settings.json, users can run `/plugin marketplace add alice/nanoclaw-skills` to discover skills from any source.
- **CI is per-fork.** Each community maintainer runs their own CI to keep their skill branches merged-forward. They can use the same GitHub Action as the upstream repo.

## Flavors

A flavor is a curated fork of NanoClaw — a combination of skills, custom changes, and configuration tailored for a specific use case (e.g., "NanoClaw for Sales," "NanoClaw Minimal," "NanoClaw for Developers").

### Creating a flavor

1. Fork `qwibitai/nanoclaw`
2. Merge in the skills you want
3. Make custom changes (trigger word, prompts, integrations, etc.)
4. Your fork's `main` IS the flavor

### Installing a flavor

During `/setup`, users are offered a choice of flavors before any configuration happens. The setup skill reads `flavors.yaml` from the repo (shipped with upstream, always up to date) and presents options:

AskUserQuestion: "Start with a flavor or default NanoClaw?"
- Default NanoClaw
- NanoClaw for Sales — Gmail + Slack + CRM (maintained by alice)
- NanoClaw Minimal — Telegram-only, lightweight (maintained by bob)

If a flavor is chosen:

```bash
git remote add <flavor-name> https://github.com/alice/nanoclaw.git
git fetch <flavor-name> main
git merge <flavor-name>/main
```

Then setup continues normally (dependencies, auth, container, service).

**This choice is only offered on a fresh fork** — when the user's main matches or is close to upstream's main with no local commits. If `/setup` detects significant local changes (re-running setup on an existing install), it skips the flavor selection and goes straight to configuration.

After installation, the user's fork has three remotes:
- `origin` — their fork (push customizations here)
- `upstream` — `qwibitai/nanoclaw` (core updates)
- `<flavor-name>` — the flavor fork (flavor updates)

### Updating a flavor

```bash
git fetch <flavor-name> main
git merge <flavor-name>/main
```

The flavor maintainer keeps their fork updated (merging upstream, updating skills). Users pull flavor updates the same way they pull core updates.

### Flavors registry

`flavors.yaml` lives in the upstream repo:

```yaml
flavors:
  - name: NanoClaw for Sales
    repo: alice/nanoclaw
    description: Gmail + Slack + CRM integration, daily pipeline summaries
    maintainer: alice

  - name: NanoClaw Minimal
    repo: bob/nanoclaw
    description: Telegram-only, no container overhead
    maintainer: bob
```

Anyone can PR to add their flavor. The file is available locally when `/setup` runs since it's part of the cloned repo.

### Discoverability

- **During setup** — flavor selection is offered as part of the initial setup flow
- **`/browse-flavors` skill** — reads `flavors.yaml` and presents options at any time
- **GitHub topics** — flavor forks can tag themselves with `nanoclaw-flavor` for searchability
- **Discord / website** — community-curated lists

## Migration

Migration from the old skills engine to branches is complete. All feature skills now live on `skill/*` branches, and the skills engine has been removed.

### Skill branches

| Branch | Base | Description |
|--------|------|-------------|
| `skill/whatsapp` | `main` | WhatsApp channel |
| `skill/telegram` | `main` | Telegram channel |
| `skill/slack` | `main` | Slack channel |
| `skill/discord` | `main` | Discord channel |
| `skill/gmail` | `main` | Gmail channel |
| `skill/voice-transcription` | `skill/whatsapp` | OpenAI Whisper voice transcription |
| `skill/image-vision` | `skill/whatsapp` | Image attachment processing |
| `skill/pdf-reader` | `skill/whatsapp` | PDF attachment reading |
| `skill/local-whisper` | `skill/voice-transcription` | Local whisper.cpp transcription |
| `skill/ollama-tool` | `main` | Ollama MCP server for local models |
| `skill/apple-container` | `main` | Apple Container runtime |
| `skill/reactions` | `main` | WhatsApp emoji reactions |

### What was removed

- `skills-engine/` directory (entire engine)
- `scripts/apply-skill.ts`, `scripts/uninstall-skill.ts`, `scripts/rebase.ts`
- `scripts/fix-skill-drift.ts`, `scripts/validate-all-skills.ts`
- `.github/workflows/skill-drift.yml`, `.github/workflows/skill-pr.yml`
- All `add/`, `modify/`, `tests/`, and `manifest.yaml` from skill directories
- `.nanoclaw/` state directory

Operational skills (`setup`, `debug`, `update-nanoclaw`, `customize`, `update-skills`) remain on main in `.claude/skills/`.

## What Changes

### README Quick Start

Before:
```bash
git clone https://github.com/qwibitai/NanoClaw.git
cd NanoClaw
claude
```

After:
```
1. Fork qwibitai/nanoclaw on GitHub
2. git clone https://github.com/<you>/nanoclaw.git
3. cd nanoclaw
4. claude
5. /setup
```

### Setup skill (`/setup`)

Updates to the setup flow:

- Check if `upstream` remote exists; if not, add it: `git remote add upstream https://github.com/qwibitai/nanoclaw.git`
- Check if `origin` points to the user's fork (not qwibitai). If it points to qwibitai, guide them through the fork migration.
- **Install marketplace plugin:** `claude plugin install nanoclaw-skills@nanoclaw-skills --scope project` — makes all feature skills available (hot-loaded, no restart)
- **Ask which channels to add:** present channel options (Discord, Telegram, Slack, WhatsApp, Gmail), run corresponding `/add-*` skills for selected channels
- **Offer dependent skills:** after a channel is set up, offer relevant add-ons (e.g., Agent Swarm after Telegram, voice transcription after WhatsApp)
- **Optionally enable community marketplaces:** ask if the user wants community skills, install those marketplace plugins too

### `.claude/settings.json`

Marketplace configuration so the official marketplace is auto-registered:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    }
  }
}
```

### Skills directory on main

The `.claude/skills/` directory on `main` retains only operational skills (setup, debug, update-nanoclaw, customize, update-skills). Feature skills (add-discord, add-telegram, etc.) live in the marketplace repo, installed via `claude plugin install` during `/setup` or `/customize`.

### Skills engine removal

The following can be removed:

- `skills-engine/` — entire directory (apply, merge, replay, state, backup, etc.)
- `scripts/apply-skill.ts`
- `scripts/uninstall-skill.ts`
- `scripts/fix-skill-drift.ts`
- `scripts/validate-all-skills.ts`
- `.nanoclaw/` — state directory
- `add/` and `modify/` subdirectories from all skill directories
- Feature skill SKILL.md files from `.claude/skills/` on main (they now live in the marketplace)

Operational skills (`setup`, `debug`, `update-nanoclaw`, `customize`, `update-skills`) remain on main in `.claude/skills/`.

### New infrastructure

- **Marketplace repo** (`qwibitai/nanoclaw-skills`) — single Claude Code plugin bundling SKILL.md files for all feature skills
- **CI GitHub Action** — merge-forward `main` into all `skill/*` branches on every push to `main`, using Claude (Haiku) for conflict resolution
- **`/update-skills` skill** — checks for and applies skill branch updates using git history
- **`CONTRIBUTORS.md`** — tracks skill contributors

### Update skill (`/update-nanoclaw`)

The update skill gets simpler with the branch-based approach. The old skills engine required replaying all applied skills after merging core updates — that entire step disappears. Skill changes are already in the user's git history, so `git merge upstream/main` just works.

**What stays the same:**
- Preflight (clean working tree, upstream remote)
- Backup branch + tag
- Preview (git log, git diff, file buckets)
- Merge/cherry-pick/rebase options
- Conflict preview (dry-run merge)
- Conflict resolution
- Build + test validation
- Rollback instructions

**What's removed:**
- Skill replay step (was needed by the old skills engine to re-apply skills after core update)
- Re-running structured operations (npm deps, env vars — these are part of git history now)

**What's added:**
- Optional step at the end: "Check for skill updates?" which runs the `/update-skills` logic
- This checks whether any previously-merged skill branches have new commits (bug fixes, improvements to the skill itself — not just merge-forwards from main)

**Why users don't need to re-merge skills after a core update:**
When the user merged a skill branch, those changes became part of their git history. When they later merge `upstream/main`, git performs a normal three-way merge — the skill changes in their tree are untouched, and only core changes are brought in. The merge-forward CI ensures skill branches stay compatible with latest main, but that's for new users applying the skill fresh. Existing users who already merged the skill don't need to do anything.

Users only need to re-merge a skill branch if the skill itself was updated (not just merged-forward with main). The `/update-skills` check detects this.

## Discord Announcement

### For existing users

> **Skills are now git branches**
>
> We've simplified how skills work in NanoClaw. Instead of a custom skills engine, skills are now git branches that you merge in.
>
> **What this means for you:**
> - Applying a skill: `git fetch upstream skill/discord && git merge upstream/skill/discord`
> - Updating core: `git fetch upstream main && git merge upstream/main`
> - Checking for skill updates: `/update-skills`
> - No more `.nanoclaw/` state directory or skills engine
>
> **We now recommend forking instead of cloning.** This gives you a remote to push your customizations to.
>
> **If you currently have a clone with local changes**, migrate to a fork:
> 1. Fork `qwibitai/nanoclaw` on GitHub
> 2. Run:
>    ```
>    git remote rename origin upstream
>    git remote add origin https://github.com/<you>/nanoclaw.git
>    git push --force origin main
>    ```
>    This works even if you're way behind — just push your current state.
>
> **If you previously applied skills via the old system**, your code changes are already in your working tree — nothing to redo. You can delete the `.nanoclaw/` directory. Future skills and updates use the branch-based approach.
>
> **Discovering skills:** Skills are now available through Claude Code's plugin marketplace. Run `/plugin` in Claude Code to browse and install available skills.

### For skill contributors

> **Contributing skills**
>
> To contribute a skill:
> 1. Fork `qwibitai/nanoclaw`
> 2. Branch from `main` and make your code changes
> 3. Open a regular PR
>
> That's it. We'll create a `skill/<name>` branch from your PR, add you to CONTRIBUTORS.md, and add the SKILL.md to the marketplace. CI automatically keeps skill branches merged-forward with `main` using Claude to resolve any conflicts.
>
> **Want to run your own skill marketplace?** Maintain skill branches on your fork and create a marketplace repo. Open a PR to add it to NanoClaw's auto-discovered marketplaces — or users can add it manually via `/plugin marketplace add`.
