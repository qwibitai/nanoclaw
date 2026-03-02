# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

**Email:** security@nanoclaw.dev

Please do **not** open a public GitHub issue for security vulnerabilities. We'll respond within 48 hours and work with you on a fix.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Security Model

See [docs/SECURITY.md](docs/SECURITY.md) for the full security architecture, including:

- Container isolation model
- Mount security and credential handling
- IPC authorization
- Trust boundaries

## Key Security Properties

- **Container isolation** — each agent runs in an isolated Docker container with only explicitly mounted directories visible
- **Non-root execution** — containers run as unprivileged `node` user (uid 1000)
- **Credential filtering** — only allowlisted environment variables are passed to containers
- **Session isolation** — groups cannot see each other's conversation history
- **Ephemeral containers** — fresh environment per invocation (`--rm`)
