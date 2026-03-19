# Diagnostics (end-of-skill instructions)

Follow these steps **after all other skill steps are complete**.

## 1. Skip check

If this skill was invoked from within another skill (e.g., `/add-whatsapp` called during `/setup`), **skip diagnostics entirely** — the parent skill handles it. Return without doing anything below.

## 2. Determine event type

- `/setup` → `setup_complete`
- `/update-nanoclaw` → `update_complete`
- Any other skill → `skill_applied`

## 3. Build event-specific data

Estimate `error_count` from the conversation (how many errors/retries occurred during the run).

**For `setup_complete`:**
```json
{
  "channels_selected": ["whatsapp", "telegram"],
  "error_count": 0,
  "failed_step": null,
  "exit_code": null
}
```
- `channels_selected`: which channels the user chose to install
- `failed_step`: if setup failed, which step (environment / container / groups / register / mounts / service / verify)
- `exit_code`: if a step failed, its exit code

**For `skill_applied`:**
```json
{
  "skill_name": "add-telegram",
  "is_upstream_skill": true,
  "conflict_files": ["package.json", "src/index.ts"],
  "error_count": 0
}
```
- `skill_name`: the skill that was run. Use the upstream skill name if it's an upstream skill, otherwise use `"custom"`
- `is_upstream_skill`: true if this is a known upstream skill
- `conflict_files`: filenames that had merge conflicts (the script will gate these against upstream — pass them all, the script filters)

**For `update_complete`:**
```json
{
  "version_age_days": 45,
  "update_method": "merge",
  "conflict_files": ["package.json"],
  "breaking_changes_found": false,
  "breaking_changes_skills_run": [],
  "error_count": 0
}
```
- `version_age_days`: estimate from the backup tag or commit date how many days old the previous version was
- `update_method`: "merge" or "rebase"
- `breaking_changes_found`: whether breaking changes were detected during the update
- `breaking_changes_skills_run`: which skills had to be re-run to fix breaking changes

## 4. Dry run

Run with `--dry-run` to get the full payload:

```bash
npx tsx scripts/send-diagnostics.ts --event <event_type> --success --data '<json>' --dry-run
```

Use `--failure` instead of `--success` if the skill failed.

If the command produces no output, the user has opted out permanently — skip the rest.

## 5. Show the user and ask

Show the JSON output and ask:

> "Would you like to send anonymous diagnostics to help improve NanoClaw? Here's exactly what would be sent:"
>
> (show the JSON)
>
> **Yes** / **No** / **Never ask again**

Use AskUserQuestion.

## 6. Handle response

- **Yes**: Run the same command without `--dry-run`:
  ```bash
  npx tsx scripts/send-diagnostics.ts --event <event_type> --success --data '<json>'
  ```
  Confirm: "Diagnostics sent."

- **No**: Do nothing. User will be asked again next time.

- **Never ask again**: Run:
  ```bash
  npx tsx -e "import { setNeverAsk } from './scripts/send-diagnostics.ts'; setNeverAsk();"
  ```
  Confirm: "Got it — you won't be asked again."
