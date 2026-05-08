---
name: update-nanoclaw
description: Efficiently bring upstream NanoClaw updates into a customized install, with preview, selective cherry-pick, and low token usage.
---

# About

Your NanoClaw fork drifts from upstream as you customize it. This skill pulls upstream changes into your install without losing your modifications.

Run `/update-nanoclaw` in Claude Code.

## How it works

**Preflight**: checks for clean working tree (`git status --porcelain`). If `upstream` remote is missing, asks you for the URL (defaults to `https://github.com/qwibitai/nanoclaw.git`) and adds it. Detects the upstream branch name (`main` or `master`).

**Backup**: creates a timestamped backup branch and tag (`backup/pre-update-<hash>-<timestamp>`, `pre-update-<hash>-<timestamp>`) before touching anything. Safe to run multiple times.

**Preview**: runs `git log` and `git diff` against the merge base to show upstream changes since your last sync. Groups changed files into categories:
- **Skills** (`.claude/skills/`): unlikely to conflict unless you edited an upstream skill
- **Host source** (`src/`): may conflict if you modified the same files
- **Container** (`container/`): triggers container rebuild
- **Build/config** (`package.json`, `pnpm-lock.yaml`, `tsconfig*.json`): lockfile changes trigger dep install

**Update paths** (you pick one):
- `merge` (default): `git merge upstream/<branch>`. Resolves all conflicts in one pass.
- `cherry-pick`: `git cherry-pick <hashes>`. Pull in only the commits you want.
- `rebase`: `git rebase upstream/<branch>`. Linear history, but conflicts resolve per-commit.
- `abort`: just view the changelog, change nothing.

**Conflict preview**: before merging, runs a dry-run (`git merge --no-commit --no-ff`) to show which files would conflict. You can still abort at this point.

**Conflict resolution**: opens only conflicted files, resolves the conflict markers, keeps your local customizations intact.

**Validation**: runs `pnpm run build` and `pnpm test`. If container files changed, also runs the container typecheck and `./container/build.sh`.

**Post-merge audit**: five checks that go beyond build + tests (details in `audit.md`):
- **A. Silent drops** — exports or individual lines your pre-merge HEAD had that the auto-merge dropped without firing a conflict marker.
- **B. Container rebuild requirement** — flags when `container/`, `src/config.ts`, or `src/install-slug.ts` changes mean the built agent-container image is stale; the final restart is gated on this.
- **C. Live migration preflight** — scans pending migrations against the real `data/v2.db` for `ALTER ... NOT NULL`, `DROP`, or destructive `UPDATE` that tests (scratch DB) miss.
- **D. Env var drift** — finds `.env` keys no source file reads anymore and new required keys the user hasn't set.
- **E. Supply-chain policy drift** — hard-fails if upstream silently added `minimumReleaseAgeExclude` or `onlyBuiltDependencies` entries.

**Breaking changes check**: after the audit, reads CHANGELOG.md for any `[BREAKING]` entries introduced by the update. If found, shows each breaking change and offers to run the recommended skill to migrate.

## Rollback

The backup tag is printed at the end of each run:
```
git reset --hard pre-update-<hash>-<timestamp>
```

Backup branch `backup/pre-update-<hash>-<timestamp>` also exists.

## Token usage

Only opens files with actual conflicts. Uses `git log`, `git diff`, and `git status` for everything else. Does not scan or refactor unrelated code.

---

# Goal
Help a user with a customized NanoClaw install safely incorporate upstream changes without a fresh reinstall and without blowing tokens.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before touching anything.
- Prefer git-native operations (fetch, merge, cherry-pick). Do not manually rewrite files except conflict markers.
- Default to MERGE (one-pass conflict resolution). Offer REBASE as an explicit option.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only conflicted files.

# Step 0: Preflight (stop early if unsafe)
Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Confirm remotes:
- `git remote -v`
If `upstream` is missing:
- Ask the user for the upstream repo URL (default: `https://github.com/qwibitai/nanoclaw.git`).
- Add it: `git remote add upstream <user-provided-url>`
- Then: `git fetch upstream --prune`

