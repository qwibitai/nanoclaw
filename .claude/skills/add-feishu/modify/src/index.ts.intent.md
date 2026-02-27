# Intent for src/index.ts

Add Feishu channel initialization.

## Changes

1.  Import `FeishuChannel` from `./channels/feishu.js`.
2.  Import `FEISHU_APP_ID` and `FEISHU_APP_SECRET` from `./config.js`.
3.  In `main()` function, check if `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are present.
4.  If present, instantiate `FeishuChannel`, push to `channels` array, and call `connect()`.

## Invariants

- Keep existing WhatsApp initialization.
- Keep existing channel options and callbacks.
