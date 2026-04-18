# Paperclip integration

Nanoclaw can be woken by a [Paperclip](https://paperclip.ing) instance through
the built-in `http` adapter. When enabled, nanoclaw exposes a single endpoint
that Paperclip POSTs to whenever one of its agents needs to run on nanoclaw
(for example: a new task, a comment addressed to the agent, or a scheduled
routine firing).

This is the implementation for [FEDA-86][feda-86] (per ADR on [FEDA-85][feda-85]),
landing Option A from [FEDA-84][feda-84]: Paperclip's built-in `http` adapter
wakes a nanoclaw-hosted agent via an inbound webhook.

[feda-84]: https://paperclip.example.com/FEDA/issues/FEDA-84
[feda-85]: https://paperclip.example.com/FEDA/issues/FEDA-85
[feda-86]: https://paperclip.example.com/FEDA/issues/FEDA-86

## Endpoint

- `POST /paperclip/wake`
- Request: JSON body from the Paperclip `http` adapter
- Response: `202 Accepted` as soon as the wake is verified and queued; routing
  is performed asynchronously. Non-2xx statuses indicate the wake was
  rejected and Paperclip should surface the error on the run.

## Enabling the webhook

Nanoclaw leaves the webhook disabled unless `PAPERCLIP_WAKE_SECRET` is set.
Other knobs have safe defaults.

| Env var | Default | Description |
|---|---|---|
| `PAPERCLIP_WAKE_SECRET` | _(unset)_ | Shared secret. Setting it enables the server. Must match the value Paperclip uses when signing/bearing. |
| `PAPERCLIP_WAKE_HOST` | `127.0.0.1` | Interface to bind. Keep loopback unless you front it with a reverse proxy that terminates TLS and forwards. |
| `PAPERCLIP_WAKE_PORT` | `3002` | Port to bind. |
| `PAPERCLIP_WAKE_REPLAY_WINDOW_SECONDS` | `300` | Max allowed clock skew for HMAC-signed requests. Ignored for bearer auth. |

Production deployments should put the endpoint behind a reverse proxy that
handles TLS and, optionally, IP allow-listing — the webhook itself only does
auth and payload validation.

## Authentication

The endpoint accepts two modes and passes on whichever is valid:

### 1. Bearer token (works today)

```
Authorization: Bearer <PAPERCLIP_WAKE_SECRET>
```

This works with the Paperclip `http` adapter today — configure the adapter's
`headers` with an `Authorization` entry pointing at the shared secret. No
server-side Paperclip change needed.

### 2. HMAC signature (forward-compatible)

```
X-Paperclip-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
```

Where `v1 = hex(HMAC_SHA256(PAPERCLIP_WAKE_SECRET, f"{t}.{rawBody}"))` and
`|now - t| <= PAPERCLIP_WAKE_REPLAY_WINDOW_SECONDS`. The canonical string is
`${t}.${rawBody}` — identical to the Stripe scheme.

Paperclip's built-in `http` adapter does not yet sign requests; bearer is
the pragmatic path today. HMAC support on this side is already implemented
so that when the Paperclip `http` adapter grows per-request signing we can
switch without changing nanoclaw.

## Payload

The Paperclip `http` adapter sends, per
`paperclip/server/src/adapters/http/execute.ts`:

```jsonc
{
  "agentId": "...",
  "runId": "...",
  "context": {
    "taskId": "...",
    "issueId": "...",
    "wakeReason": "issue_assigned | issue_commented | ...",
    "wakeCommentId": "..."
    // plus any fields from the agent's payloadTemplate
  }
}
```

Nanoclaw additionally expects one of the following to be present so it can
route the wake to a registered group:

- `context.chatJid` — preferred. The full group JID (including suffix).
- `context.groupFolder` — nanoclaw group folder name. Used if `chatJid` is
  absent; the first registered group matching this folder wins.

Use the adapter's `payloadTemplate` to inject the routing field, e.g.:

```json
{
  "payloadTemplate": {
    "context": {
      "chatJid": "<main-group-jid>"
    }
  }
}
```

Nanoclaw deep-merges Paperclip's runtime `context` onto whatever is in
`payloadTemplate`, so the runtime fields (`wakeReason`, `taskId`, etc.)
always win over static template values.

## What happens on a wake

1. Verify auth (bearer or HMAC).
2. Parse JSON. Reject 400 on invalid payloads; reject 413 on bodies > 1 MiB.
3. Respond `202` with `{accepted, runId, agentId}`.
4. Asynchronously:
   - Write the full raw body to
     `data/ipc/<groupFolder>/paperclip-wakes/<ts>-<runId>.json`. The
     container mounts this directory at `/workspace/ipc/paperclip-wakes/`
     so the agent can read the full wake payload (including callback
     credentials if Paperclip supplies them via `payloadTemplate`).
   - Store a synthetic inbound message on the target group summarising
     the wake (`runId`, `agentId`, `wakeReason`, `taskId`, `commentId`) and
     enqueue the group for processing through the normal router.
   - For non-main groups the summary is prefixed with the group's trigger,
     so trigger-gated groups still react.

The agent, on waking, should use the `paperclip` skill and the wake file to
check out the task and continue the heartbeat.

## Smoke testing locally

Start nanoclaw with the secret set:

```bash
PAPERCLIP_WAKE_SECRET=dev-secret npm run dev
```

Fire a wake from another terminal (bearer):

```bash
curl -v -X POST http://127.0.0.1:3002/paperclip/wake \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev-secret' \
  -d '{
    "agentId":"unic",
    "runId":"run-smoke-1",
    "context":{
      "wakeReason":"issue_assigned",
      "taskId":"FEDA-86",
      "chatJid":"<your-main-group-jid>"
    }
  }'
```

Expected: `HTTP/1.1 202 Accepted`, nanoclaw logs `paperclip-wake: accepted`
then `paperclip-wake: routed to group`, and the target group's agent
container starts processing.

HMAC-signed variant:

```bash
BODY='{"agentId":"unic","runId":"run-smoke-2","context":{"chatJid":"<jid>"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac dev-secret -hex | awk '{print $2}')
curl -v -X POST http://127.0.0.1:3002/paperclip/wake \
  -H 'content-type: application/json' \
  -H "x-paperclip-signature: t=$TS,v1=$SIG" \
  -d "$BODY"
```

## Configuring Paperclip

On the Paperclip side, configure the agent's adapter as:

```json
{
  "adapterType": "http",
  "adapterConfig": {
    "url": "https://<your-nanoclaw-host>/paperclip/wake",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer <PAPERCLIP_WAKE_SECRET>"
    },
    "payloadTemplate": {
      "context": {
        "chatJid": "<target-group-jid>"
      }
    }
  }
}
```

No Paperclip server code change is required to land the webhook — this
matches the existing `http` adapter behaviour documented in
`paperclipai/docs/adapters/http.md` (the adapter POSTs
`{agentId, runId, context, ...payloadTemplate}` with static headers and
considers any 2xx a success).
