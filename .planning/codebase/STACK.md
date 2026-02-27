# Technology Stack

**Analysis Date:** 2026-02-27

## Languages

**Primary:**
- TypeScript 5.9.3 - Main application code and CLI tools
- Node.js/JavaScript (ES2022) - Runtime execution environment

**Secondary:**
- Bash - Container entrypoint, system utilities
- SQL - SQLite database queries

## Runtime

**Environment:**
- Node.js ≥ 20 (specified in `package.json` engines)
- Docker or Apple Container (macOS) - Agent execution

**Package Manager:**
- npm (Node Package Manager)
- Lockfile: `package-lock.json` and `pnpm-lock.yaml` (dual lock files present)
- Build tool: TypeScript compiler (`tsc`)

## Frameworks

**Core:**
- `@anthropic-ai/claude-agent-sdk` 0.2.34 (container-side) - Claude agent execution with tool capabilities
- `@whiskeysockets/baileys` 7.0.0-rc.9 - WhatsApp Web connection library (reverse-engineered protocol)
- `grammy` 1.40.0 - Telegram bot framework

**Database:**
- `better-sqlite3` 11.10.0 - Synchronous SQLite client for state management

**Build/Dev:**
- `tsx` 4.21.0 - TypeScript executor for development
- `prettier` 3.8.1 - Code formatter (config: `singleQuote: true`)
- `husky` 9.1.7 - Git hooks integration

**Testing:**
- `vitest` 4.0.18 - Unit test runner
- `@vitest/coverage-v8` 4.0.18 - Test coverage reporting

## Key Dependencies

**Critical:**
- `@modelcontextprotocol/sdk` 1.12.1 - MCP server protocol (available in container, enables tool definitions)
- `pino` 9.14.0 - Structured logging with JSON output
- `pino-pretty` 13.1.3 - Log formatting for terminal output
- `zod` 4.3.6 - Runtime type validation and schema parsing
- `cron-parser` 5.5.0 - CRON expression parsing for scheduled tasks

**Infrastructure:**
- `marked` 17.0.3 - Markdown parsing (used for Telegram HTML conversion)
- `@types/marked` 5.0.2 - TypeScript types for marked
- `yaml` 2.8.2 - YAML parsing (for configuration)
- `qrcode` 1.5.4 - QR code generation (unused in current code)
- `qrcode-terminal` 0.12.0 - Terminal QR code display for WhatsApp auth

**Container-side only:**
- `agent-browser` (global npm install) - Browser automation via Chromium with snapshot interaction
- `@anthropic-ai/claude-code` (global npm install) - Claude Code runtime in container
- `gh` (system package) - GitHub CLI for repository operations
- `gtasks` (system binary) - Google Tasks CLI tool

## Configuration

**Environment:**
- Read via `readEnvFile()` in `src/config.ts`
- Loads from `.env` file (fallback to `process.env`)
- Key config values: `ASSISTANT_NAME`, `ASSISTANT_HAS_OWN_NUMBER`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ONLY`
- Secrets NOT loaded at startup—only where needed to avoid leaking to child processes

**Build:**
- `tsconfig.json` - TypeScript configuration (ES2022 target, NodeNext module resolution)
- `.prettierrc` - Prettier config (single quotes enabled)
- `.husky/` - Git hooks directory
- `.github/workflows/` - CI/CD workflows (if present)

**Container:**
- Dockerfile (`container/Dockerfile`) - Node 22-slim base, installs Chromium, gh, gtasks, agent-browser
- `container/agent-runner/package.json` - Container-side dependencies (Claude Agent SDK, MCP SDK)
- Container entrypoint reads JSON from stdin, outputs JSON to stdout
- Mounts `/workspace/group`, `/workspace/global`, `/workspace/extra`, `/workspace/ipc/`

## Platform Requirements

**Development:**
- macOS with Docker Desktop or Apple Container runtime
- Node.js 20+
- `npm` or compatible package manager

**Production:**
- macOS (primary target)
  - Docker Desktop for container execution
  - OR Apple Container (macOS-only, native containerization)
- Linux support (via Docker)
  - Docker daemon required
- Windows support (potential via WSL2 + Docker, not yet tested)

**System Dependencies (in container only):**
- Chromium browser + system libraries for headless operation
- Git CLI (for repository operations)
- cURL (for downloading tools)

---

*Stack analysis: 2026-02-27*
