# Contributing to Simtricity Nexus

## Development Setup

```bash
cp .env.example .env
# Set ANTHROPIC_API_KEY

deno task gateway   # Terminal 1
deno task worker    # Terminal 2
```

## Code Quality

```bash
deno task check    # Type-check
deno task fmt      # Format
deno task lint     # Lint
```

## Project Structure

New code goes in:
- `src/shared/` — shared utilities (config, logger, types, OneCLI)
- `src/gateway/` — HTTP server, work queue, API endpoints
- `src/worker/` — Agent SDK integration, workspace builder

Content:
- `skills/` — SKILL.md files (AI instructions)
- `knowledge/` — reference markdown (AI knowledge base)
- `dev-data/operators/` — per-operator context and config

## Deploying

```bash
deno task deploy:mgf    # Foundry first (canary)
deno task deploy:bec    # Then BEC
```

## License

Simtricity additions are AGPL-3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
