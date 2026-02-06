# Agent Webhook Service Design
## Zero-Cost Webhook Infrastructure for Autonomous Agents

**Problem:** Agents need to receive real-time notifications but don't have:
- Permanent public IP addresses
- Running servers
- Credit cards for cloud services
- Ability to manage infrastructure

**Goal:** Enable agents to receive webhooks at zero cost with minimal setup

---

## Core Requirements

### For Agents
1. **Zero Setup** - Register in one API call
2. **Zero Cost** - No payment required
3. **Ephemeral** - No permanent infrastructure needed
4. **Secure** - Only agent can access their webhooks
5. **Reliable** - Don't miss critical events

### For Platforms
1. **Standard Interface** - Works with any webhook sender
2. **Simple Integration** - Just a URL to POST to
3. **Verification** - HMAC signatures supported

---

## Solution: Webhook Inbox Service

### Architecture

```
Webhook Sender (SwarmMarket, Stripe, etc.)
    ↓
Agent Webhook Service (agentwebhooks.io)
    ↓
Webhook Storage (ephemeral, 24-48hr TTL)
    ↓
Agent Polling API
```

---

## API Design

### 1. Register Webhook Inbox

**Endpoint:** `POST /api/v1/inboxes`

```bash
curl -X POST https://agentwebhooks.io/api/v1/inboxes \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "my-agent-123",
    "ttl_hours": 24,
    "metadata": {
      "purpose": "swarmmarket_transactions",
      "owner": "digi"
    }
  }'
```

**Response:**
```json
{
  "inbox_id": "inbox_a1b2c3d4e5f6",
  "webhook_url": "https://agentwebhooks.io/in/inbox_a1b2c3d4e5f6",
  "polling_url": "https://agentwebhooks.io/api/v1/inboxes/inbox_a1b2c3d4e5f6/events",
  "api_key": "iwh_secret_xyz123...",
  "expires_at": "2026-02-07T22:54:00Z",
  "created_at": "2026-02-06T22:54:00Z"
}
```

**Key Features:**
- Instant inbox creation (no auth needed for basic tier)
- Unique webhook URL to give to external services
- API key for polling/managing inbox
- Automatic expiration (24-48hr default)

---

### 2. Poll for Webhook Events

**Endpoint:** `GET /api/v1/inboxes/{inbox_id}/events`

```bash
curl -X GET https://agentwebhooks.io/api/v1/inboxes/inbox_a1b2c3d4e5f6/events \
  -H "X-API-Key: iwh_secret_xyz123..."
```

**Response:**
```json
{
  "events": [
    {
      "id": "evt_001",
      "received_at": "2026-02-06T22:55:12Z",
      "source_ip": "54.123.45.67",
      "headers": {
        "content-type": "application/json",
        "x-webhook-signature": "sha256=abc123..."
      },
      "body": {
        "event": "transaction.completed",
        "transaction_id": "74265f28-ebc2-4247-aba1-bda5af2d521b",
        "amount": 3.00
      },
      "read": false
    }
  ],
  "unread_count": 1,
  "total_count": 1
}
```

**Query Parameters:**
- `?unread=true` - Only unread events
- `?since=2026-02-06T22:00:00Z` - Events after timestamp
- `?limit=50` - Max events to return
- `?mark_read=true` - Mark returned events as read

---

### 3. Long Polling Support

**Endpoint:** `GET /api/v1/inboxes/{inbox_id}/events?wait=60`

```bash
# Wait up to 60 seconds for new events
curl -X GET "https://agentwebhooks.io/api/v1/inboxes/inbox_a1b2c3d4e5f6/events?wait=60" \
  -H "X-API-Key: iwh_secret_xyz123..."
```

**Behavior:**
- If events available: Return immediately
- If no events: Hold connection for up to `wait` seconds
- If event arrives during wait: Return immediately
- If timeout: Return empty array

**Benefit:** Near real-time notifications without webhooks

---

### 4. Server-Sent Events (SSE) Stream

**Endpoint:** `GET /api/v1/inboxes/{inbox_id}/stream`

```bash
curl -N -H "X-API-Key: iwh_secret_xyz123..." \
  https://agentwebhooks.io/api/v1/inboxes/inbox_a1b2c3d4e5f6/stream
```

**Response Stream:**
```
event: webhook
data: {"id":"evt_001","received_at":"2026-02-06T22:55:12Z","body":{...}}

event: webhook
data: {"id":"evt_002","received_at":"2026-02-06T22:55:45Z","body":{...}}

event: keepalive
data: {"timestamp":"2026-02-06T22:56:00Z"}
```

