# Diagnostics (end-of-setup instructions)

Follow these steps **after all other setup steps are complete**.

## 1. Collect events

Build the list of events to send:

1. If channel skills were invoked during setup (e.g., `/add-telegram`), add a `skill_applied` event for each.
2. Add a `setup_complete` event for setup itself.

A `/setup` with no channels produces just `setup_complete`.

## 2. Build event data

Estimate `error_count` from the conversation (how many errors/retries occurred).

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

**For each `skill_applied`:**
```json
{
  "skill_name": "add-telegram",
  "is_upstream_skill": true,
  "conflict_files": ["package.json", "src/index.ts"],
  "error_count": 0
}
```
- `skill_name`: upstream skill name, or `"custom"` for non-upstream skills
- `conflict_files`: filenames with merge conflicts (the script gates these against upstream)

## 3. Dry run all events

For **each** event, run with `--dry-run` to get the payload:

```bash
npx tsx scripts/send-diagnostics.ts --event <event_type> --success --data '<json>' --dry-run
```

Use `--failure` instead of `--success` if that particular skill/step failed.

If **any** dry-run produces no output, the user has opted out permanently — skip the rest.

## 4. Show the user and ask once

Show **all** payloads together and ask **once** (not per-event):

> "Would you like to send anonymous diagnostics to help improve NanoClaw? Here's exactly what would be sent:"
>
> (show all JSON payloads)
>
> **Yes** / **No** / **Never ask again**

Use AskUserQuestion.

## 5. Handle response

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
