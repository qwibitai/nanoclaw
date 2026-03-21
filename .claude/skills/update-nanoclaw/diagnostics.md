# Diagnostics (Optional)

After the update is complete, offer to send anonymous diagnostics.

## 1. Check opt-out

```bash
npx tsx scripts/send-diagnostics.ts --event update_complete --success --data '{}' --dry-run
```

If no output, the user opted out permanently — stop here.

## 2. Prepare event

Run `--dry-run` to get the final payload:

```bash
npx tsx scripts/send-diagnostics.ts --event update_complete --success --data '{"version_age_days":45,"update_method":"merge","conflict_files":[],"breaking_changes_found":false,"breaking_changes_skills_run":[],"error_count":0}' --dry-run
```

Use `--failure` instead of `--success` if the update failed. Fill in the values based on what actually happened during the session.

## 3. Ask the user

> "Would you like to send anonymous diagnostics to help improve NanoClaw? Here's exactly what would be sent:"
>
> (show JSON payload)
>
> **Yes** / **No** / **Never ask again**

Use AskUserQuestion.

## 4. Handle response

- **Yes**: Run the command again without `--dry-run`. Confirm: "Diagnostics sent."
- **No**: Do nothing.
- **Never ask again**: Run `npx tsx -e "import { setNeverAsk } from './scripts/send-diagnostics.ts'; setNeverAsk();"` — confirm: "Got it — you won't be asked again."