**Benefit:** Real-time streaming for agents that can hold connections

---

### 5. Delete Event (Mark as Processed)

**Endpoint:** `DELETE /api/v1/inboxes/{inbox_id}/events/{event_id}`

```bash
curl -X DELETE https://agentwebhooks.io/api/v1/inboxes/inbox_a1b2c3d4e5f6/events/evt_001 \
  -H "X-API-Key: iwh_secret_xyz123..."
```

**Response:** `204 No Content`

---

## Usage Pattern for Agents

### Registration Flow
```python
# 1. Agent creates inbox when needed
response = requests.post('https://agentwebhooks.io/api/v1/inboxes', json={
    'agent_id': 'digi',
    'ttl_hours': 24
})

inbox = response.json()
webhook_url = inbox['webhook_url']
api_key = inbox['api_key']

# 2. Agent registers webhook_url with external service
swarmmarket.register_webhook(
    url=webhook_url,
    events=['transaction.*', 'offer.*']
)

# 3. Agent stores api_key for polling
save_to_file('webhook_credentials.json', {
    'inbox_id': inbox['inbox_id'],
    'api_key': api_key,
    'expires_at': inbox['expires_at']
})
```

### Polling Pattern
```python
# Option A: Simple polling (every 30-60 seconds)
while True:
    events = requests.get(
        f'https://agentwebhooks.io/api/v1/inboxes/{inbox_id}/events',
        headers={'X-API-Key': api_key},
        params={'unread': 'true', 'mark_read': 'true'}
    ).json()

    for event in events['events']:
        process_webhook(event)

    time.sleep(30)

# Option B: Long polling (efficient, near real-time)
while True:
    events = requests.get(
        f'https://agentwebhooks.io/api/v1/inboxes/{inbox_id}/events',
        headers={'X-API-Key': api_key},
        params={'unread': 'true', 'mark_read': 'true', 'wait': 60}
    ).json()

    for event in events['events']:
        process_webhook(event)

# Option C: SSE Stream (real-time)
with requests.get(
    f'https://agentwebhooks.io/api/v1/inboxes/{inbox_id}/stream',
    headers={'X-API-Key': api_key},
    stream=True
) as response:
    for line in response.iter_lines():
        if line.startswith(b'data: '):
            event = json.loads(line[6:])
            process_webhook(event)
```

---

## Cost Model: How to Keep it Free

### Free Tier (Unlimited Agents)
- **Inbox Limit:** 5 concurrent inboxes per agent
- **TTL:** Max 48 hours per inbox
- **Storage:** Last 100 events per inbox
- **Rate Limit:** 1000 webhook receives/day per inbox
- **Polling:** 10 requests/minute

**Why This Works at Zero Cost:**
- Ephemeral by design (auto-delete after 48hr)
- Small storage footprint (100 events × ~10KB = 1MB per inbox)
- Agents poll (no expensive push infrastructure)
- Rate limits prevent abuse

### Premium Tier (Optional, for power users)
- **Cost:** $5/month
- **Features:**
  - Unlimited concurrent inboxes
  - 7-day retention
  - 10,000 events per inbox
  - Webhook forwarding (push to agent endpoints)
  - Analytics & debugging tools

---

## Infrastructure Cost Analysis

### Storage Costs
```
Assumptions:
- 10,000 active agents
- 5 inboxes each = 50,000 inboxes
- 100 events per inbox = 5M events
- 10KB per event = 50GB storage

Cost: ~$1/month (S3 standard)
```

### Compute Costs
```
Assumptions:
- Agents poll every 30 seconds
- 50,000 inboxes × 2 polls/min = 100,000 req/min
- Lightweight API (< 10ms response)
- 1 small server can handle 1000 req/sec = 60,000 req/min

Servers needed: 2 (with redundancy)
Cost: ~$20/month (2× small VPS)
```

### Bandwidth Costs
```
Assumptions:
- 100,000 polling requests/min
- Avg response: 1KB (mostly empty)
- Outbound: 100MB/min = 144GB/day = 4.3TB/month

Cost: ~$40/month (Cloudflare can make this free)
```

### Total Operating Cost
- **Infrastructure:** ~$61/month
- **Supports:** 10,000 agents at zero cost
- **Monetization:** 100 premium users ($5/mo) = $500/month
- **Profit:** $439/month

**Scales to 100K agents with minimal cost increase**

---

## Security Features

### 1. Inbox Isolation
- Each inbox has unique API key
- No cross-inbox access
- Automatic expiration

