<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  A personal Claude assistant harness with a truthful runtime story: tmux host sessions today, explicit security boundaries today, and isolated runtimes as the next architectural step.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

> Current implementation note: NanoClaw does not currently default to Docker, Apple Container, or micro-VM isolation. The shipping runtime is `tmux` host execution with explicit mounts, a credential proxy, sender allowlists, and narrow admin paths. See [docs/RUNTIME_COMPATIBILITY.md](docs/RUNTIME_COMPATIBILITY.md), [docs/SECURITY.md](docs/SECURITY.md), and [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw keeps the core small enough to reason about. The current repo runs agent work in tmux sessions on the host. That is a less ambitious isolation model than containers or micro-VMs, but it is now described honestly and instrumented like a real production harness instead of being marketed as something it is not.

## Quick Start

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

Then run `/setup`. Claude Code handles dependencies, authentication, tmux runtime checks, and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Truth over positioning.** The current default runtime is tmux host execution. Security today comes from explicit mounts, read-only project access for the main group, per-group session state, sender allowlists, a credential proxy, and narrow host-exec controls. That is materially safer than a monolithic shared agent, but it is not container isolation.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**

- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Runtime adapter, not runtime drift.** The codebase now has a runtime abstraction so future Docker, Apple Container, or micro-VM work can happen behind a clean seam instead of leaking old claims into every doc and subsystem.

## What Ships In Core

- **Telegram channel code in-repo** - The core repo currently includes Telegram. Other channels should land as skills or downstream forks.
- **Per-group context** - Each group has isolated files, `CLAUDE.md`, sessions, and mounts.
- **Main channel controls** - Admin actions, group registration, and cross-group task visibility belong to the main group.
- **Scheduled tasks** - Recurring or one-time jobs run in group context and can reply back.
- **Agency HQ orchestration** - Dispatch slots, worktrees, stall detection, and recovery flows are built in.
- **Session lifecycle commands** - `/compact` and `/clear` are implemented in core.
- **Operational health** - `GET /skills` and `GET /health` are served from the main process.
- **Credential proxy and mount security** - Real Anthropic credentials stay on the host; mounts are validated against explicit rules.

## Installation-Specific Or Experimental

- **Additional channels and integrations** - Add them with skills or downstream forks.
- **Agent teams / swarms** - Claude Code capability may be enabled, but NanoClaw does not ship a dedicated swarm UX.
- **Remote control** - Present, but still experimental and main-group only.
- **Container or micro-VM runtimes** - Target architecture, not the current default.

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

Session lifecycle commands are available in core:

```
/compact
/clear
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Requirements

- macOS or Linux with `tmux`
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- Windows via WSL is experimental
- Windows native is not currently supported

## Operations

Runtime and service checks:

```bash
npm run smoke:runtime
npm run smoke:health
```

Build paths:

```bash
npm run build:core
npm run build:agent-runner
```

## Architecture

```text
Channels -> SQLite -> Queue/Scheduler -> tmux session -> credential proxy -> Claude API
```

Single Node.js process. Channels self-register at startup. Group work is queued and executed in tmux sessions with explicit host mounts. The runtime adapter keeps future isolated runtimes possible without changing the orchestration contract again.

Key files:

- `src/runtime-adapter.ts` - Runtime descriptor and tmux adapter
- `src/container-runner.ts` - Session spawn path, mount assembly, and output wiring
- `src/session-settings.ts` - Per-group Claude config and runtime env bootstrap
- `src/lifecycle.ts` - Startup, health wiring, channels, and subsystem orchestration
- `src/dispatch-pool.ts` - Slot lifecycle, startup recovery, and drain behavior
- `src/ipc.ts` - Filesystem IPC watcher and handler routing
- `src/service-health.ts` - `/health` snapshot builder

## Contributing

Core changes should focus on correctness, security, deploy safety, observability, and simplification.

Feature growth should usually be a skill.

If you want to add a channel, workflow, or integration, prefer a skill or downstream fork instead of expanding the base repo.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**

- `/add-signal` - Add Signal as a channel

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/SKILL_AUTHORING.md](docs/SKILL_AUTHORING.md), and [docs/SKILL_CONFLICT_RECOVERY.md](docs/SKILL_CONFLICT_RECOVERY.md).

## FAQ

**Why tmux instead of containers right now?**

Because that is what the current code actually runs. The repo now describes the tmux host runtime honestly and isolates future runtime work behind a dedicated adapter.

**Is this secure?**

Safer than a monolithic shared agent, yes. Container-isolated by default, no. The current model is host execution with explicit boundaries. Read [docs/SECURITY.md](docs/SECURITY.md) before trusting it with sensitive host access.

**Can I run this on Linux?**

Yes. Linux is the primary tmux runtime target.

**Can I run this on Windows?**

Only via WSL for now, and that path should still be treated as experimental.

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

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Security fixes, bug fixes, deploy hardening, correctness improvements, and simplifications.

Most new capabilities should be skills.

## Documentation

- [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)
- [docs/RUNTIME_COMPATIBILITY.md](docs/RUNTIME_COMPATIBILITY.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/SPEC.md](docs/SPEC.md)
- [docs/SETUP_RECOVERY.md](docs/SETUP_RECOVERY.md)
- [docs/SKILL_AUTHORING.md](docs/SKILL_AUTHORING.md)

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and migration notes.

## License

MIT
