# Intent for src/config.ts

Add Feishu configuration exports.

## Changes

1.  Add `FEISHU_APP_ID` and `FEISHU_APP_SECRET` to `readEnvFile` call.
2.  Export `FEISHU_APP_ID` and `FEISHU_APP_SECRET` constants at the end of the file.

## Invariants

- Keep existing exports.
- Keep `readEnvFile` usage.
