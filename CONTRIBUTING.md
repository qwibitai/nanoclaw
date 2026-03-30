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

NanoClaw uses [Claude Code skills](https://code.claude.com/docs/en/skills) — markdown files with optional supporting files that teach Claude how to do something. There are four types of skills in NanoClaw, each serving a different purpose.

### Why skills?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Skill types

#### 1. Feature skills (branch-based)

Add capabilities to NanoClaw by merging a git branch. The SKILL.md contains setup instructions; the actual code lives on a `skill/*` branch.

**Location:** `.claude/skills/` on `main` (instructions only), code on `skill/*` branch

**Examples:** `/add-telegram`, `/add-slack`, `/add-discord`, `/add-gmail`

**How they work:**
1. User runs `/add-telegram`
2. Claude follows the SKILL.md: fetches and merges the `skill/telegram` branch
3. Claude walks through interactive setup (env vars, bot creation, etc.)

**Contributing a feature skill:**
1. Fork `qwibitai/nanoclaw` and branch from `main`
2. Make the code changes (new files, modified source, updated `package.json`, etc.)
3. Add a SKILL.md in `.claude/skills/<name>/` with setup instructions — step 1 should be merging the branch
4. Open a PR. We'll create the `skill/<name>` branch from your work

See `/add-telegram` for a good example. See [docs/skills-as-branches.md](docs/skills-as-branches.md) for the full system design.

#### 2. Utility skills (with code files)

Standalone tools that ship code files alongside the SKILL.md. The SKILL.md tells Claude how to install the tool; the code lives in the skill directory itself (e.g. in a `scripts/` subfolder).

**Location:** `.claude/skills/<name>/` with supporting files

**Examples:** `/claw` (Python CLI in `scripts/claw`)

**Key difference from feature skills:** No branch merge needed. The code is self-contained in the skill directory and gets copied into place during installation.

**Guidelines:**
- Put code in separate files, not inline in the SKILL.md
- Use `${CLAUDE_SKILL_DIR}` to reference files in the skill directory
- SKILL.md contains installation instructions, usage docs, and troubleshooting

#### 3. Operational skills (instruction-only)

Workflows and guides with no code changes. The SKILL.md is the entire skill — Claude follows the instructions to perform a task.

**Location:** `.claude/skills/` on `main`

**Examples:** `/setup`, `/debug`, `/customize`, `/update-nanoclaw`, `/update-skills`

**Guidelines:**
- Pure instructions — no code files, no branch merges
- Use `AskUserQuestion` for interactive prompts
- These stay on `main` and are always available to every user

#### 4. Container skills (agent runtime)

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
3. **Check the right box** in the PR template. Labels are auto-applied based on your selection:

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
