---
name: contribute-skill
description: Guide for contributing a new skill to the NanoClaw ecosystem. Covers architecture, contributor flow, skill types, testing, and PR submission. Triggers on "contribute skill", "create skill", "new skill", "build a skill", "make a skill", "skill contribution", or "/contribute-skill".
---

# Contribute a Skill to NanoClaw

This skill guides you through contributing a new feature skill to the NanoClaw ecosystem. By the end you'll have a clean PR ready for upstream.

## How Skills Work

NanoClaw skills are distributed as **git branches** on the upstream repository. Applying a skill is a `git merge`. Everything is standard git.

```
qwibitai/nanoclaw:
  main                  ← core only, no skill code
  skill/discord         ← main + Discord integration
  skill/telegram        ← main + Telegram integration
  skill/usage-tracking  ← main + usage tracking
```

There are two kinds of skills:

| Type | Lives on | Contains | Examples |
|------|----------|----------|----------|
| **Operational** | `main` in `.claude/skills/` | SKILL.md only (instructions, no code) | `/setup`, `/debug`, `/customize` |
| **Feature** | `skill/*` branch | Code changes + SKILL.md in marketplace | `/add-telegram`, `/add-discord` |

## Phase 1: Understand the User's Idea

Ask the user what they want to build. Classify it:

**Feature skill** — adds or changes code in the NanoClaw codebase:
- New channels, integrations, tools, or capabilities
- Modifies source files, adds dependencies, new env vars
- Delivered as a `skill/*` branch

**Operational skill** — guides the user through a workflow without code changes:
- Setup procedures, debugging workflows, maintenance tasks
- SKILL.md only, lives on `main` in `.claude/skills/`
- No branch needed

For **feature skills**, understand:
1. What does it add? New files, npm packages, env vars?
2. What existing files need to change? (Infer from description — don't ask the user to name files)
3. Does it depend on other skills? (e.g., telegram-swarm depends on telegram)
4. Will it conflict with any existing skills?

## Phase 2: Set Up the Branch

### For feature skills

Branch from `upstream/main` to keep it clean — no customizations from the user's fork:

```bash
git fetch upstream main
git checkout -b skill/<name> upstream/main
```

Verify it's clean:

```bash
git log upstream/main..HEAD --oneline
# Should show nothing (no commits yet)
```

### For operational skills

Branch from `upstream/main` as well:

```bash
git fetch upstream main
git checkout -b feat/<name> upstream/main
```

## Phase 3: Implement

### Feature skills — make the code changes

Write the code following NanoClaw conventions:

- **TypeScript**, functional style, minimal
- Follow existing patterns (read similar files first)
- Use the existing migration pattern for DB changes (ALTER TABLE + try/catch)
- Add types to `src/types.ts` if shared across modules
- Keep changes focused — only what the skill needs

**Key files to know:**

| File | When to modify |
|------|---------------|
| `src/types.ts` | Shared interfaces |
| `src/db.ts` | New tables, migrations, accessor functions |
| `src/config.ts` | New config values or env vars |
| `src/container-runner.ts` | Changes to container I/O protocol |
| `container/agent-runner/src/index.ts` | Changes to in-container agent behavior |
| `src/index.ts` | Changes to message processing or orchestration |
| `src/task-scheduler.ts` | Changes to scheduled task execution |
| `.env.example` | New environment variables |
| `package.json` | New dependencies |

### Operational skills — write the SKILL.md

Create `.claude/skills/<name>/SKILL.md` with:

```markdown
---
name: <name>
description: <one-line description with trigger keywords>
---

# <Title>

<What this skill does and when to use it>

## Phase 1: <First step>
...

## Phase 2: <Next step>
...

## Troubleshooting
...
```

## Phase 4: Test

### Build and run tests

```bash
npm run build   # Must compile cleanly
npm test        # All existing tests must pass
```

### Verify branch cleanliness

Ensure the branch contains ONLY your skill's changes:

```bash
git diff upstream/main..HEAD --stat
```

Every file in this diff should be directly related to your skill. No unrelated changes, no other skills' code.

### Manual verification

For feature skills, test the actual functionality:
1. Start NanoClaw in dev mode: `npm run dev`
2. Trigger the new feature via a message
3. Verify it works end-to-end
4. Check for edge cases

## Phase 5: Submit

### Push and PR

Push to your fork and open a PR to `qwibitai/nanoclaw:main`:

```bash
git push -u origin skill/<name>   # or feat/<name> for operational skills

gh pr create --repo qwibitai/nanoclaw --base main \
  --title "feat: <short description>" \
  --body "$(cat <<'PREOF'
## Summary
<What this skill adds>

## Files changed
<List of files and what changed in each>

## Test plan
- [x] npm run build compiles cleanly
- [x] npm test — all tests pass
- [ ] Manual verification: <describe>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)"
```

### What happens next

The maintainer will:

1. **Review the PR** for code quality and compatibility
2. **Create a `skill/<name>` branch** from your PR's commits
3. **Slim your PR** to just a CONTRIBUTORS.md entry
4. **Merge** the slimmed PR (you get merge credit)
5. **Add a SKILL.md** to the marketplace repo (`qwibitai/nanoclaw-skills`)
6. **CI** automatically keeps the skill branch merged-forward with `main`

You don't need to create the skill branch or marketplace entry yourself — just submit code changes via a normal PR.

## Community Skills

You can also maintain skills on your own fork without upstream approval:

1. Keep `skill/*` branches on your fork (each based on `upstream/main`)
2. Optionally create a marketplace repo (e.g., `your-org/nanoclaw-skills`)
3. Users install via:
   ```bash
   git remote add <your-name> https://github.com/<your-org>/nanoclaw.git
   git fetch <your-name> skill/<name>
   git merge <your-name>/skill/<name>
   ```

To get your marketplace auto-discovered, PR an entry to NanoClaw's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "your-skills": {
      "source": { "source": "github", "repo": "your-org/nanoclaw-skills" }
    }
  }
}
```

## Skill Dependencies

If your skill depends on another skill (e.g., telegram-swarm depends on telegram), branch from the parent skill branch instead of `main`:

```bash
git checkout -b skill/telegram-swarm upstream/skill/telegram
```

This way merging your skill also brings in the parent. Dependencies are implicit in git history — no separate dependency file needed.

## Troubleshooting

### Branch has unrelated changes

You probably branched from your fork's `main` instead of `upstream/main`. Fix:

```bash
git checkout -b skill/<name>-clean upstream/main
git cherry-pick <your-commit-hashes>
```

### Tests fail on clean branch

Your code might depend on changes from another skill that isn't declared as a dependency. Either:
- Branch from that skill's branch instead of `main`
- Or remove the dependency

### PR has too many commits

Squash before submitting:

```bash
git rebase -i upstream/main
# Mark all commits except the first as "squash"
```

### Merge conflicts with existing skills

This is expected when skills modify the same files. The CI resolves conflicts automatically using Claude when merging `main` forward into skill branches. Your skill branch only needs to be clean against `main`.
