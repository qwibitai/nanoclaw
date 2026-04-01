# OAuth Auto-Refresh for Credential Proxy

## Problem

The credential proxy reads a static OAuth token from `.env` at startup. Claude Max subscription tokens expire every ~8 hours, requiring manual server login to update them daily.

## Solution

Modify the credential proxy to read OAuth credentials from `~/.claude/.credentials.json` (written by the Claude CLI) and auto-refresh them before expiry using the Anthropic OAuth refresh endpoint.

## Auth Mode Priority

1. **API key mode:** If `ANTHROPIC_API_KEY` is set in `.env`, use it (no refresh needed). Unchanged from current behavior.
2. **OAuth mode:** Read from `~/.claude/.credentials.json`. Auto-refresh via refresh token. No `.env` OAuth tokens supported — credentials.json is the sole OAuth source.

## Token Lifecycle

1. **Startup:** Read `~/.claude/.credentials.json` -> extract `claudeAiOauth.accessToken`, `refreshToken`, `expiresAt`.
2. **Refresh check:** If token expires within 5 minutes, call `https://platform.claude.com/v1/oauth/token` with `grant_type=refresh_token` and client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e`.
3. **Write back:** Save new `accessToken`, `refreshToken`, `expiresAt` back to credentials file, preserving other fields (`scopes`, `subscriptionType`, `rateLimitTier`).
4. **Periodic timer:** Every 4 minutes, re-check expiry and refresh if needed.
5. **Injection:** Proxy uses in-memory `accessToken` for Bearer header injection (mutable reference, updated on refresh).

## Refresh Endpoint

- URL: `https://platform.claude.com/v1/oauth/token`
- Method: POST
- Content-Type: `application/x-www-form-urlencoded`
- Body: `grant_type=refresh_token&refresh_token=<token>&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Response: JSON with `access_token`, `refresh_token`, `expires_in`

## Error Handling

- Refresh failure: log error, keep using current token (may still be valid).
- Retry: 3 attempts with 2-second backoff on refresh failure.
- Credentials file missing or malformed at startup: throw (fail fast, no silent fallback).
- Concurrent refresh protection: not needed since refresh runs on a single timer, not per-request.

## Files Changed

- `src/credential-proxy.ts` — add `readCredentials()`, `refreshOAuthToken()`, `ensureValidToken()`, periodic timer. Remove `.env` OAuth token reading (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`).
- `src/credential-proxy.test.ts` — test credential reading, refresh flow, write-back, timer, error retry.

## What Does Not Change

- API key mode (reads `ANTHROPIC_API_KEY` from `.env`, injects `x-api-key` header).
- Proxy request forwarding logic.
- Container-side behavior (containers still see the proxy as `ANTHROPIC_BASE_URL`).
- `src/container-runner.ts`, `src/index.ts` — no changes needed.