Determine the upstream branch name:
- `git branch -r | grep upstream/`
- If `upstream/main` exists, use `main`.
- If only `upstream/master` exists, use `master`.
- Otherwise, ask the user which branch to use.
- Store this as UPSTREAM_BRANCH for all subsequent commands. Every command below that references `upstream/main` should use `upstream/$UPSTREAM_BRANCH` instead.

Fetch:
- `git fetch upstream --prune`

# Step 1: Create a safety net
Capture current state:
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branch and tag (using timestamp to avoid collisions on retry):
- `git branch backup/pre-update-$HASH-$TIMESTAMP`
- `git tag pre-update-$HASH-$TIMESTAMP`

Save the tag name for later reference in the summary and rollback instructions.

# Step 2: Preview what upstream changed (no edits yet)
Compute common base:
- `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`

Show upstream commits since BASE:
- `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`

Show local commits since BASE (custom drift):
- `git log --oneline $BASE..HEAD`

Show file-level impact from upstream:
- `git diff --name-only $BASE..upstream/$UPSTREAM_BRANCH`

Bucket the upstream changed files:
- **Skills** (`.claude/skills/`): unlikely to conflict unless the user edited an upstream skill
- **Host source** (`src/`): may conflict if user modified the same files
- **Container** (`container/`): triggers container rebuild (+ typecheck if `agent-runner/src/` changed)
- **Build/config** (`package.json`, `pnpm-lock.yaml`, `tsconfig*.json`): lockfile changes trigger dep install
- **Other**: docs, tests, setup scripts, misc

**Large drift check:** If the upstream commit count and age suggest the user has a lot of catching up to do, mention that `/migrate-nanoclaw` might be a better fit — it extracts customizations and reapplies them on clean upstream instead of merging. Offer it as an option but don't push.

Present these buckets to the user and ask them to choose one path using AskUserQuestion:
- A) **Full update**: merge all upstream changes
- B) **Selective update**: cherry-pick specific upstream commits
- C) **Abort**: they only wanted the preview
- D) **Rebase mode**: advanced, linear history (warn: resolves conflicts per-commit)

If Abort: stop here.

# Step 3: Conflict preview (before committing anything)
If Full update or Rebase:
- Dry-run merge to preview conflicts. Run these as a single chained command so the abort always executes:
  ```
  git merge --no-commit --no-ff upstream/$UPSTREAM_BRANCH; git diff --name-only --diff-filter=U; git merge --abort
  ```
- If conflicts were listed: show them and ask user if they want to proceed.
- If no conflicts: tell user it is clean and proceed.

# Step 4A: Full update (MERGE, default)

Capture the upstream SHA being merged (used by the safety guards below):
- `UPSTREAM_SHA=$(git rev-parse upstream/$UPSTREAM_BRANCH)`

Run:
- `git merge upstream/$UPSTREAM_BRANCH --no-edit`

**Critical — do NOT run `git stash`, `git reset`, or `git checkout` while in merge state** (i.e. while `.git/MERGE_HEAD` exists). All three discard `MERGE_HEAD` silently, after which the next `git commit` produces a single-parent commit instead of a merge. The upstream commits then remain orphaned from your ancestry: GitHub's compare API and any `git rev-list origin..upstream` check will keep reporting the fork as "behind upstream" even though the file content was integrated.

If conflicts occur:
- Run `git status` and identify conflicted files.
- For each conflicted file:
  - Open the file.
  - Resolve only conflict markers.
  - Preserve intentional local customizations.
  - Incorporate upstream fixes/improvements.
  - Do not refactor surrounding code.
  - `git add <file>`
- When all resolved:
  - **Pre-commit guard** — verify `.git/MERGE_HEAD` still exists. If something cleared it during conflict resolution, restore it from the SHA captured above so the next commit becomes a proper merge:
    ```bash
    if [ ! -f .git/MERGE_HEAD ]; then
      echo "$UPSTREAM_SHA" > .git/MERGE_HEAD
    fi
    ```
  - If merge did not auto-commit: `git commit --no-edit`

