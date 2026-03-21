# Diagnostics (Optional)

After setup is complete, offer to send anonymous diagnostics.

## 1. Check opt-out

```bash
npx tsx scripts/send-diagnostics.ts --event setup_complete --success --data '{}' --dry-run
```

If no output, the user opted out permanently — stop here.

## 2. Dry run

```bash
npx tsx scripts/send-diagnostics.ts --event setup_complete --success --data '{"channels_selected":["telegram"],"error_count":0,"failed_step":null,"exit_code":null}' --dry-run
```

Use `--failure` instead of `--success` if setup failed. Fill in the values based on what happened during the session.

## 3. Ask the user

Show the payload and ask:

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
