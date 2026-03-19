# Intent: Add Signal verification support

Extend the verify step so NanoClaw recognizes Signal as a configured channel
when both `SIGNAL_BRIDGE_URL` and `SIGNAL_BRIDGE_TOKEN` are present.

## Invariants

- Existing verification behavior for WhatsApp, Telegram, Slack, and Discord must remain unchanged.
- Signal should only count as configured when both bridge URL and bearer token are set.
- The output shape of `emitStatus('VERIFY', ...)` must remain stable.
