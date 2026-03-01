# Intent: src/config.ts modifications

## What changed
Added `FEISHU_ONLY` flag to support running Feishu as the sole channel (replacing WhatsApp).

## Key sections

### readEnvFile call
Must include `'FEISHU_ONLY'` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.

### FEISHU_ONLY
Boolean config: when `true`, WhatsApp is not started and Feishu is the only channel. Same pattern as `TELEGRAM_ONLY` and `SLACK_ONLY`.

```typescript
export const FEISHU_ONLY = (process.env.FEISHU_ONLY || envConfig.FEISHU_ONLY) === 'true';
```

### Security note
`FEISHU_APP_ID` and `FEISHU_APP_SECRET` are NOT read here. They are read directly by `FeishuChannel` via `readEnvFile()` in `channels/feishu.ts` to keep secrets off the config module (same pattern as `SLACK_BOT_TOKEN` in `channels/slack.ts`).

## Invariants
- All existing config exports remain unchanged
- `FEISHU_ONLY` is added to the `readEnvFile` call alongside existing keys
- The new export is appended at the end of the file, near the other `*_ONLY` flags
- No existing behavior is modified — Feishu config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `TELEGRAM_ONLY`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, `TELEGRAM_ONLY`, `SLACK_ONLY`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