**Post-commit verification** — confirm the resulting commit has 2 parents:
```bash
PARENT_COUNT=$(git rev-list --parents -1 HEAD | awk '{print NF-1}')
if [ "$PARENT_COUNT" != "2" ]; then
  echo "ERROR: merge produced a $PARENT_COUNT-parent commit (expected 2)."
  echo "Upstream commits are NOT in your ancestry — the fork will keep reporting 'behind upstream'."
  echo "Recover with: git reset --hard <backup-tag-from-step-1> and re-run /update-nanoclaw."
  echo "Avoid 'git stash', 'git reset', 'git checkout' during conflict resolution."
  exit 1
fi
```
If this fails, abort the skill — do not proceed to Step 5. The user must reset to the backup tag and retry.

# Step 4B: Selective update (CHERRY-PICK)
If user chose Selective:
- Recompute BASE if needed: `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`
- Show commit list again: `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`
- Ask user which commit hashes they want.
- Apply: `git cherry-pick <hash1> <hash2> ...`

If conflicts during cherry-pick:
- Resolve only conflict markers, then:
  - `git add <file>`
  - `git cherry-pick --continue`
If user wants to stop:
  - `git cherry-pick --abort`

# Step 4C: Rebase (only if user explicitly chose option D)
Run:
- `git rebase upstream/$UPSTREAM_BRANCH`

If conflicts:
- Resolve conflict markers only, then:
  - `git add <file>`
  - `git rebase --continue`
If it gets messy (more than 3 rounds of conflicts):
  - `git rebase --abort`
  - Recommend merge instead.

# Step 4.5: Install dependencies (if lockfiles changed)
Check if the merge changed any lockfiles or package manifests:
- `git diff <backup-tag-from-step-1>..HEAD --name-only | grep -E '^(pnpm-lock\.yaml|package\.json)$'`
  - If matched: `pnpm install`
- `git diff <backup-tag-from-step-1>..HEAD --name-only | grep -E '^container/agent-runner/(bun\.lock|package\.json)$'`
  - If matched AND `command -v bun` succeeds: `cd container/agent-runner && bun install`
  - If bun is not installed on the host, skip — container deps will be installed during `./container/build.sh`

Skip this step if neither lockfile changed.

# Step 5: Validation
Check which areas changed to determine what to validate:
- `CHANGED_FILES=$(git diff --name-only <backup-tag-from-step-1>..HEAD)`

**Host build** (always):
- `pnpm run build`
- `pnpm test` (do not fail the flow if tests are not configured)

**Container typecheck** (only if `container/agent-runner/src/` files are in CHANGED_FILES AND bun types are available):
- Check: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
- If this fails because bun types are missing (`Cannot find type definition file for 'bun'`), skip with a note — type errors will surface at container runtime instead

**Container image rebuild** (only if any `container/` files are in CHANGED_FILES):
- `./container/build.sh`

If build fails:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches from merged code).
- Do not refactor unrelated code.
- If unclear, ask the user before making changes.

# Step 6: Post-merge audit

After validation passes, run the full audit defined in `.claude/skills/update-nanoclaw/audit.md`:

1. Read `.claude/skills/update-nanoclaw/audit.md` with the Read tool.
2. Follow every sub-audit (A–E) in order, passing `BACKUP=<backup-tag-from-step-1>` through the environment.
3. Collect findings into the consolidated report format at the end of `audit.md`.
4. Apply the decision rules:
   - Any `BLOCK` → stop here; require user resolution before continuing.
   - `FLAG` items → show the details, ask the user whether to accept them or rollback. Default to proceed on acceptance.
   - All `PASS` → continue silently.
5. Persist the audit verdict. Step 9 needs:
   - `REBUILD_REQUIRED` (from sub-audit B) — whether the final restart must be gated on `./container/build.sh`.
   - `DB_BACKUP_RECOMMENDED` (from sub-audit C) — whether the user should back up `data/v2.db` before restart.

Rollback recipe (for BLOCK or user-rejected FLAG):

```bash
git reset --hard <backup-tag-from-step-1>
```

# Step 7: Breaking changes check
After the audit clears, check if the update introduced any breaking changes.

Determine which CHANGELOG entries are new by diffing against the backup tag:
- `git diff <backup-tag-from-step-1>..HEAD -- CHANGELOG.md`

