# Nexus Architecture (As-Built)

## System Overview

Nexus consists of two deployments:

1. **Nexus Agent** (per Operator) — Deno on Fly.io, gateway + worker processes
2. **Nexus Console** (central) — Deno Fresh on localhost (Deno Deploy planned)

```
Nexus Console (localhost:8000)
  [Operator Switcher: Foundry | BEC]
       |              |
       v              v
  simt-nexus-mgf   simt-nexus-bec
  (Fly.io)         (Fly.io)
  gateway+worker   gateway+worker
```

## Per-Operator Fly.io App

Each Operator gets a separate Fly app with two process groups:

```
Fly App: simt-nexus-mgf (microgridfoundry org)

  Process: gateway (1 machine, always-on, public HTTP)
    - Deno.serve() on :: port 3001
    - Landing page at /
    - Public API: /api/status, /api/chat, /api/activity, /api/approvals
    - Internal API: /work/next, /work/complete (Fly 6PN)
    - In-memory work queue
    - Event log (last 100 events)

  Process: worker (1 machine, always-on, internal only)
    - Polls gateway /work/next every 2s via Fly internal DNS
    - Builds workspace in /tmp/nexus-workspace/<groupId>/
    - Runs Claude Agent SDK query()
    - Posts result to /work/complete
```

Worker reaches gateway via: `http://gateway.process.simt-nexus-mgf.internal:3001`

## Data Flow

```
1. Console POST /api/chat {"message": "..."} --> Gateway
2. Gateway enqueues WorkItem, logs event
3. Worker polls GET /work/next, receives WorkItem
4. Worker builds workspace:
   - CLAUDE.md from operator context + skills + knowledge
   - Copies skills/ and knowledge/ to /tmp workspace
5. Worker calls Agent SDK query() with:
   - cwd: /tmp/nexus-workspace/<groupId>/
   - model: sonnet
   - systemPrompt: operator context
   - env: Deno.env.toObject() (passes ANTHROPIC_API_KEY to subprocess)
6. Agent SDK spawns claude-code CLI, processes prompt
7. Worker receives result, POST /work/complete
8. Console polls GET /api/chat/response, receives answer
```

## Storage

**Current (pilot)**:
- Skills and knowledge baked into Docker image
- Operator context in dev-data/ (baked into image, selected by OPERATOR_SLUG)
- Sessions in /tmp (ephemeral, lost on redeploy)
- Work queue in-memory (lost on gateway restart)

**Planned**:
- Tigris S3 for persistent operator data, overrides, conversations
- TimescaleDB (optional) for time-series sensor data

## Upgrade System

Same Docker image deploys to all Operators. `OPERATOR_SLUG` env var selects operator context at runtime.

```bash
# Foundry first (canary)
deno task deploy:mgf
# Verify, then BEC
deno task deploy:bec
```

Skills and knowledge ship with the image — atomic deploys, no version drift.

## OneCLI Integration

OneCLI Cloud (app.onecli.sh) manages service credentials:
- Anthropic API key: direct connection (not proxied, latency-sensitive)
- Discord, Resend: will route through OneCLI cloud proxy

Gateway calls OneCLI API at startup to verify connectivity and list configured secrets.

## Docker Image

```dockerfile
FROM denoland/deno:2.1.4
+ Node.js 22 (required by claude-code CLI)
+ @anthropic-ai/claude-code (global npm install)
+ Non-root 'nexus' user (claude-code refuses --dangerously-skip-permissions as root)
+ src/, skills/, knowledge/, dev-data/ copied in
```

## Console

Separate Deno Fresh 2.0 project (`simt-console-mock`):
- Operator switcher dropdown (cookie-based persistence)
- Overview: status cards, OneCLI status, activity feed
- Chat: web chat interface with polling
- Skills: table of loaded skills
- Fleet: cross-operator status view
- API proxy: routes /api/proxy/* to selected operator's gateway

## Known Limitations

1. **In-memory queue**: Work queue lost on gateway restart. Scale to 1 gateway per app.
2. **Ephemeral sessions**: Agent SDK sessions in /tmp, lost on redeploy. Plan: persist to Tigris.
3. **No auth**: Gateway API is public. Plan: add API key auth for console access.
4. **Single region**: All machines in lhr (London). Adequate for UK energy Operators.
5. **No Discord/WhatsApp yet**: Channels planned for internal pilot. NanoClaw reference code retained.

## Operators

| Operator | App | Org | Slug | URL |
|---|---|---|---|---|
| Microgrid Foundry | simt-nexus-mgf | microgridfoundry | foundry | https://simt-nexus-mgf.fly.dev |
| Bristol Energy | simt-nexus-bec | bristolenergy | bec | https://simt-nexus-bec.fly.dev |
