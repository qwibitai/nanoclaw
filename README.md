# Simtricity Nexus

AI agent platform for energy community Operators. Nexus is the first product every Operator receives — providing an AI assistant that knows their energy business, communicates with staff, handles supplier interactions, and bridges to other Simtricity products.

## Quick Start

```bash
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env

deno task gateway   # Start gateway on port 3001
deno task worker    # Start worker (separate terminal)
```

Test: `curl http://localhost:3001/health`

Chat: `curl -X POST http://localhost:3001/api/chat -H 'Content-Type: application/json' -d '{"message":"What is Simtricity?"}'`

## Architecture

```
Console (Deno Fresh)          Gateway (Deno)              Worker (Deno)
localhost:8000                localhost:3001

  Browser --> /api/proxy/* --> POST /api/chat
                               | enqueue work
                               |                          polls GET /work/next
                               |<------------------------ picks up work
                               |                          builds workspace
                               |                          calls Agent SDK
                               |<------------------------ POST /work/complete
  polls /api/chat/response <---| returns result
```

**Gateway**: HTTP server with in-memory work queue, event log, public API, and internal worker API. One instance per Operator.

**Worker**: Polls gateway for work, assembles workspace from skills + knowledge + operator context, runs Claude Agent SDK, returns result.

**Console**: Separate Deno Fresh app (`simt-console-mock`) with operator switcher for multi-operator management.

## Operator Configuration

Each Operator gets its own Fly.io app running the same Docker image. `OPERATOR_SLUG` selects which operator context to use at runtime.

```
dev-data/operators/
  foundry/          # Microgrid Foundry
    config.json     # Products, channels
    context.md      # Who they are, their communities
    team.json       # Staff contacts
  bec/              # Bristol Energy
    config.json
    context.md
    team.json
```

## Deployment

Deployed to Fly.io with two process groups (gateway + worker) per Operator app.

```bash
deno task deploy:mgf    # Microgrid Foundry (microgridfoundry org)
deno task deploy:bec    # Bristol Energy (bristolenergy org)
```

Per-operator secrets set via `fly secrets set`:
- `ANTHROPIC_API_KEY` — Claude API access
- `OPERATOR_SLUG` / `OPERATOR_NAME` — Operator identity
- `GATEWAY_URL` — Internal DNS for worker (`http://gateway.process.<app>.internal:3001`)
- `ONECLI_API_KEY` — OneCLI Cloud vault (optional)

## Skills and Knowledge

Skills (`skills/`) and knowledge (`knowledge/`) are baked into the Docker image, ensuring atomic deploys.

```
skills/
  platform-knowledge/SKILL.md    # Simtricity product expertise
  escalation/SKILL.md            # When to hand off to humans

knowledge/
  simtricity/
    products.md                  # Nexus, Flux, Flows, Spark, Skyprospector
    glossary.md                  # MPAN, COP11, dispatch, etc.
    onboarding.md                # Operator setup steps
  energy/
    uk-markets.md                # UK wholesale electricity markets
```

## OneCLI Integration

[OneCLI Cloud](https://app.onecli.sh) manages service credentials (Discord, Resend). The Anthropic API key is direct (not proxied) for latency. Other service credentials route through OneCLI's cloud proxy for policy enforcement and audit logging.

## Project Structure

```
src/
  shared/        # Config, logger, env, types, OneCLI client
  gateway/       # HTTP server, work queue, event log, skills loader
  worker/        # Poll loop, Agent SDK, workspace builder, sessions
skills/          # SKILL.md files (AI instructions)
knowledge/       # Reference docs (AI knowledge base)
dev-data/        # Per-operator config and context
Dockerfile       # Deno + Node.js + claude-code CLI
fly.toml         # Fly.io multi-process config
```

NanoClaw reference code remains in `src/` root, `src/channels/`, `.claude/skills/`, `container/`, `setup/`, and `docs/` for future adaptation of channel and skill patterns.

## Heritage

Forked from [NanoClaw](https://github.com/qwibitai/nanoclaw) (MIT, Copyright 2026 Gavriel). Simtricity additions are AGPL-3.0. The `upstream-main` branch tracks upstream NanoClaw for reference.

## License

AGPL-3.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for details and dependency attribution.