Parse the diff output for lines that contain `[BREAKING]` anywhere in the line. Each such line is one breaking change entry. The format is:
```
[BREAKING] <description>. Run `/<skill-name>` to <action>.
```

If no `[BREAKING]` lines are found:
- Skip this step silently. Proceed to Step 8 (skill updates check).

If one or more `[BREAKING]` lines are found:
- Display a warning header to the user: "This update includes breaking changes that may require action:"
- For each breaking change, display the full description.
- Collect all skill names referenced in the breaking change entries (the `/<skill-name>` part).
- Use AskUserQuestion to ask the user which migration skills they want to run now. Options:
  - One option per referenced skill (e.g., "Run /add-whatsapp to re-add WhatsApp channel")
  - "Skip — I'll handle these manually"
- Set `multiSelect: true` so the user can pick multiple skills if there are several breaking changes.
- For each skill the user selects, invoke it using the Skill tool.
- After all selected skills complete (or if user chose Skip), proceed to Step 8 (skill updates check).

# Step 8: Check for skill and channel/provider updates

## 8a: Skill branches
Check if skills are distributed as branches in this repo:
- `git branch -r --list 'upstream/skill/*'`

If any `upstream/skill/*` branches exist:
- Use AskUserQuestion to ask: "Upstream has skill branches. Would you like to check for skill updates?"
  - Option 1: "Yes, check for updates" (description: "Runs /update-skills to check for and apply skill branch updates")
  - Option 2: "No, skip" (description: "You can run /update-skills later any time")
- If user selects yes, invoke `/update-skills` using the Skill tool.
- After the skill completes (or if user selected no), continue to 8b.

## 8b: Channel and provider updates
Detect installed channels by reading `src/channels/index.ts` and collecting all `import './<name>.js';` lines (excluding `cli`). For providers, check `src/providers/index.ts` the same way.

If any channels/providers are installed AND `upstream/channels` or `upstream/providers` branches exist:
- List the installed channels/providers.
- Use AskUserQuestion to ask: "Would you like to update your installed channels/providers? Re-running `/add-<name>` is safe — it only updates code files, credentials and wiring are untouched."
  - One option per installed channel/provider (e.g., "Update Slack (/add-slack)")
  - "Skip — I'll update them later"
  - Set `multiSelect: true`
- For each selected option, invoke the corresponding `/add-<channel>` or `/add-<provider>` skill.

If no channels/providers are installed, skip silently.

Proceed to Step 9.

# Step 9: Summary + rollback instructions
Show:
- Backup tag: the tag name created in Step 1
- New HEAD: `git rev-parse --short HEAD`
- Upstream HEAD: `git rev-parse --short upstream/$UPSTREAM_BRANCH`
- Conflicts resolved (list files, if any)
- Audit findings (A–E verdicts from Step 6)
- Breaking changes applied (list skills run, if any)
- Remaining local diff vs upstream: `git diff --name-only upstream/$UPSTREAM_BRANCH..HEAD`

Apply audit-driven gating before suggesting the restart:

- If `REBUILD_REQUIRED=yes` (from audit sub-B): the restart command MUST be preceded by `./container/build.sh`. State this as a required pre-step, not optional. If sub-B also noted buildx cache staleness, add `docker buildx prune -f` before the build.
- If `DB_BACKUP_RECOMMENDED=yes` (from audit sub-C): suggest `cp data/v2.db data/v2.db.pre-update-$(date +%s)` before restart.

Tell the user:
- To rollback: `git reset --hard <backup-tag-from-step-1>`
- Backup branch also exists: `backup/pre-update-<HASH>-<TIMESTAMP>`
- Restart the service to apply changes (after rebuild/backup if flagged above). Detect platform with `uname -s`:
  - **macOS (Darwin)**: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
  - **Linux (systemd user)**: detect the service name with `systemctl --user list-units --type=service | grep nanoclaw | awk '{print $1}'`, then `systemctl --user restart <detected-name>`
  - **Linux (systemd system)**: `sudo systemctl restart nanoclaw-v2`
  - **Manual** (no service found): restart `pnpm run dev`


## Diagnostics

1. Use the Read tool to read `.claude/skills/update-nanoclaw/diagnostics.md`.
2. Follow every step in that file before finishing.
