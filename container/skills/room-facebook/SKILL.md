---
name: room-facebook
description: Manage Facebook Pages via the Room Facebook Page Manager service. View pages, check post approval queue, approve/reject posts, sync configs, and monitor service health. Use when users ask about Facebook page management, social media posting, or content approval.
allowed-tools: Bash(curl:*), Bash(cat:*), WebFetch
---

# Facebook Page Manager via Room API

Manage Facebook Pages through the Room Facebook Page Manager service.
All requests go through `$ROOM_API_URL/facebook/` — the proxy handles authentication (HMAC signatures).

## Prerequisites

The `ROOM_API_URL` environment variable must be set (injected automatically by NanoClaw).
Check with: `echo $ROOM_API_URL`

## Check Service Health

```bash
curl -s "$ROOM_API_URL/facebook/health"
```

## List Managed Pages

```bash
curl -s "$ROOM_API_URL/facebook/pages"
```

**Response:**
```json
{
  "pages": [
    {
      "pageId": "123456",
      "name": "My Business Page",
      "category": "Business",
      "status": "active"
    }
  ]
}
```

## View Approval Queue

List pending posts waiting for approval:

```bash
# Pending items (default)
curl -s "$ROOM_API_URL/facebook/approval?status=pending"

# Approved items
curl -s "$ROOM_API_URL/facebook/approval?status=approved"

# Rejected items
curl -s "$ROOM_API_URL/facebook/approval?status=rejected"
```

**Response:**
```json
{
  "items": [
    {
      "id": "appr_123",
      "pageId": "123456",
      "pageName": "My Business Page",
      "content": "Check out our new product launch!",
      "mediaUrls": [],
      "scheduledFor": "2026-03-29T10:00:00Z",
      "status": "pending",
      "createdAt": "2026-03-28T15:00:00Z"
    }
  ]
}
```

## Approve a Post

```bash
curl -s -X POST "$ROOM_API_URL/facebook/approval/{id}/approve" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Reject a Post

```bash
curl -s -X POST "$ROOM_API_URL/facebook/approval/{id}/reject" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Content needs revision"}'
```

## Regenerate Post Content

```bash
curl -s -X POST "$ROOM_API_URL/facebook/approval/{id}/regenerate" \
  -H "Content-Type: application/json" \
  -d '{"instructions": "Make it more engaging and add a call-to-action"}'
```

## Get Service Configuration

```bash
curl -s "$ROOM_API_URL/facebook/config"
```

## Sync Page Tokens

Sync page access tokens from the Room database to the Facebook service:

```bash
curl -s -X POST "$ROOM_API_URL/api/admin/facebook/sync-pages" \
  -H "Content-Type: application/json"
```

## Sync Configuration

Push all `facebook.*` configs from Room DB to the service:

```bash
curl -s -X POST "$ROOM_API_URL/api/admin/facebook/sync-config" \
  -H "Content-Type: application/json"
```

## Get Full Service Status (via Room Worker)

For a comprehensive status check including health + config + secrets status:

```bash
curl -s "$ROOM_API_URL/api/admin/facebook/status"
```

## Example: Review and Approve Pending Posts

```bash
# 1. Check pending approvals
PENDING=$(curl -s "$ROOM_API_URL/facebook/approval?status=pending")
echo "$PENDING" | python3 -m json.tool 2>/dev/null || echo "$PENDING"

# 2. Approve a specific post
curl -s -X POST "$ROOM_API_URL/facebook/approval/appr_123/approve" \
  -H "Content-Type: application/json" -d '{}'

# 3. Notify user
# Use send_message tool: "Approved post appr_123 for publishing."
```

## Example: Monitor Service Health

```bash
# Check health
HEALTH=$(curl -s "$ROOM_API_URL/facebook/health")
echo "Service health: $HEALTH"

# Check managed pages
PAGES=$(curl -s "$ROOM_API_URL/facebook/pages")
echo "Managed pages: $PAGES"

# Check pending items count
PENDING=$(curl -s "$ROOM_API_URL/facebook/approval?status=pending")
COUNT=$(echo "$PENDING" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items',[])))" 2>/dev/null || echo "?")
echo "Pending approvals: $COUNT"
```

## Tips

- Always check service health before performing operations
- Use `send_message` to notify users about approval decisions
- The Facebook service handles rate limiting automatically
- Post scheduling is managed by the service — just approve/reject in the queue
- For content generation, combine with Claude's writing capabilities before submitting
