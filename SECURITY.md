# Security

## Reporting Vulnerabilities

Report security issues to damon@simtricity.com. Do not open public issues for security vulnerabilities.

## Architecture

- **Operator isolation**: Each Operator runs in a separate Fly.io app with separate secrets
- **API keys**: Anthropic API key in Fly Secrets (env vars), never in code or Docker image
- **OneCLI**: Service credentials (Discord, Resend) managed via OneCLI Cloud proxy
- **Non-root**: Docker container runs as non-root `nexus` user
- **No Bash tool**: Customer-facing agent sessions exclude the Bash tool from allowedTools

## Credential Management

- `ANTHROPIC_API_KEY` — Fly Secrets, direct connection (not proxied)
- `ONECLI_API_KEY` — Fly Secrets, used to connect to OneCLI Cloud vault
- Service credentials — stored in OneCLI Cloud, injected via proxy at request time
- `.env` — local development only, gitignored
