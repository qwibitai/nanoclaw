# Signal Channel Reference

This document covers architecture, security considerations, and advanced features for the Signal channel. For installation, see the `/add-signal` skill.

## Architecture

NanoClaw uses a **Channel abstraction** (`Channel` interface in `src/types.ts`). Each messaging platform implements this interface.

| File | Purpose |
|------|---------|
| `src/types.ts` | `Channel` interface definition |
| `src/channels/signal.ts` | `SignalChannel` class |
| `src/signal/client.ts` | WebSocket (receiving) and REST (sending) client |
| `src/signal/daemon.ts` | Spawns local signal-cli daemon (not used with sidecar) |
| `src/router.ts` | `findChannel()`, `routeOutbound()`, `formatOutbound()` |
| `src/index.ts` | Orchestrator: creates channels, wires callbacks, starts subsystems |

The Signal channel follows the same pattern as WhatsApp and Telegram:
- Implements `Channel` interface (`connect`, `sendMessage`, `ownsJid`, `disconnect`, `setTyping`)
- Delivers inbound messages via `onMessage` / `onChatMetadata` callbacks
- The existing message loop in `src/index.ts` picks up stored messages automatically

## Security Considerations

### Trust Model

The signal-cli-rest-api container exposes an **unauthenticated HTTP API** on localhost. This is a deliberate design choice by the upstream project; authentication is expected to be handled externally if needed.

What this means:
- Any process running on the host can send messages via `curl http://localhost:8080/...`
- Any process can read incoming messages via the WebSocket endpoint
- The API provides full access to the linked Signal account

| Scenario | Can access? |
|----------|-------------|
| Your user account processes | Yes |
| Other users on a shared system | Yes (same localhost) |
| Remote network attackers | No (bound to 127.0.0.1) |
| Malware running as your user | Yes |

For a **single-user macOS machine**, this is generally acceptable. The localhost binding prevents remote access, and any malware with local access could likely compromise Signal through other means anyway.

**WebSocket transport**: NanoClaw connects to signal-cli via WebSocket (`ws://`) which is unencrypted. However, this connection is localhost-only and never leaves your machine. The Signal Protocol's end-to-end encryption happens inside signal-cli, so messages to/from Signal's servers are always encrypted regardless of the local transport.

For **multi-user systems or higher-security deployments**, consider adding authentication via a reverse proxy.

### Key Material Protection

The signal-cli data directory contains cryptographic keys that provide full access to your linked Signal account. Protect this directory:

**Apple Container (bind mount):**
```bash
chmod 700 ~/.local/share/signal-cli-container
```

**Docker (named volume):**
Docker volumes are owned by root and not directly accessible, but anyone with Docker socket access can mount and read them.

**Backup security:** Backups of this directory contain the same sensitive key material. Store backups encrypted and restrict access.

### Hardening (Optional)

For deployments requiring authentication, two options exist:

**Option 1: Reverse proxy with authentication**

Add nginx, Caddy, or Traefik in front of the signal-cli container with Basic Auth or OAuth. The config must handle both HTTP requests (for sending) and WebSocket connections (for receiving):

```nginx
location /signal-api/ {
    auth_basic "Signal API";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://127.0.0.1:8080/;

    # WebSocket support (required for receiving messages)
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

Then update `SIGNAL_HTTP_HOST` and `SIGNAL_HTTP_PORT` to point to your proxy, and modify `src/signal/client.ts` to include authentication headers.

**Option 2: Use secured-signal-api wrapper**

The [secured-signal-api](https://github.com/CodeShellDev/secured-signal-api) project wraps signal-cli-rest-api with:
- Bearer, Basic, or query-based authentication
- Configurable rate limiting
- Endpoint restrictions (block sensitive endpoints like `/v1/qrcodelink`)
- IP filtering

This requires modifying NanoClaw to send authentication headers with each request.

### Agent Isolation

The NanoClaw orchestrator acts as a trust boundary between agent containers and the Signal API. Agents communicate via IPC files, not directly to signal-cli. This means:

- A compromised agent can request the orchestrator to send messages (by design)
- A compromised agent cannot directly access signal-cli or bypass the orchestrator
- The container around signal-cli isolates its attack surface (Java runtime, native libraries) from the host

The primary access control is **chat registration**. Only messages to/from registered chats are processed. The `SIGNAL_ALLOW_FROM` filter provides an additional layer within registered chats.

## Rate Limiting

Signal enforces strict anti-spam measures. Violations can result in:
- CAPTCHA challenges (requires manual completion on Signal Desktop)
- Temporary sending restrictions
- In severe cases, account suspension

**Best practices:**
- Avoid adding the bot to high-traffic groups
- Don't send bulk messages in rapid succession
- If rate limited, wait several hours before retrying
- CAPTCHA completion only helps future sends; already-failed messages are not retried automatically

**Recovery from rate limiting:**
1. Wait several hours (rate limits typically clear within 2-4 hours)
2. If prompted, complete the CAPTCHA challenge in Signal Desktop (Settings > Help > Troubleshooting > Request Account Data)
3. Already-failed messages are not automatically retried

**Prevention:**
- Avoid high-traffic groups where the bot might receive many messages
- Add delays between bulk sends (1-2 seconds per message)
- Consider implementing client-side rate limiting in `src/signal/client.ts`

## Extended Features

Signal-specific capabilities available to the `SignalChannel` class:

| Feature | Description |
|---------|-------------|
| Styled text | `*italic*`, `**bold**`, `~strikethrough~`, `` `monospace` ``, `\|\|spoiler\|\|` |
| Polls | Create, close, and track polls |
| Reactions | Add/remove emoji reactions to messages |
| Message deletion | Remote delete messages for everyone |
| Attachments | Send base64-encoded file attachments |
| Quotes | Reply to specific messages with quoted context |
| Mentions | @mention users in messages |
| Read receipts | Send read/viewed receipts |
| Typing indicators | Show typing status |

### Poll Support

```typescript
// Create a poll
const pollTimestamp = await signal.createPoll(jid, "What's for dinner?", ["Pizza", "Tacos", "Sushi"], true);

