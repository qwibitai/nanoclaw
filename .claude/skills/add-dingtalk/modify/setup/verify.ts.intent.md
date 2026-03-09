# Intent: Detect DingTalk credentials in setup verification

Extend `setup/verify.ts` so NanoClaw's verification step reports DingTalk as
configured when both `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET` are
present.

## Invariants

- Existing service/runtime checks remain unchanged.
- Existing channel detection for WhatsApp, Telegram, Slack, and Discord remains unchanged.
- DingTalk is treated like other token-based channels: only credentials are checked here.
