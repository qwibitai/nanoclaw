# Context: NanoClaw Direct Message API

## Background

NanoClaw is a containerized agent framework that routes messages from chat platforms (Telegram, Slack, IRC) through a channel abstraction layer, queues them per-group, and dispatches them to Docker-isolated Claude Code containers. Each channel implements the `Channel` interface (`src/types.ts`) and self-registers via `registerChannel()` in `src/channels/registry.ts`.

Currently, the only way to communicate with a NanoClaw-based bot is through a configured chat channel. This means programmatic access (from Claude Code sessions, scripts, other bots in the Claw fleet) must go through Slack or Telegram, which adds latency, rate limits, and format constraints that don't apply to machine-to-machine communication.

## Motivation

1. **Inter-bot communication**: Nook (Letta-based) already has a REST API for direct messaging. NanoClaw bots (X, Relay) lack an equivalent. Fleet tooling that needs to query a NanoClaw bot must currently post to a Telegram group and scrape the response.

2. **Claude Code integration**: The `spawn_nanoclaw` tool and other Claude Code workflows would benefit from a synchronous request/response API instead of async channel polling.

3. **Operational tooling**: Health checks, status queries, and automated workflows (CI, monitoring) need a programmatic entry point that doesn't depend on chat platform availability.

## Existing Patterns

The codebase already has relevant precedents:

- **Channel registry** (`src/channels/registry.ts`): `registerChannel(name, factory)` / `getChannelFactory(name)` pattern. New channels self-register on import via the barrel file `src/channels/index.ts`.
- **Credential proxy** (`src/credential-proxy.ts`): A bare `http.createServer()` HTTP server on a configurable port, using the same Node.js `http` module we'd use for the API server. No Express or other framework.
- **JID routing** (`src/router.ts`): `routeOutbound()` finds a channel via `ownsJid(jid)`. Each channel uses a prefix convention (Telegram: `telegram:{chatId}`, Slack: `slack:{channelId}`, IRC: `irc:{channel}`). The API channel would use `api:{requestId}`.
- **Config pattern** (`src/config.ts`): Port/timeout constants read from env via `readEnvFile()` with fallback to `process.env`, then exported as named constants.
- **GroupQueue** (`src/group-queue.ts`): The existing message queue that serializes per-group processing. API messages would flow through this same queue.

## Constraints

- No new npm dependencies (bare `http` module only, matching credential proxy pattern).
- Must not disrupt existing channel behavior or message loop.
- Fleet-internal only; no public internet exposure planned.
- Single static bearer token is sufficient for auth (all fleet bots run on the same Tailscale network).
