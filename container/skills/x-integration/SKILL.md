---
name: x-integration
description: X (Twitter) integration using official XDK SDK. Post, like, reply, retweet, quote, search, timeline monitoring. Use for setup, testing, or X interactions. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet".
---

# X (Twitter) Integration

Direct X API integration via official `@xdevplatform/xdk` SDK.

## Prerequisites

1. X account connected via bearclaw-platform UI (OAuth 2.0)
2. OneCLI vault configured with X API credentials
3. `x-persona.md` in group folder (run `x_setup` to bootstrap)

## Tools

| Tool | Description | Approval |
|------|-------------|----------|
| `x_setup` | Bootstrap persona from account history | None (read-only) |
| `x_post` | Post a tweet | Per policy (default: confirm) |
| `x_like` | Like a tweet | Per policy (default: auto) |
| `x_reply` | Reply to a tweet | Per policy (default: confirm) |
| `x_retweet` | Retweet | Per policy (default: auto) |
| `x_quote` | Quote tweet | Per policy (default: confirm) |
| `x_search` | Search recent tweets | None (read-only) |
| `x_timeline` | Fetch home timeline | None (read-only) |

## DRY_RUN Mode

Set `X_DRY_RUN=true` to test without making real API calls.
