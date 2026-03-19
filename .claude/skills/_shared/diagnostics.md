# Diagnostics (end-of-skill instructions)

Follow these steps **after all other skill steps are complete**.

## 1. Collect all events

Every skill sends its own diagnostics event — even when invoked from a parent skill. A `/setup` that invokes `/add-telegram` produces **two** events: `skill_applied` (for add-telegram) and `setup_complete` (for setup). A `/setup` with no channels produces just `setup_complete`.

Build the list of events to send:

1. If sub-skills were invoked during this run (e.g., `/add-telegram` during `/setup`), add a `skill_applied` event for each.
2. Add the event for the current (outermost) skill.

**If running a sub-skill standalone** (not called from a parent), there is just one event.

## 2. Determine event type (for each event)

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

## 4. Dry run all events

For **each** event, run with `--dry-run` to get the payload:

```bash
npx tsx scripts/send-diagnostics.ts --event <event_type> --success --data '<json>' --dry-run
```

Use `--failure` instead of `--success` if that particular skill/step failed.

If **any** dry-run produces no output, the user has opted out permanently — skip the rest for all events.

## 5. Show the user and ask once

Show **all** payloads together and ask **once** (not per-event):

> "Would you like to send anonymous diagnostics to help improve NanoClaw? Here's exactly what would be sent:"
>
> (show all JSON payloads)
>
> **Yes** / **No** / **Never ask again**

Use AskUserQuestion.

## 6. Handle response

- **Yes**: Send **all** events (run each command without `--dry-run`):
  ```bash
  npx tsx scripts/send-diagnostics.ts --event <event_type> --success --data '<json>'
  ```
  Confirm: "Diagnostics sent (N events)." or "Diagnostics sent." if only one.

- **No**: Do nothing. User will be asked again next time.

- **Never ask again**: Run:
  ```bash
  npx tsx -e "import { setNeverAsk } from './scripts/send-diagnostics.ts'; setNeverAsk();"
  ```
  Confirm: "Got it — you won't be asked again."
