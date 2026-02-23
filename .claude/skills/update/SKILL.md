---
name: update
description: "Update NanoClaw from upstream. Fetches latest changes, merges with your customizations and skills, runs migrations. Triggers on \"update\", \"pull upstream\", \"sync with upstream\", \"get latest changes\"."
---

# Update NanoClaw

Pull upstream changes and merge them with the user's installation, preserving skills and customizations. Scripts live in `.claude/skills/update/scripts/`.

**Principle:** Handle everything automatically. Only pause for user confirmation before applying changes, or when merge conflicts need human judgment.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Pre-flight

Check that the skills system is initialized:

```bash
test -d .nanoclaw && echo "INITIALIZED" || echo "NOT_INITIALIZED"
```

**If NOT_INITIALIZED:** Run `initSkillsSystem()` first:

```bash
npx tsx -e "import { initNanoclawDir } from './skills-engine/init.js'; initNanoclawDir();"
```

Check for uncommitted git changes:

```bash
git status --porcelain
```

**If there are uncommitted changes:** Warn the user: "You have uncommitted changes. It's recommended to commit or stash them before updating. Continue anyway?" Use `AskUserQuestion` with options: "Continue anyway", "Abort (I'll commit first)". If they abort, stop here.

## 2. Fetch upstream

Run the fetch script:

```bash
./.claude/skills/update/scripts/fetch-upstream.sh
```

Parse the structured status block between `<<< STATUS` and `STATUS >>>` markers. Extract:
- `TEMP_DIR` — path to extracted upstream files
- `REMOTE` — which git remote was used
- `CURRENT_VERSION` — version from local `package.json`
- `NEW_VERSION` — version from upstream `package.json`
- `STATUS` — "success" or "error"

**If STATUS=error:** Show the error output and stop.

**If CURRENT_VERSION equals NEW_VERSION:** Tell the user they're already up to date. Ask if they want to force the update anyway (there may be non-version-bumped changes). If no, clean up the temp dir and stop.

## 3. Preview

Run the preview to show what will change:

```bash
npx tsx scripts/update-core.ts --json --preview-only <TEMP_DIR>
```

This outputs JSON with: `currentVersion`, `newVersion`, `filesChanged`, `filesDeleted`, `conflictRisk`, `customPatchesAtRisk`.

Present to the user:
- "Updating from **{currentVersion}** to **{newVersion}**"
- "{N} files will be changed" — list them if <= 20, otherwise summarize
- If `conflictRisk` is non-empty: "These files have skill modifications and may conflict: {list}"
- If `customPatchesAtRisk` is non-empty: "These custom patches may need re-application: {list}"
- If `filesDeleted` is non-empty: "{N} files will be removed"

## 4. Confirm

Use `AskUserQuestion`: "Apply this update?" with options:
- "Yes, apply update"
- "No, cancel"

If cancelled, clean up the temp dir (`rm -rf <TEMP_DIR>`) and stop.

## 5. Apply

Run the update:

```bash
npx tsx scripts/update-core.ts --json <TEMP_DIR>
```

Parse the JSON output. The result has: `success`, `previousVersion`, `newVersion`, `mergeConflicts`, `backupPending`, `customPatchFailures`, `skillReapplyResults`, `error`.

**If success=true with no issues:** Continue to step 7.

**If customPatchFailures exist:** Warn the user which custom patches failed to re-apply. These may need manual attention after the update.

**If skillReapplyResults has false entries:** Warn the user which skill tests failed after re-application.

## 6. Handle conflicts

**If backupPending=true:** There are unresolved merge conflicts.

For each file in `mergeConflicts`:
1. Read the file — it contains conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
2. Check if there's an intent file for this path in any applied skill (e.g., `.claude/skills/<skill>/modify/<path>.intent.md`)
3. Use the intent file and your understanding of the codebase to resolve the conflict
4. Write the resolved file

After resolving all conflicts:

```bash
npx tsx scripts/post-update.ts
```

This clears the backup, confirming the resolution.

**If you cannot confidently resolve a conflict:** Show the user the conflicting sections and ask them to choose or provide guidance.

## 7. Run migrations

Run migrations between the old and new versions:

```bash
npx tsx scripts/run-migrations.ts <CURRENT_VERSION> <NEW_VERSION> <TEMP_DIR>
```

Parse the JSON output. It contains: `migrationsRun` (count), `results` (array of `{version, success, error?}`).

**If any migration fails:** Show the error to the user. The update itself is already applied — the migration failure needs manual attention.

**If no migrations found:** This is normal (most updates won't have migrations). Continue silently.

## 8. Verify

Run build and tests:

```bash
npm run build && npm test
```

**If build fails:** Show the error. Common causes:
- Type errors from merged files — read the error, fix the file, retry
- Missing dependencies — run `npm install` first, retry

**If tests fail:** Show which tests failed. Try to diagnose and fix. If you can't fix automatically, report to the user.

**If both pass:** Report success.

## 9. Cleanup

Remove the temp directory:

```bash
rm -rf <TEMP_DIR>
```

Report final status:
- "Updated from **{previousVersion}** to **{newVersion}**"
- Number of files changed
- Any warnings (failed custom patches, failed skill tests, migration issues)
- Build and test status

## Troubleshooting

**No upstream remote:** The fetch script auto-adds `upstream` pointing to `https://github.com/qwibitai/nanoclaw.git`. If the user forked from a different URL, they should set the remote manually: `git remote add upstream <url>`.

**Merge conflicts in many files:** Consider whether the user has heavily customized core files. Suggest using the skills system for modifications instead of direct edits, as skills survive updates better.

**Build fails after update:** Check if `package.json` dependencies changed. Run `npm install` to pick up new dependencies.

**Rollback:** If something goes wrong after applying but before cleanup, the backup is still in `.nanoclaw/backup/`. Run:
```bash
npx tsx -e "import { restoreBackup, clearBackup } from './skills-engine/backup.js'; restoreBackup(); clearBackup();"
```
