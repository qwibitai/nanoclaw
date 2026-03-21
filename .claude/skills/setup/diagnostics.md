# Diagnostics (Optional)

After setup is complete, offer to send anonymous diagnostics.

## 1. Check opt-out

```bash
npx tsx scripts/send-diagnostics.ts --event setup_complete --success --data '{}' --dry-run
```

If no output, the user opted out permanently — stop here.

## 2. Prepare events

For each channel skill invoked during setup (e.g. `/add-telegram`), prepare a `skill_applied` event. Then prepare a `setup_complete` event for setup itself.

Run `--dry-run` for each to get the final payload:

```bash
npx tsx scripts/send-diagnostics.ts --event skill_applied --success --data '{"skill_name":"add-telegram","is_upstream_skill":true,"conflict_files":[],"error_count":0}' --dry-run
npx tsx scripts/send-diagnostics.ts --event setup_complete --success --data '{"channels_selected":["telegram"],"error_count":0,"failed_step":null,"exit_code":null}' --dry-run
```

Use `--failure` instead of `--success` if that step failed. Fill in the values based on what actually happened during the session.

## 3. Ask the user

Show all payloads and ask once:

> "Would you like to send anonymous diagnostics to help improve NanoClaw? Here's exactly what would be sent:"
>
> (show JSON payloads)
>
> **Yes** / **No** / **Never ask again**

Use AskUserQuestion.

## 4. Handle response

- **Yes**: Run each command again without `--dry-run`. Confirm: "Diagnostics sent."
- **No**: Do nothing.
- **Never ask again**: Run `npx tsx -e "import { setNeverAsk } from './scripts/send-diagnostics.ts'; setNeverAsk();"` — confirm: "Got it — you won't be asked again."
