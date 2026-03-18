# /add-minimax-oauth

Adds [MiniMax](https://platform.minimax.io) OAuth (Coding Plan) as the model provider for NanoClaw.

No Anthropic API key or Claude OAuth token required.

## What this adds

- `src/minimax-oauth.ts` - MiniMax device-code OAuth (PKCE S256)
- `scripts/minimax-login.ts` - one-shot login CLI
- `src/credential-proxy.ts` - extended with minimax-oauth auth mode

## Prerequisites

A [MiniMax Coding Plan](https://platform.minimax.io/subscribe/coding-plan) subscription.

## Setup

```bash
npm run minimax-login
```

Browser opens to MiniMax auth page. Approve — tokens saved to .env.

Then: `npm run dev`

CN region: `npm run minimax-login -- --region cn`

## How it works

Credential proxy detects MINIMAX_OAUTH_ACCESS in .env and switches
to minimax-oauth mode. Tokens auto-refresh 60s before expiry.

## Auth priority

1. ANTHROPIC_API_KEY present -> api-key mode
2. MINIMAX_OAUTH_ACCESS present -> minimax-oauth mode
3. Neither -> oauth mode (Claude OAuth, NanoClaw default)