// Close a poll
await signal.closePoll(jid, pollTimestamp);
```

## Chat ID Formats

| Platform | Groups | DMs |
|----------|--------|-----|
| WhatsApp | `120363336345536173@g.us` | `1234567890@s.whatsapp.net` |
| Telegram | `tg:-1001234567890` (negative) | `tg:123456789` (positive) |
| Signal | `signal:group:<groupId>` | `signal:<phoneNumber>` |

## Troubleshooting

### Rate limiting

If you see HTTP 413, 429, or "rate limit" errors in the logs, the account is being throttled.

**Symptoms:**
- Messages fail to send with 4xx errors
- CAPTCHA challenge appears in Signal Desktop
- "Unable to send" errors in signal-cli logs

**Common causes:**
- Sending too many messages in quick succession
- Bot added to high-traffic groups
- Bulk operations (notifying many users)

### WebSocket connection failures

1. Verify signal-cli container is healthy: `curl http://localhost:8080/v1/health`
2. Verify the container is running in `json-rpc` mode: `curl http://localhost:8080/v1/about` should show `"mode":"json-rpc"`
3. Check `SIGNAL_HTTP_HOST` is set to `127.0.0.1` (for host-based NanoClaw) or the container name (if NanoClaw runs inside the container network)
4. The WebSocket connection auto-reconnects after 5 seconds on failure, so transient disconnects recover automatically
5. If you see "Signal SSE failed (404 Not Found)" errors, the container may be running in `native` mode instead of `json-rpc` mode. Recreate the container with `MODE=json-rpc`.

### Messages not sending to a group

Some Signal groups have admin-only messaging or other permission restrictions. If the bot can receive messages from a group but fails to send:

1. Check NanoClaw logs for send errors: `grep -i "signal.*error\|failed to send" logs/nanoclaw.log`
2. Verify the linked account has permission to send in that group (check group settings in Signal on your phone)
3. If the group is admin-only, make the linked account an admin

### Keeping signal-cli updated

Signal's servers require compatible client versions. The signal-cli-rest-api image should be updated every 2-3 months to maintain compatibility. Check the [GitHub releases](https://github.com/bbernhard/signal-cli-rest-api/releases) for new versions.

**Docker:**
```bash
docker compose pull signal-cli && docker compose up -d signal-cli
```

**Apple Container:**
```bash
container pull bbernhard/signal-cli-rest-api:<new-version>
container stop signal-cli && container rm signal-cli
# Re-run the container run command with the new version tag
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SIGNAL_ACCOUNT` | Your phone number (E.164 format: +61412345678) | Required |
| `SIGNAL_HTTP_HOST` | Daemon HTTP host | `127.0.0.1` |
| `SIGNAL_HTTP_PORT` | Daemon HTTP port | `8080` |
| `SIGNAL_SPAWN_DAEMON` | Set to `0` for external daemon (container sidecar) | `1` (spawn locally) |
| `SIGNAL_CLI_PATH` | Path to signal-cli binary (only if spawning locally) | `signal-cli` |
| `SIGNAL_ALLOW_FROM` | Comma-separated allowed phone numbers | Empty (allow all) |
| `SIGNAL_ONLY` | `true` to disable WhatsApp | `false` |
