# ThagomizerClaw — Cloudflare Secrets Management

Enterprise-grade secret management using Cloudflare Secrets.
All secrets are encrypted at rest and injected at runtime — never stored in code or `.env` files.

## Security Principles

1. **Zero-secret code** — No secret values in source code, `wrangler.toml`, or git history
2. **Runtime injection** — Secrets bound to Worker at deploy time, inaccessible to logs
3. **Principle of least privilege** — Each channel only gets tokens it needs
4. **Secret rotation** — Update secrets with `wrangler secret put` without redeployment
5. **Audit trail** — Cloudflare dashboard shows secret access patterns

## Required Secrets

Set all secrets with: `wrangler secret put <NAME>`

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ Always | Claude API key from [console.anthropic.com](https://console.anthropic.com) |
| `WEBHOOK_SECRET` | ✅ Always | Shared secret for Telegram webhook URL + admin API auth (generate: `openssl rand -hex 32`) |
| `TELEGRAM_BOT_TOKEN` | If using Telegram | From [@BotFather](https://t.me/BotFather) |
| `DISCORD_BOT_TOKEN` | If using Discord | From [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_PUBLIC_KEY` | If using Discord | App public key (for Ed25519 signature verification) |
| `SLACK_BOT_TOKEN` | If using Slack | OAuth Bot Token from [api.slack.com/apps](https://api.slack.com/apps) |
| `SLACK_SIGNING_SECRET` | If using Slack | Signing secret (for HMAC-SHA256 request verification) |

## Setup Commands

```bash
# Core (always required)
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put WEBHOOK_SECRET

# Telegram
wrangler secret put TELEGRAM_BOT_TOKEN

# Discord
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY

# Slack
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
```

## Listing and Rotating Secrets

```bash
# List all secrets (names only, values are never shown)
wrangler secret list

# Rotate a secret (zero-downtime — new value takes effect on next request)
wrangler secret put ANTHROPIC_API_KEY

# Delete a secret
wrangler secret delete SLACK_BOT_TOKEN
```

## Local Development

For local development with `wrangler dev`, secrets go in `.dev.vars`:

```bash
# Copy the example file
cp .dev.vars.example .dev.vars

# Fill in real values in .dev.vars
# .dev.vars is gitignored — NEVER commit it
```

## Per-Environment Secrets (Staging vs Production)

```bash
# Production (default)
wrangler secret put ANTHROPIC_API_KEY

# Staging environment
wrangler secret put ANTHROPIC_API_KEY --env staging
```

## Security Checklist

- [ ] `.dev.vars` is in `.gitignore` (already configured)
- [ ] No secret values in `wrangler.toml` (use `[vars]` only for non-secret config)
- [ ] `ANTHROPIC_API_KEY` set via `wrangler secret put`
- [ ] `WEBHOOK_SECRET` is cryptographically random (min 32 bytes)
- [ ] Telegram webhook URL includes the `WEBHOOK_SECRET` as path component
- [ ] Discord public key matches your app at discord.com/developers
- [ ] Slack signing secret matches your app at api.slack.com

## How Secrets Flow (Architecture)

```
Cloudflare Dashboard / wrangler CLI
         │
         ▼ (encrypted at rest in Cloudflare's infrastructure)
  Cloudflare Secrets Store
         │
         ▼ (injected at runtime via env bindings, never logged)
  Worker (env.ANTHROPIC_API_KEY, env.TELEGRAM_BOT_TOKEN, ...)
         │
         ▼ (used directly in API calls, never forwarded to users)
  External APIs (Anthropic, Telegram, Discord, Slack)
```

No secret ever touches:
- Your git repository
- Application logs
- Error messages sent to users
- Cloudflare's edge cache
- Worker process memory after the request completes
