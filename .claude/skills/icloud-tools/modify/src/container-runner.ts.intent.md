# Intent: src/container-runner.ts modifications

## What changed
Added iCloud credentials to the secrets allowlist passed to containers via stdin.

## Key sections
### readSecrets() function
- Added `'ICLOUD_EMAIL'` — account email for CalDAV/CardDAV/IMAP auth
- Added `'ICLOUD_APP_PASSWORD'` — app-specific password (16-char)
- Added `'ICLOUD_SENDER_EMAIL'` — optional SMTP alias (from field)

## Invariants (must-keep)
- All existing secrets (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_*) unchanged
- buildVolumeMounts(), container spawn, timeout, streaming unchanged
- .env shadow mount for main group unchanged
