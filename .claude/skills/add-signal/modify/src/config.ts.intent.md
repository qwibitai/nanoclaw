# Intent: add Signal config exports

Append two new exports to src/config.ts after the existing MARMOT_* exports:

- `SIGNAL_PHONE_NUMBER` — the phone number registered with signal-cli (e.g. "+15551234567")
- `SIGNAL_SOCKET_PATH` — path to the signal-cli daemon Unix socket inside the container
  (default: /run/signal-cli/socket — mount the host socket at this path)

Both read from environment variables first, then envConfig, then fall back to defaults.
No new imports required — `envConfig` is already available in scope.
