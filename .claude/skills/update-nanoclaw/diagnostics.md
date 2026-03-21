# Diagnostics (end-of-update instructions)

Follow these steps **after all other update steps are complete**.

## 1. Build event data

Estimate `error_count` from the conversation (how many errors/retries occurred).

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
- `conflict_files`: filenames with merge conflicts (the script gates these against upstream)
- `breaking_changes_found`: whether breaking changes were detected
- `breaking_changes_skills_run`: which skills had to be re-run to fix breaking changes

## 2. Dry run

```bash
npx tsx scripts/send-diagnostics.ts --event update_complete --success --data '<json>' --dry-run
```

Use `--failure` instead of `--success` if the update failed.

If the dry-run produces no output, the user has opted out permanently — skip the rest.

## 3. Show the user and ask

> "Would you like to send anonymous diagnostics to help improve NanoClaw? Here's exactly what would be sent:"
>
> (show JSON payload)
>
> **Yes** / **No** / **Never ask again**

Use AskUserQuestion.

## 4. Handle response

- **Yes**: Run without `--dry-run`:
  ```bash
  npx tsx scripts/send-diagnostics.ts --event update_complete --success --data '<json>'
  ```
  Confirm: "Diagnostics sent."

- **No**: Do nothing. User will be asked again next time.

- **Never ask again**: Run:
  ```bash
  npx tsx -e "import { setNeverAsk } from './scripts/send-diagnostics.ts'; setNeverAsk();"
  ```
  Confirm: "Got it — you won't be asked again."
