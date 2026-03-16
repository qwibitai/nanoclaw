<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

<h2 align="center">🐳 Now Runs in Docker Sandboxes</h2>
<p align="center">Every agent gets its own isolated container inside a micro VM.<br>Hypervisor-level isolation. Millisecond startup. No complex setup.</p>

**macOS (Apple Silicon)**
```bash
curl -fsSL https://nanoclaw.dev/install-docker-sandboxes.sh | bash
```

**Windows (WSL)**
```bash
curl -fsSL https://nanoclaw.dev/install-docker-sandboxes-windows.sh | bash
```

> Currently supported on macOS (Apple Silicon) and Windows (x86). Linux support coming soon.

<p align="center"><a href="https://nanoclaw.dev/blog/nanoclaw-docker-sandboxes">Read the announcement →</a>&nbsp; · &nbsp;<a href="docs/docker-sandboxes.md">Manual setup guide →</a></p>

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

### Container Mode (default — Docker + Claude Agent SDK)

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

### CLI Mode (no Docker required)

NanoClaw can run without Docker by spawning a CLI tool directly on the host. This supports **Claude CLI** and **Cursor CLI** as agent backends.

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
npm install
```

Create a `.env` file (see `.env.example`) and set the backend:

```bash
# Use Claude CLI as the agent backend
AGENT_BACKEND=cli
AGENT_CLI=claude
```

```bash
# Or use Cursor CLI as the agent backend
AGENT_BACKEND=cli
AGENT_CLI=cursor
```

Then start NanoClaw:

```bash
npm run dev
```

> **CLI mode vs Container mode:** CLI mode is simpler (no Docker needed) and lets you choose your agent tool. Container mode provides full sandbox isolation where each agent runs in its own Linux container. You can switch between them at any time by changing `AGENT_BACKEND` in `.env`.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the Claude Agent SDK, which means you're running Claude Code directly. Claude Code is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in [Docker Sandboxes](https://nanoclaw.dev/blog/nanoclaw-docker-sandboxes) (micro VM isolation), Apple Container (macOS), or Docker (macOS/Linux)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

**Session Management**
- `/clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

## Requirements

**All modes:**
- macOS or Linux
- Node.js 20+

**Container mode** (default):
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

**CLI mode** (no Docker):
- [Claude Code](https://claude.ai/download) — when `AGENT_CLI=claude`
- [Cursor](https://cursor.com) — when `AGENT_CLI=cursor`

## Architecture

```
                                ┌─ Container (Claude Agent SDK)  ── Docker isolation
Channels --> SQLite --> Polling loop ──┤
                                └─ CLI (claude / cursor)         ── Direct host execution
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. The `AGENT_BACKEND` setting controls how agents run:

- **Container mode**: Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. A credential proxy injects API keys so containers never see real secrets.
- **CLI mode**: Agents are spawned as CLI subprocesses on the host (`claude -p` or `cursor`). No Docker required. The CLI tool handles its own authentication. Session IDs are tracked for conversation continuity.

Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers (container mode)
- `src/cli-runner.ts` - Spawns CLI agent processes (CLI mode)
- `src/config.ts` - All configuration including `AGENT_BACKEND` and `AGENT_CLI`
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## CLI Mode Configuration

All CLI settings are configured via environment variables in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BACKEND` | `container` | `container` (Docker) or `cli` (direct CLI) |
| `AGENT_CLI` | `claude` | Which CLI tool: `claude` or `cursor` |
| `AGENT_CLI_COMMAND` | *(auto)* | Override the binary path (e.g., `/usr/local/bin/claude`) |
| `AGENT_CLI_EXTRA_ARGS` | *(none)* | Extra CLI arguments, comma-separated (e.g., `--model,sonnet`) |
| `CLI_TIMEOUT` | `600000` | Timeout in ms (default: 10 minutes) |

**Claude CLI preset** uses `claude -p` with `--output-format stream-json` for streaming results and `--resume` for session continuity. Each group maintains its own session.

**Cursor CLI preset** uses `cursor agent --message` by default. Override the command and arguments via `AGENT_CLI_COMMAND` and `AGENT_CLI_EXTRA_ARGS` to match your Cursor version.

**Custom CLI tool:** Set `AGENT_CLI_COMMAND` to any executable that accepts a prompt and returns text on stdout. Pair with `AGENT_CLI_EXTRA_ARGS` for custom flags.

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports any Claude API-compatible model endpoint. Set these environment variables in your `.env` file:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

This allows you to use:
- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments with Anthropic-compatible APIs

Note: The model must support the Anthropic API format for best compatibility.

**Can I use Cursor instead of Claude Code?**

Yes. Set `AGENT_BACKEND=cli` and `AGENT_CLI=cursor` in your `.env`. NanoClaw will spawn Cursor CLI instead of running Claude inside Docker containers. This means no Docker is required, but agents run on the host without container isolation. You can switch between `claude` and `cursor` at any time by changing `AGENT_CLI`.

**What's the difference between container mode and CLI mode?**

Container mode runs each agent in an isolated Docker container with its own filesystem — the agent can't see or modify anything outside its mounted directories. CLI mode spawns the agent directly on the host, which is simpler to set up but provides no sandbox isolation. Container mode also includes a credential proxy that prevents agents from seeing your API keys.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and migration notes.

## License

MIT
