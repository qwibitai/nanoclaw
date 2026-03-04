# Intent: Add NEW_GROUPS_USE_DEFAULT_CREDENTIALS config

## What changed
Added `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` to the env var reading list and
exported it as a boolean config value. Defaults to `true` (not 'false').

## Why
New groups need a configurable default for whether they can fall back to
the default scope credentials. This lets installations choose strict
per-group isolation.

## Key sections
- `readEnvFile` call: array expanded with the new key
- New export after `ASSISTANT_HAS_OWN_NUMBER`

## Invariants
- All existing exports unchanged
- The `readEnvFile` call still reads all previous keys
- `POLL_INTERVAL` and subsequent exports are not moved or changed
