---
name: add-peer-api
description: Connect two NanoClaw instances so their agents can exchange messages and structured data directly over HTTP, without a third-party broker. Each instance runs a lightweight HTTP server; agents use peer_send and peer_list MCP tools to communicate.
---

# Add Peer API

This skill adds direct NanoClaw-to-NanoClaw communication. Each configured instance runs an HTTP server on `PEER_API_PORT`. Agents get two MCP tools — `peer_list` to check which peers are reachable, and `peer_send` to send messages or structured JSON to a named peer.

Messages travel in both directions: when peer A's agent calls `peer_send("bob", content)`, the message arrives at peer B's NanoClaw and is delivered to a dedicated peer group where B's agent processes it. B's agent can reply with its own `peer_send`.

## Phase 1: Pre-flight

Check if the peer channel is already installed:

```bash
grep -q 'peer' src/channels/index.ts && echo "already installed" || echo "not installed"
```

If already installed, skip to Phase 2 (Configure).

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/peer-api
git merge upstream/skill/peer-api
```

### Validate

```bash
npm install
npm run build
```

Build must be clean before continuing.

## Phase 3: Configure

You need values for **both** NanoClaw instances. Set these in each instance's `.env`:

**Instance A (e.g. local Mac):**

```bash
PEER_NAME=alice
PEER_API_PORT=7843
PEER_API_TOKEN=<shared-secret>
PEER_TARGETS=bob=https://<vps-host>:7843
```

**Instance B (e.g. VPS):**

```bash
PEER_NAME=bob
PEER_API_PORT=7843
PEER_API_TOKEN=<same-shared-secret>
PEER_TARGETS=alice=https://<mac-host>:7843
```

**Rules:**
- `PEER_NAME` — a short lowercase identifier for this instance (e.g. `alice`, `home`, `vps`)
- `PEER_API_PORT` — TCP port to listen on. Open it in your firewall/security group.
- `PEER_API_TOKEN` — a strong random secret shared across all peers in the cluster. Generate with: `openssl rand -hex 32`
- `PEER_TARGETS` — comma-separated `name=url` pairs. Use `https://` when the peer is on the public internet.

### Firewall

The peer HTTP server binds to `0.0.0.0`. Ensure `PEER_API_PORT` (default 7843) is reachable from peer machines. On cloud VMs, add a security group/firewall rule.

For production use, put a TLS reverse proxy (nginx, Caddy) in front and use `https://` URLs in `PEER_TARGETS`.

### Sync env to containers

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Build and Restart

```bash
npm run build
./container/build.sh
```

Restart the service:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

Repeat on both instances.

## Phase 5: Verify

### Check the peer server is up

From the other machine (or via curl):

```bash
curl http://<peer-host>:7843/peer/health
# Expected: {"ok":true,"name":"alice"}
```

### Test from a group chat

Ask your agent:

> "Use peer_list to check which peers are online, then send 'hello from alice' to bob using peer_send."

On bob's side, check that a message arrives in the `peer_alice` group.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep PEER
```

Look for:
- `[PEER] Server listening on port 7843` — server started
- `[PEER] Inbound message from alice` — message received
- `[PEER] Sending message to bob` — message sent

## How It Works

Each NanoClaw instance:
1. Runs an HTTP server on `PEER_API_PORT` (bound to `0.0.0.0`)
2. Auto-provisions a registered group for each configured peer (e.g. `peer_bob`)
3. Routes inbound `POST /peer/message` requests to that group's agent
4. Outbound `sendMessage("peer_bob@nanoclaw", text)` POSTs to bob's HTTP server

Agents get two MCP tools:
- **`peer_list`** — lists configured peers and checks `/peer/health` on each
- **`peer_send(name, content)`** — sends text or JSON string to a named peer

The `content` field supports any string — pass `JSON.stringify(data)` for structured payloads.

## Troubleshooting

**`[PEER] Port already in use`** — another process is on PEER_API_PORT. Change `PEER_API_PORT` or stop the conflicting process.

**`peer_send` returns HTTP 401** — `PEER_API_TOKEN` doesn't match between the two instances. Verify both `.env` files have the same token and restart.

**`peer_send` returns timeout** — the peer is unreachable. Check: firewall rules, correct URL in `PEER_TARGETS`, peer service is running.

**Agent doesn't have peer tools** — `PEER_TARGETS` wasn't set when the container started. Rebuild the container (`./container/build.sh`) and restart.

**Peer group doesn't appear** — `PEER_NAME` and `PEER_API_TOKEN` must both be set for the peer channel to activate. Check `.env` and restart.
