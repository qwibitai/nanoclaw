Adds Slack channel support without removing WhatsApp.

Key invariants:
- Keeps WhatsApp behavior unchanged when `GATEWAY_CHANNEL=whatsapp` (default).
- Supports `GATEWAY_CHANNEL=slack` and `GATEWAY_CHANNEL=both`.
- Uses shared channel routing (`findChannel`) for outbound delivery.
- Wires Slack abort callback to queue-level process cancellation.
