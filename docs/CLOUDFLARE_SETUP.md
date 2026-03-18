# ThagomizerClaw — Cloudflare Workers Setup Guide

Enterprise deployment on Cloudflare Workers with D1, KV, R2, Queues, and Durable Objects.

## Prerequisites

```bash
# Install Wrangler CLI
npm install -g wrangler

# Authenticate with Cloudflare
wrangler login

# Verify authentication
wrangler whoami
```

## Step 1: Create Cloudflare Resources

```bash
# 1. Create D1 database
wrangler d1 create thagomizer-claw-db
# → Copy the database_id into wrangler.toml [[d1_databases]] section

# 2. Create R2 bucket
wrangler r2 bucket create thagomizer-claw-storage

# 3. Create KV namespace
wrangler kv namespace create STATE
# → Copy the id into wrangler.toml [[kv_namespaces]] section

# 4. Create Queues
wrangler queues create thagomizer-messages
wrangler queues create thagomizer-messages-dlq
```

## Step 2: Update wrangler.toml

Replace the placeholder IDs in `wrangler.toml`:
```toml
[[d1_databases]]
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"  # ← paste your D1 id

[[kv_namespaces]]
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"  # ← paste your KV id
```

## Step 3: Run Database Migrations

```bash
# Apply schema to local D1 (for wrangler dev)
cd worker && npm run db:migrate:local

# Apply schema to remote D1 (production)
cd worker && npm run db:migrate:remote
```

## Step 4: Set Secrets

See [CLOUDFLARE_SECRETS.md](CLOUDFLARE_SECRETS.md) for the full list.

```bash
# Minimum required
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put WEBHOOK_SECRET

# Your messaging channels
wrangler secret put TELEGRAM_BOT_TOKEN     # if using Telegram
wrangler secret put DISCORD_BOT_TOKEN      # if using Discord
wrangler secret put DISCORD_PUBLIC_KEY     # if using Discord
wrangler secret put SLACK_BOT_TOKEN        # if using Slack
wrangler secret put SLACK_SIGNING_SECRET   # if using Slack
```

## Step 5: Install Worker Dependencies and Deploy

```bash
cd worker
npm install
npm run deploy
```

## Step 6: Register Channel Webhooks

### Telegram
```bash
# Replace TOKEN and YOUR_WORKER_URL
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/webhook/telegram/YOUR_WEBHOOK_SECRET"}'
```

### Discord
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Set "Interactions Endpoint URL" to: `https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/webhook/discord`

### Slack
1. Go to [Slack API](https://api.slack.com/apps) → Your App → Event Subscriptions
2. Set Request URL to: `https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/webhook/slack`
3. Subscribe to: `message.channels`, `message.groups`, `app_mention`

## Step 7: Register Your First Group

```bash
# Use the admin API to register a group
curl -X POST https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/admin/groups \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "jid": "tg:-1001234567890",
    "group": {
      "name": "Main Control",
      "folder": "main",
      "trigger": "@Andy",
      "added_at": "2024-01-01T00:00:00Z",
      "isMain": true,
      "requiresTrigger": false
    }
  }'
```

## Local Development

```bash
# Copy secrets template
cp .dev.vars.example .dev.vars
# Fill in .dev.vars with real values

# Run locally
cd worker
npm run dev
# → Worker available at http://localhost:8787
```

## Monitoring

```bash
# Tail live logs
cd worker && npm run tail

# Check health
curl https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/health

# Admin health check (requires auth)
curl -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  https://thagomizer-claw.YOUR_SUBDOMAIN.workers.dev/admin/health
```

## Architecture Overview

```
Telegram/Discord/Slack
        │
        ▼ (HTTP webhook, signature verified)
Cloudflare Worker (worker/src/index.ts)
        │
   ┌────▼────┐
   │  D1 DB  │ ← Store message
   └────┬────┘
        │
        ▼ (async, decoupled)
Cloudflare Queue (thagomizer-messages)
        │
        ▼ (queue consumer)
runAgent() → Anthropic Claude API / Workers AI
        │
        ▼
Channel API (send reply back)
```

## Cost Estimation

Cloudflare Workers free tier covers:
- 100,000 requests/day
- 10ms CPU time/request
- 5 GB R2 storage
- 100,000 KV reads/day
- 25 million D1 rows read/month

For enterprise usage, see [Cloudflare Workers Paid Plans](https://developers.cloudflare.com/workers/platform/pricing/).
