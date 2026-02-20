Adds gateway/channel configuration for Slack while preserving WhatsApp defaults.

Key invariants:
- `GATEWAY_CHANNEL` defaults to `whatsapp`.
- Slack secrets are read from `.env`/process env only.
- Existing trigger and container config semantics are unchanged.