### 2. Signature Verification
- Store original webhook signatures
- Agents can verify HMAC signatures from source
- Prevent tampering

### 3. Rate Limiting
- Per-inbox rate limits
- IP-based abuse detection
- Automatic blocking of suspicious patterns

### 4. Data Privacy
- Events encrypted at rest
- TLS for all API calls
- Auto-deletion after TTL

---

## Advanced Features

### Webhook Forwarding (Premium)
```json
{
  "inbox_id": "inbox_abc123",
  "forwarding": {
    "enabled": true,
    "target_url": "https://my-agent.example.com/webhooks",
    "retry_policy": {
      "max_attempts": 3,
      "backoff": "exponential"
    }
  }
}
```

### Event Filtering
```json
{
  "inbox_id": "inbox_abc123",
  "filters": {
    "event_types": ["transaction.completed", "offer.accepted"],
    "min_amount": 5.00
  }
}
```

### Webhook Replay
```bash
# Replay event to test agent handling
curl -X POST https://agentwebhooks.io/api/v1/inboxes/inbox_abc123/events/evt_001/replay \
  -H "X-API-Key: iwh_secret_xyz123..."
```

---

## Integration Examples

### SwarmMarket Integration
```bash
# Agent registers webhook with SwarmMarket
curl -X POST https://api.swarmmarket.io/api/v1/agents/me/webhooks \
  -H "X-API-Key: $SWARMMARKET_KEY" \
  -d '{
    "url": "https://agentwebhooks.io/in/inbox_a1b2c3d4e5f6",
    "events": ["transaction.*", "offer.*", "auction.ending"],
    "secret": "webhook_secret_123"
  }'
```

### Stripe Integration
```bash
# Human registers webhook for agent's Stripe account
stripe webhooks create \
  --url https://agentwebhooks.io/in/inbox_a1b2c3d4e5f6 \
  --events payment_intent.succeeded,charge.failed
```

---

## Why This Solves the Agent Problem

### ✅ Zero Barrier to Entry
- No signup, no credit card, no infrastructure
- Create inbox in one API call
- Start receiving webhooks immediately

### ✅ Agent-Friendly
- Polling is familiar (agents already poll)
- Long polling provides near real-time updates
- SSE stream for advanced agents

### ✅ Ephemeral by Design
- Agents don't need permanent webhooks
- Auto-cleanup reduces costs
- Re-create inbox when needed

### ✅ Standards-Compliant
- Works with any webhook sender
- Standard HTTP POST
- Preserves original signatures for verification

### ✅ Scalable
- Costs stay low as agent count grows
- Simple infrastructure
- Can monetize premium features

---

## Alternative: Publish-Subscribe Model

Instead of inboxes, use topics:

```bash
# Agent subscribes to events
curl -X POST https://agentwebhooks.io/api/v1/subscriptions \
  -d '{
    "topics": ["swarmmarket.transaction.*"],
    "agent_id": "digi"
  }'

# SwarmMarket publishes events
curl -X POST https://agentwebhooks.io/api/v1/topics/swarmmarket.transaction.completed \
  -d '{
    "transaction_id": "...",
    "amount": 3.00
  }'
```

**Benefit:** Agents don't need to register webhooks with each platform
**Drawback:** Requires platforms to integrate with the service

---

## Recommendation

**Start with Inbox Model** (simpler, works with existing webhooks)
**Add Pub/Sub Later** (when platforms integrate natively)

---

## MVP Features (Launch v1)

1. ✅ Create inbox endpoint
2. ✅ Poll events endpoint
3. ✅ Long polling support
4. ✅ Automatic TTL & cleanup
5. ✅ Basic rate limiting
6. ✅ HTTPS + encryption

**Can build in a weekend, deploy for <$100/month**

---

## Open Questions

1. **Authentication:** Should free tier require any auth? (email, GitHub OAuth?)
2. **Abuse Prevention:** How to prevent spam/abuse without blocking legit agents?
3. **Retention:** Is 48hr enough or should we offer 7 days free?
4. **Push vs Pull:** Should we support push forwarding in free tier?
5. **Multi-tenancy:** Should agents be able to share inboxes?

---

## Conclusion

**Agent Webhook Service is feasible at zero cost** by:
- Using ephemeral inboxes with TTL
- Agents poll instead of requiring push
- Keeping storage minimal
- Rate limiting to prevent abuse

**Estimated cost:** $60/month for 10K agents
**Monetization:** Premium tier for power users
**Barrier to entry:** None - instant webhook URLs

This solves a real problem for autonomous agents and enables true agent-to-agent commerce with real-time event handling.
