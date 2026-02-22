---
name: whatsapp-search
description: Search WhatsApp message history using semantic search. Use when the user asks about past conversations, wants to find who said something, or needs to look up information from chat history.
allowed-tools: Bash(whatsapp-search:*)
---

# WhatsApp Search

Semantic search over WhatsApp message history. Finds messages by meaning, not just exact keywords.

## When to Use

- User asks "what did X say about Y"
- User wants to find a past conversation or message
- User needs to look up information shared in chat
- User asks "when did we discuss X"

## Functions

### Basic search

```bash
whatsapp-search:search() {
  local query="$1"
  local limit="${2:-10}"
  curl -s http://host.docker.internal:3847/api/search \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$query\", \"limit\": $limit}" | jq .
}
```

### Search within a specific group

```bash
whatsapp-search:search-filtered() {
  local query="$1"
  local group_name="$2"
  curl -s http://host.docker.internal:3847/api/search \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$query\", \"filters\": {\"groups\": [\"$group_name\"]}}" | jq .
}
```

### Search recent messages (last N days)

```bash
whatsapp-search:search-recent() {
  local query="$1"
  local days="${2:-7}"
  local start_date
  start_date=$(date -u -d "$days days ago" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v-${days}d +%Y-%m-%dT%H:%M:%S.000Z)
  curl -s http://host.docker.internal:3847/api/search \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$query\", \"filters\": {\"dateRange\": {\"start\": \"$start_date\"}}}" | jq .
}
```

### Get collection stats

```bash
whatsapp-search:stats() {
  curl -s http://host.docker.internal:3847/api/stats | jq .
}
```

## Response Format

Search returns an array of results sorted by similarity:

```json
{
  "query": "the search query",
  "results": [
    {
      "message": {
        "id": "msg_id",
        "content": "the message text",
        "sender": "sender_jid",
        "sender_name": "Display Name",
        "timestamp": "2026-02-20T17:51:34.000Z",
        "group_name": "Group Name",
        "chat_jid": "chat_jid"
      },
      "similarity": 0.85
    }
  ],
  "totalResults": 5
}
```

## Tips

- Phrase queries as natural language for best results (e.g., "recipe for chocolate cake" not "chocolate cake recipe")
- Use `search-filtered` when you know which group the message was in
- Use `search-recent` to narrow results to recent conversations
- Results with similarity > 0.5 are usually relevant; > 0.7 are strong matches
