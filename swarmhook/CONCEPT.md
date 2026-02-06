# SwarmHook - Complete Concept

## Overview
Zero-cost webhook infrastructure for autonomous AI agents. Agents can receive webhooks without permanent infrastructure.

## Problem
AI agents need real-time notifications but can't:
- Run permanent web servers
- Get public IP addresses
- Pay for cloud services
- Manage webhook endpoints

## Solution
Ephemeral webhook inboxes with polling:
1. Agent creates inbox → Gets unique URL
2. Agent registers URL with external service
3. Agent polls for events (or uses long-polling/SSE)
4. Inbox auto-deletes after 24-48hr

## Tech Stack (Railway Optimized)

### Runtime: Bun
- 3x faster than Node.js
- Native TypeScript
- Built-in testing
- Smaller memory footprint

### Framework: Hono
- Fastest TS web framework
- <10KB bundle size
- Edge-optimized
- Perfect for Railway

### Database: Redis
- Native TTL (auto-cleanup)
- Fast O(1) operations
- Pub/Sub for real-time
- Railway free tier included

### Hosting: Railway.app
- Free tier: $5 credit/month
- Auto-scaling
- Zero-config Redis
- Git push deploy

## Architecture

```
External Service → SwarmHook API → Redis (TTL) → Agent (poll/stream)
```

## API Design

### Create Inbox
```http
POST /api/v1/inboxes
{
  "agent_id": "my-agent",
  "ttl_hours": 24
}

Response:
{
  "id": "inbox_abc123",
  "webhook_url": "https://swarmhook.app/in/inbox_abc123",
  "polling_url": "https://swarmhook.app/api/v1/inboxes/inbox_abc123/events",
  "api_key": "iwh_secret_xyz...",
  "expires_at": "2026-02-07T23:00:00Z"
}
```

### Receive Webhook
```http
POST /in/:inbox_id
(Any payload from external service)

Response:
{
  "success": true,
  "event_id": "evt_xyz789"
}
```

### Poll Events
```http
GET /api/v1/inboxes/:id/events?unread=true&mark_read=true&wait=60
X-API-Key: iwh_secret_xyz...

Response:
{
  "events": [
    {
      "id": "evt_xyz789",
      "received_at": "2026-02-06T23:01:00Z",
      "headers": {...},
      "body": {...},
      "read": false
    }
  ],
  "unread_count": 1,
  "total_count": 1
}
```

### Stream Events (SSE)
```http
GET /api/v1/inboxes/:id/stream
X-API-Key: iwh_secret_xyz...

Response: (Server-Sent Events stream)
```

## Implementation

### Project Structure
```
swarmhook/
├── src/
│   ├── index.ts           # Hono app
│   ├── routes/
│   │   ├── inboxes.ts     # Inbox CRUD
│   │   ├── webhooks.ts    # Receive webhooks
│   │   └── events.ts      # Poll/stream events
│   ├── services/
│   │   ├── redis.ts       # Redis client
│   │   └── inbox.ts       # Business logic
│   ├── middleware/
│   │   ├── auth.ts        # API key auth
│   │   └── ratelimit.ts   # Rate limiting
│   └── types/
│       └── index.ts       # TypeScript types
├── tests/
│   └── api.test.ts        # Integration tests
├── package.json
├── tsconfig.json
├── railway.toml
└── README.md
```

### Key Features

**Ephemeral Storage**
- All data stored in Redis with TTL
- Automatic cleanup (no manual deletion)
- Max 48hr retention

**Long Polling**
- Agent polls with `?wait=60`
- Blocks up to 60 seconds
- Returns immediately when event arrives
- Near real-time without webhooks

**Rate Limiting**
- 60 requests/minute per inbox
- Redis-based sliding window
- Prevents abuse

**Security**
- API key authentication (32-byte random)
- TLS in transit
- No persistent logging
- Auto-expiration

## Cost Analysis

### Railway Free Tier
$5 credit/month supports:
- 1,000 concurrent inboxes
- 100,000 webhook receives/month
- 500,000 poll requests/month
- 1GB Redis storage

### Scaling
- 10K inboxes: ~$40/month
- 100K inboxes: ~$200/month

## Usage Example

```typescript
// 1. Create inbox
const inbox = await fetch('https://swarmhook.app/api/v1/inboxes', {
  method: 'POST',
  body: JSON.stringify({ agent_id: 'digi', ttl_hours: 24 })
}).then(r => r.json())

// 2. Register with SwarmMarket
await fetch('https://api.swarmmarket.io/api/v1/agents/me/webhooks', {
  method: 'POST',
  headers: { 'X-API-Key': SWARMMARKET_KEY },
  body: JSON.stringify({
    url: inbox.webhook_url,
    events: ['transaction.*', 'offer.*']
  })
})

// 3. Poll for events (long polling)
while (true) {
  const events = await fetch(
    `${inbox.polling_url}?wait=60&unread=true&mark_read=true`,
    { headers: { 'X-API-Key': inbox.api_key } }
  ).then(r => r.json())

  for (const event of events.events) {
    console.log('Received webhook:', event)
    handleEvent(event)
  }
}
```

## Why This Works at Zero Cost

1. **Ephemeral by Design**
   - Inboxes expire after 24-48hr
   - Automatic cleanup reduces storage

2. **Agent-Friendly Polling**
   - Agents already poll (familiar pattern)
   - Long polling provides near real-time
   - No expensive push infrastructure

3. **Minimal Storage**
   - Max 100 events per inbox
   - ~1MB per inbox
   - 1,000 inboxes = 1GB (Railway free tier)

4. **Efficient Architecture**
   - Bun (fast, small footprint)
   - Hono (lightweight framework)
   - Redis (fast, managed by Railway)

## Deployment Steps

1. **Create Railway Project**
   ```bash
   railway init
   railway add redis
   ```

2. **Set Environment Variables**
   ```bash
   railway variables set BASE_URL=https://your-app.up.railway.app
   ```

3. **Deploy**
   ```bash
   git push
   # Railway auto-deploys
   ```

4. **Test**
   ```bash
   curl https://your-app.up.railway.app/health
   ```

## Future Enhancements

**Phase 2:**
- Webhook signature verification
- Event filtering by type
- Dashboard UI

**Phase 3:**
- Multi-region deployment
- GraphQL API
- Analytics

**Phase 4:**
- Agent marketplace integration
- Premium tier (longer retention, more features)

## Integration with SwarmMarket

SwarmHook complements SwarmMarket perfectly:

1. Agent creates SwarmHook inbox
2. Agent registers inbox URL with SwarmMarket
3. SwarmMarket sends webhooks for:
   - Transaction updates
   - New offers
   - Auction endings
4. Agent polls SwarmHook for events
5. Agent reacts to marketplace activity in real-time

## Conclusion

SwarmHook enables autonomous agents to participate in real-time event-driven systems without infrastructure requirements. By leveraging ephemeral storage and polling, it achieves zero cost for agents while providing near real-time notifications.

**Cost:** $0-5/month (Railway free tier)
**Setup:** 1 API call
**Reliability:** High (managed Redis, auto-scaling)
**Performance:** <50ms latency, near real-time with long polling

Perfect for the autonomous agent economy.
