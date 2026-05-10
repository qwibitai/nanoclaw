# Contributing

## Before You Start

1. **Check for existing work.** Search open PRs and issues before starting:
   ```bash
   gh pr list --repo qwibitai/nanoclaw --search "<your feature>"
   gh issue list --repo qwibitai/nanoclaw --search "<your feature>"
   ```
   If a related PR or issue exists, build on it rather than duplicating effort.

2. **Check alignment.** Read the [Philosophy section in README.md](README.md#philosophy). Source code changes should only be things 90%+ of users need. Skills can be more niche, but should still be useful beyond a single person's setup.

3. **One thing per PR.** Each PR should do one thing — one bug fix, one skill, one simplification. Don't mix unrelated changes in a single PR.

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

NanoClaw uses [Claude Code skills](https://code.claude.com/docs/en/skills) — markdown files with optional supporting files that teach Claude how to do something. Skills can modify the checkout, run maintenance workflows, or teach the runtime agent inside the container.

### Why skills?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Skill types

#### 1. Channel and provider installer skills

Add optional channel adapters or agent providers to a user's checkout. The
SKILL.md contains setup instructions; the source modules live on long-lived
capability branches.

**Location:** `.claude/skills/add-*/` on `main`; channel code on `channels`; provider code on `providers`

**Examples:** `/add-telegram`, `/add-slack`, `/add-discord`, `/add-codex`, `/add-opencode`

**How they work:**
1. User runs `/add-telegram`
2. Claude Code follows the SKILL.md: fetches `channels`, copies the Telegram-owned files, appends the registration import, installs pinned dependencies, and builds
3. Claude walks through interactive setup and then hands off to `/manage-channels`

Provider installers follow the same pattern, but copy from `providers` and wire both host-side and container-side provider barrels.

Installer skills are separate from NanoClaw's runtime agent provider. A user can install `/add-codex` with Claude Code and then run an agent group on the Codex provider.

**Contributing channel or provider support:**
1. Put channel implementation changes on a branch based on `channels`, or provider implementation changes on a branch based on `providers`
2. Put installer instructions and any core registry/infrastructure changes on a separate branch based on `main`
3. Add or update `.claude/skills/add-<name>/SKILL.md` on the `main` branch PR
4. Keep each PR scoped to the branch it targets: optional implementation code on `channels` or `providers`, installer and shared infrastructure on `main`

See `/add-telegram`, `/add-discord`, `/add-codex`, or `/add-opencode` for current examples. See [docs/skills-as-branches.md](docs/skills-as-branches.md) for the current installer model.

#### 2. Branch-based capability skills

Some non-channel capabilities still use a `skill/*` branch when the capability is naturally represented as a branch merge.

**Location:** `.claude/skills/<name>/` on `main`, code on `skill/<name>`

**How they work:**
1. User runs the skill
2. Claude Code fetches and merges `upstream/skill/<name>`
3. Claude validates the result and handles any setup

Do not create channel-specific `skill/*` branches for normal channel adapters. Use `channels`. Do not create provider-specific `skill/*` branches for normal providers. Use `providers`.

#### 3. Utility skills (with code files)

Standalone tools that ship code files alongside the SKILL.md. The SKILL.md tells Claude how to install the tool; the code lives in the skill directory itself (e.g. in a `scripts/` subfolder).

**Location:** `.claude/skills/<name>/` with supporting files

**Examples:** `/claw` (Python CLI in `scripts/claw`)

**Key difference from branch-based capabilities:** No branch merge needed. The code is self-contained in the skill directory and gets copied into place during installation.

**Guidelines:**
- Put code in separate files, not inline in the SKILL.md
- Use `${CLAUDE_SKILL_DIR}` to reference files in the skill directory
- SKILL.md contains installation instructions, usage docs, and troubleshooting

#### 4. Operational skills (instruction-only)

Workflows and guides with no code changes. The SKILL.md is the entire skill — Claude follows the instructions to perform a task.

**Location:** `.claude/skills/` on `main`

**Examples:** `/setup`, `/debug`, `/customize`, `/update-nanoclaw`, `/update-skills`

**Guidelines:**
- Pure instructions — no code files, no branch merges
- Use `AskUserQuestion` for interactive prompts
- These stay on `main` and are always available to every user

#### 5. Container skills (agent runtime)

Skills that run inside the agent container, not on the host. These teach the container agent how to use tools, format output, or perform tasks. They are synced into each group's `.claude/skills/` directory when a container starts.

**Location:** `container/skills/<name>/`

**Examples:** `agent-browser` (web browsing), `capabilities` (/capabilities command), `status` (/status command), `slack-formatting` (Slack mrkdwn syntax)

**Key difference:** These are NOT invoked by the user on the host. They're loaded by Claude Code inside the container and influence how the agent behaves.

**Guidelines:**
- Follow the same SKILL.md + frontmatter format
- Use `allowed-tools` frontmatter to scope tool permissions
- Keep them focused — the agent's context window is shared across all container skills

### SKILL.md format

All skills use the [Claude Code skills standard](https://code.claude.com/docs/en/skills):

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---

Instructions here...
```

**Rules:**
- Keep SKILL.md **under 500 lines** — move detail to separate reference files
- `name`: lowercase, alphanumeric + hyphens, max 64 chars
- `description`: required — Claude uses this to decide when to invoke the skill
- Put code in separate files, not inline in the markdown
- See the [skills standard](https://code.claude.com/docs/en/skills) for all available frontmatter fields

## Testing

Test your contribution on a fresh clone before submitting. For skills, run the skill end-to-end and verify it works.

## Pull Requests

### Before opening

1. **Link related issues.** If your PR resolves an open issue, include `Closes #123` in the description so it's auto-closed on merge.
2. **Test thoroughly.** Run the feature yourself. For skills, test on a fresh clone.
3. **Check for installation-specific files.** Before creating a PR, verify no installation-specific files are in your diff (see PR Hygiene in CLAUDE.md).
4. **Check the right box** in the PR template. Labels are auto-applied based on your selection:

| Checkbox | Label |
|----------|-------|
| Feature skill | `PR: Skill` + `PR: Feature` |
| Utility skill | `PR: Skill` |
| Operational/container skill | `PR: Skill` |
| Fix | `PR: Fix` |
| Simplification | `PR: Refactor` |
| Documentation | `PR: Docs` |

### PR description

Keep it concise. Remove any template sections that don't apply. The description should cover:

- **What** — what the PR adds or changes
- **Why** — the motivation
- **How it works** — brief explanation of the approach
- **How it was tested** — what you did to verify it works
- **Usage** — how the user invokes it (for skills)

Don't pad the description. A few clear sentences are better than lengthy paragraphs.
