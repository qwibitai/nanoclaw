---
name: linkedin
description: LinkedIn automation — visit profiles, connect, message, like/react/comment/share posts, follow, endorse skills, scrape leads to Notion, run outreach campaigns. Main group only.
---

# /linkedin — LinkedIn Automation

Parse the user's request and run the appropriate LinkedIn action.

## IPC Helper

Define this function once and use it for every LinkedIn call:

```bash
li_run() {
  local TYPE="$1"
  local PAYLOAD="$2"
  local REQUEST_ID="li-$(date +%s%N)"
  local TASK_FILE="/workspace/ipc/tasks/${REQUEST_ID}.json"
  local RESULT_FILE="/workspace/ipc/li_results/${REQUEST_ID}.json"

  # Build task JSON and write atomically
  node -e "
    const p = JSON.parse(process.argv[1]);
    p.type = process.argv[2];
    p.requestId = process.argv[3];
    p.timestamp = new Date().toISOString();
    require('fs').writeFileSync(process.argv[4] + '.tmp', JSON.stringify(p, null, 2));
    require('fs').renameSync(process.argv[4] + '.tmp', process.argv[4]);
  " "$PAYLOAD" "$TYPE" "$REQUEST_ID" "$TASK_FILE"

  # Poll for result (120s timeout; use 300 for campaigns/scraping)
  local TIMEOUT="${3:-120}"
  for i in $(seq 1 "$TIMEOUT"); do
    if [ -f "$RESULT_FILE" ]; then
      cat "$RESULT_FILE"
      rm -f "$RESULT_FILE"
      return 0
    fi
    sleep 1
  done
  echo '{"success":false,"message":"Timed out waiting for LinkedIn result"}'
}
```

## Actions & Payloads

### Visit a profile
```bash
li_run 'li_visit_profile' '{"profileUrl":"https://linkedin.com/in/USERNAME"}'
```

### Send connection request
```bash
# Without note:
li_run 'li_connect' '{"profileUrl":"https://linkedin.com/in/USERNAME"}'
# With note:
li_run 'li_connect' '{"profileUrl":"https://linkedin.com/in/USERNAME","note":"Hi, I saw your work on X..."}'
```

### Withdraw a pending request
```bash
li_run 'li_withdraw_request' '{"profileUrl":"https://linkedin.com/in/USERNAME"}'
```

### Send a DM (1st-degree connections only)
```bash
li_run 'li_message' '{"profileUrl":"https://linkedin.com/in/USERNAME","messageText":"Hi NAME, ..."}'
```

### Follow / Unfollow
```bash
li_run 'li_follow'   '{"profileUrl":"https://linkedin.com/in/USERNAME"}'
li_run 'li_unfollow' '{"profileUrl":"https://linkedin.com/in/USERNAME"}'
```

### Like a post
```bash
li_run 'li_like_post' '{"postUrl":"https://linkedin.com/posts/..."}'
```

### React to a post
Reactions: like, celebrate, support, funny, love, insightful, curious
```bash
li_run 'li_react_post' '{"postUrl":"https://linkedin.com/posts/...","reaction":"celebrate"}'
```

### Comment on a post
```bash
li_run 'li_comment_post' '{"postUrl":"https://linkedin.com/posts/...","comment":"Great insight!"}'
```

### Share / repost
```bash
# Repost only:
li_run 'li_share_post' '{"postUrl":"https://linkedin.com/posts/..."}'
# Repost with commentary:
li_run 'li_share_post' '{"postUrl":"https://linkedin.com/posts/...","commentary":"Sharing because..."}'
```

### Endorse a skill
```bash
li_run 'li_endorse_skill' '{"profileUrl":"https://linkedin.com/in/USERNAME","skill":"Python"}'
```

### Scrape search results → Notion
```bash
li_run 'li_scrape_search' '{"query":"startup founders NYC","maxLeads":50}' 300
```

### Scrape a single profile → Notion
```bash
li_run 'li_scrape_profile' '{"profileUrl":"https://linkedin.com/in/USERNAME"}'
```

### Scrape post engagers → Notion
```bash
li_run 'li_scrape_post_engagers' '{"postUrl":"https://linkedin.com/posts/...","maxLeads":100}' 300
```

### Get campaign stats
```bash
li_run 'li_get_campaign_stats' '{}'
# Filter by campaign:
li_run 'li_get_campaign_stats' '{"campaign":"Campaign Name"}'
```

### Run outreach campaign (visit → connect → message from Notion leads)
Steps can be any subset of: visit, connect, message
```bash
li_run 'li_run_campaign' '{
  "steps": ["visit","connect","message"],
  "connectNote": "Hi {name}, I found your profile interesting...",
  "messageText": "Hi {name}, thanks for connecting!",
  "campaign": "Campaign Name",
  "fromStatus": "New",
  "maxLeads": 10
}' 600
```

### Bulk message Connected leads
```bash
li_run 'li_bulk_message' '{
  "messageText": "Hi {name}, just wanted to share...",
  "campaign": "Campaign Name",
  "maxMessages": 20
}' 600
```

## Workflow

1. Parse the user's request to determine action and parameters
2. Send an acknowledgment: `mcp__nanoclaw__send_message` — "Starting LinkedIn [action]..."
3. Run the appropriate `li_run` call
4. Parse the JSON result and report back clearly
5. For bulk/campaign actions, always confirm with the user first

## Result format

Every `li_run` call returns JSON:
```json
{"success": true, "message": "Done", "data": {...}}
```
or
```json
{"success": false, "message": "Error description"}
```

Report the `message` to the user. If `data` is present and useful, summarize it.
