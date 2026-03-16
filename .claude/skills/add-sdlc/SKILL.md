---
name: add-sdlc
description: Establish PR-based SDLC workflow so every code change is auditable and reversible. Use when user wants tracked, branch-per-change development.
---

# Add SDLC Workflow

This skill configures NanoClaw so that **every code change goes through a feature branch and pull request**. The goal is auditability and reproducibility — not CI gatekeeping. Every fork should track its own evolution.

## What This Changes

1. Updates root `CLAUDE.md` with SDLC conventions (so Claude Code always follows the workflow)
2. Updates `groups/main/CLAUDE.md` with instructions for the runtime agent to request code changes via IPC rather than modifying code directly
3. Verifies GitHub remote is configured and `gh` CLI is available

This skill does NOT add complex CI/CD — there's already a CI workflow that runs typecheck and tests on PRs. That's enough.

## Phase 1: Pre-flight

### Check prerequisites

```bash
git remote -v
```

Verify `origin` points to the user's fork (not upstream `qwibitai/nanoclaw`). If origin is upstream, ask the user for their fork URL and fix it.

```bash
gh auth status
```

Verify `gh` CLI is authenticated. If not, tell the user to run `gh auth login` first, then stop.

### Check if already applied

Search the root `CLAUDE.md` for the string `## SDLC Workflow`. If found, tell the user SDLC is already configured and stop.

## Phase 2: Configure SDLC Conventions

### Update root CLAUDE.md

Append the following section to the end of the root `CLAUDE.md`:

```markdown
## SDLC Workflow

**Every code change goes through a branch and PR.** No exceptions.

### Making Changes

1. **Create a branch** from `main`:
   - `feature/*` — new capabilities or skills
   - `fix/*` — bug fixes
   - `config/*` — configuration or environment changes
   - `docs/*` — documentation only

2. **Make changes and commit** with clear, descriptive messages. Include context about WHY, not just what.

3. **Push and open a PR** against `main`:
   ```bash
   git push -u origin <branch-name>
   gh pr create --title "<short title>" --body "<what and why>"
   ```

4. **CI runs automatically** on PRs (typecheck, format, tests). Fix failures before merging.

5. **Merge** when ready. Prefer squash-merge for clean history.

### Rules

- **Never commit directly to `main`.** Always use a branch + PR.
- **Never force-push to `main`.** Use `git revert` to undo bad merges.
- **Every PR must build clean** (`npm run build` + `npm test` pass).
- **Write tests** for new functionality. Run `npx vitest run` before pushing.
- **Tag releases** with semver when deploying: `git tag v<major>.<minor>.<patch>`.

### When the Runtime Agent Wants Code Changes

The agent running inside a container cannot directly modify the NanoClaw codebase. If the agent determines a code change is needed (new skill, bug fix, behavior change), it should:

1. Write a detailed description of the desired change to `groups/main/requested-changes/` as a markdown file
2. Include: what to change, why, which files, and expected behavior
3. A human (or Claude Code session) picks up the request, creates a branch, implements it, and opens a PR

This separation ensures the running agent never breaks itself.
```

### Update groups/main/CLAUDE.md

Read the existing `groups/main/CLAUDE.md`. Append the following section:

```markdown
## Code Change Requests

You are running inside a container and cannot directly modify the NanoClaw source code. This is intentional — it prevents you from breaking your own runtime.

If you identify a needed code change (bug fix, new feature, skill improvement, behavior modification):

1. Create a file in `requested-changes/` with a descriptive filename (e.g., `fix-timezone-handling.md`, `add-retry-logic.md`)
2. Include in the file:
   - **What**: Specific change needed (which files, what code)
   - **Why**: The problem or improvement this addresses
   - **Expected behavior**: How things should work after the change
   - **Priority**: low / medium / high / critical
3. The host will pick up these requests and implement them through the standard PR workflow

Do NOT attempt to modify files in `src/`, `container/`, or other source directories. Your workspace is `groups/main/` and that is where you should write change requests.
```

### Create the requested-changes directory

```bash
mkdir -p groups/main/requested-changes
```

Create a `.gitkeep` in it:

```bash
touch groups/main/requested-changes/.gitkeep
```

## Phase 3: Verify

### Run validation

```bash
npm run build
npm test
```

Both must pass. The changes are documentation-only so this should be clean.

### Show the user what changed

```bash
git diff
```

### Commit the changes

Create a branch and PR following the workflow we just established:

```bash
git checkout -b feature/add-sdlc
git add CLAUDE.md groups/main/CLAUDE.md groups/main/requested-changes/.gitkeep
git commit -m "Add SDLC workflow: branch-per-change with PR tracking

Establishes convention that every code change goes through a feature
branch and pull request. Adds mechanism for runtime agent to request
code changes without modifying source directly.

Co-Authored-By: Claude <noreply@anthropic.com>"
git push -u origin feature/add-sdlc
gh pr create --title "Add SDLC workflow for auditable changes" --body "$(cat <<'PREOF'
## Summary
- Adds SDLC conventions to root CLAUDE.md (branch naming, PR workflow, release tagging)
- Adds code change request mechanism for runtime agent in groups/main/CLAUDE.md
- Creates groups/main/requested-changes/ for agent-to-host change requests

## Why
Every NanoClaw fork should track its own evolution. Changes should be auditable
and reversible. The runtime agent should never modify its own source code directly.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)"
```

**IMPORTANT:** If we are already on a feature branch (e.g., the user ran this skill while already on `feature/add-sdlc`), skip the `git checkout -b` and just commit and push to the current branch.

## Phase 4: Summary

Tell the user:

> SDLC workflow is configured. Here's what's in place:
>
> - **Every change = branch + PR.** Root CLAUDE.md now enforces this for all Claude Code sessions.
> - **Runtime agent can request changes** by writing to `groups/main/requested-changes/`. It cannot modify source code directly.
> - **CI already runs** on PRs (typecheck, format check, tests).
> - **Release tagging** with semver when you deploy.
>
> The workflow is: branch → commit → push → PR → CI passes → merge → deploy.
>
> To make your first change using this workflow:
> ```
> git checkout -b feature/my-change
> # make changes
> git add <files>
> git commit -m "description"
> git push -u origin feature/my-change
> gh pr create
> ```
