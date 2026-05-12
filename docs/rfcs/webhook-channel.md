# RFC: webhook channel type — push-based inbound from Supabase, GitHub Actions, and other producers

## Problem

Distill's field-notes pipeline needs to wake Skippy on Supabase row inserts (~1s latency, not 60s cron). NanoClaw already handles inbound webhooks for Telegram and Slack via the messaging-group adapter layer, but there is no first-class channel type for arbitrary producers. This RFC proposes a `webhook` channel type that exposes a stable, authenticated inbound URL per messaging group.

## Proposed solution

A new `webhook` channel type. Each webhook messaging group gets its own URL:

```
POST https://<nanoclaw-public>/v1/inbound/webhook/<messaging_group_id>
```

The adapter validates auth, parses the body, and enqueues the payload as a standard `InboundEvent` on the wired agent's session.

## Full call path (worked example)

```
Supabase Edge Function
  → POST https://<base>/v1/inbound/webhook/<mg-id>
    body:   {"q": "field_notes"}
    header: Authorization: Bearer <secret>

↓ adapter validates secret, checks body size (≤16 KB), applies rate limit
↓ enqueues InboundEvent:
    {
      channelType: "webhook",
      platformId:  "webhook:<mg-id>",
      threadId:    null,
      message: {
        from:    "distill-field-notes",   // local name of the webhook destination
        body:    "{\"q\":\"field_notes\"}", // raw POST body, agent parses
        replyTo: "slack-dm"               // resolved from default_reply_destination config
      }
    }

↓ agent wakes, parses body, fetches unclaimed Distill rows, summarizes
↓ agent sends summary to replyTo ("slack-dm" destination)
```

If `default_reply_destination` is unset and no most-recently-active channel exists (fresh agent group), `replyTo` is `null`. The inbound is still queued — the agent decides what to do. One-way notifier flows work fine without a reply target.

## Schema

New migration: `webhook_configs` table, joined on `messaging_group_id`.

```sql
CREATE TABLE webhook_configs (
  messaging_group_id      TEXT PRIMARY KEY REFERENCES messaging_groups(id) ON DELETE CASCADE,
  secret                  TEXT NOT NULL,           -- bearer token or HMAC key
  auth_mode               TEXT NOT NULL DEFAULT 'bearer', -- 'bearer' | 'hmac-sha256'
  body_format             TEXT NOT NULL DEFAULT 'json',   -- 'json' | 'raw'
  default_reply_destination TEXT,                  -- local destination name; NULL = no default
  rate_limit_per_min      INTEGER NOT NULL DEFAULT 60,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
```

`messaging_groups` schema is unchanged — no new columns. Webhook-specific config lives entirely in `webhook_configs`.

## Auth

**Default: bearer.** Header: `Authorization: Bearer <secret>`. Simple, Supabase-native, low producer friction.

**Optional: HMAC-SHA256.** Header: `X-Webhook-Signature: sha256=<hex>`. Signature is `HMAC-SHA256(body, secret)`. Use for GitHub-style producers that already compute signatures. Configured per-group via `auth_mode`.

Secret rotation: `ncl messaging-groups rotate-secret --id <mg-id>` regenerates the secret. Old secret is immediately invalidated.

## Rate limiting

In-memory token bucket per `messaging_group_id`. Default: 60 req/min, configurable per-group. Returns `429 Too Many Requests` when exceeded. Resets on daemon restart (acceptable for our use case; persistent rate limiting is a future concern).

## Request constraints

- Body cap: 16 KB. Returns `413 Content Too Large` if exceeded.
- Method: POST only. Others → `405`.
- `body_format: json` — body is parsed and re-serialized as the message content. Invalid JSON → `400`.
- `body_format: raw` — body forwarded as-is. No parse step.

## ncl surface

### Create a webhook messaging group

```
ncl messaging-groups create \
  --channel-type webhook \
  --name "Distill field-notes ingress"
```

Output (shown once; secret not recoverable after creation — rotate to get a new one):

```json
{
  "messaging_group_id": "mg-...",
  "url": "https://<nanoclaw_public_base>/v1/inbound/webhook/mg-...",
  "secret": "<generated>",
  "auth_mode": "bearer"
}
```

If `nanoclaw_public_base` is not configured:

```
error: nanoclaw_public_base is not set. Configure it first:
  ncl config set nanoclaw_public_base https://your-tunnel-url
This is the same public URL used for Telegram and Slack webhooks.
```

### Rotate secret

```
ncl messaging-groups rotate-secret --id <mg-id>
```

Returns new secret. Old secret immediately invalid.

### Wire to agent (unchanged from existing flow)

```
ncl wirings create \
  --messaging-group-id <mg-id> \
  --agent-group-id <ag-id>
```

## Implementation deviations from existing adapter pattern

Existing webhook adapters (Slack, Telegram) register via `registerWebhookAdapter(chat, adapterName)`, which routes `/webhook/{adapterName}` to the owning Chat SDK `chat` instance. The webhook channel type cannot use this model because:

1. Routing is per-messaging-group (`/v1/inbound/webhook/:mgId`), not per-adapter-name.
2. There is no Chat SDK adapter — the webhook adapter talks directly to the NanoClaw router, bypassing the Chat SDK layer entirely.

**Implementation:** a separate request handler registered on the shared `http.Server` alongside the existing `/webhook/{adapterName}` routes. The handler does: path parse → mg lookup → `webhook_configs` lookup → auth → rate limit → body size check → parse → `routeInbound()`. No Chat SDK involvement.

## Public URL prerequisite

The inbound URL requires public reachability. Jesse's Mac mini already exposes port 3000 via a tunnel (used for Telegram/Slack webhooks). The webhook channel piggybacks on that tunnel. The `nanoclaw_public_base` config value is the same base URL used for Telegram/Slack event subscriptions.

Operator is responsible for setting up and maintaining the public URL — same as Telegram bot webhook setup.

## Out of scope for this PR

- `webhook_logs` table — adapter-level logging + rejection reason in response body is sufficient for debugging. Add later if needed.
- Persistent rate limiting — in-memory token bucket resets on daemon restart. Acceptable for low-volume Distill use case.
- Upstream PR to `nanocoai/nanoclaw` — fork-local only. This is too feature-specific for upstream.

## Implementation checklist

- [ ] Migration: `webhook_configs` table
- [ ] `nanoclaw_public_base` config key (read from env or NanoClaw config)
- [ ] `/v1/inbound/webhook/:mgId` handler in `src/webhook-server.ts`
- [ ] `src/channels/webhook.ts` — thin adapter shim (registers channel type, delegates to handler)
- [ ] `ncl messaging-groups create` — extend to support `--channel-type webhook`
- [ ] `ncl messaging-groups rotate-secret` — new verb
- [ ] Rate limiter (in-memory, per-mg)
- [ ] Tests: auth rejection (wrong secret), body size cap, rate limit, happy path enqueue
