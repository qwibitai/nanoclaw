<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  LearnClaw is a learning-first fork of NanoClaw: an autonomous study partner that runs securely in self-hosted containers and pushes lessons, revision, and accountability through messaging.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">upstream: nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## Why LearnClaw Exists

LearnClaw starts from NanoClaw's core strength: a small, understandable, self-hosted agent architecture with real container isolation. This fork takes that base and points it at a different outcome: helping a learner move from goal to daily execution without having to decide what to study every day.

The product direction is a personal learning OS. You define an exam or learning goal, current level, and constraints. LearnClaw then structures the journey backward, keeps persistent learner memory, and uses scheduled delivery for lessons, quizzes, revision, and accountability.

## Quick Start

```bash
git clone https://github.com/iabheejit/learnclaw.git
cd learnclaw
claude
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [iabheejit/learnclaw](https://github.com/iabheejit/learnclaw) on GitHub
2. `git clone https://github.com/<your-username>/learnclaw.git`
3. `cd learnclaw`
4. `claude`

</details>

Then run `/setup`. Claude Code handles dependencies, authentication, container setup, and service configuration for the self-hosted LearnClaw runtime.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

## Philosophy

**Small enough to understand.** LearnClaw keeps NanoClaw's one-process architecture so the product remains hackable by a single builder.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted.

**Goal-aware by default.** The fork is optimized around learners, exams, study plans, revision loops, and messaging-based accountability.

**Customization = code changes.** LearnClaw remains a fork-first product. If a workflow needs to change, edit the code rather than layering configuration sprawl on top.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** LearnClaw still uses the Claude Agent SDK foundation from NanoClaw, but the product logic on top is oriented toward learning journeys.

## What It Supports

- **Self-hosted learning companion** - Use a messaging-first study partner that can plan, teach, remind, and review.
- **Multi-channel messaging** - Talk to LearnClaw from WhatsApp, Telegram, Discord, Slack, or Gmail as those skills are added to your fork.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Learning memory files** - Maintain learner profile, study plan, resources, and heartbeat files directly in the workspace.
- **Scheduled tasks** - Recurring jobs that can deliver lessons, revision prompts, quizzes, and weekly summaries.
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Docker (macOS/Linux), [Docker Sandboxes](docs/docker-sandboxes.md) (micro VM isolation), or Apple Container (macOS)
- **Credential security** - Agents never hold raw API keys. Outbound requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects credentials at request time and enforces per-agent policies and rate limits.
- **Exam package scaffolding** - Start structuring subject-specific content under `exams/` for lessons, quizzes, plans, and resources.

## Usage

Talk to your assistant with the trigger word (default: `@LearnClaw`):

```
@LearnClaw I am preparing for UPSC 2027, starting from scratch, with 2 hours every evening
@LearnClaw build my first 6-week study plan and create the files you need to track it
@LearnClaw every day at 7am send today's lesson and every night at 9pm quiz me on what I studied
```

From the main channel, you can manage study workflows and tasks:
```
@LearnClaw list all scheduled study tasks
@LearnClaw pause tonight's quiz reminder
@LearnClaw show me which files define my study plan and weak areas
```

## Customizing

LearnClaw doesn't rely on heavy configuration files. To make changes, tell Claude Code what you want:

- "Change the trigger word to @Coach"
- "Keep a WHO_I_AM.md file updated after every weekly report"
- "Create exam packages for CAT and GMAT next"
- "Use scheduled tasks to send spaced-repetition reviews instead of generic reminders"

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

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see the [documentation site](https://docs.nanoclaw.dev/concepts/architecture).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container — outbound API requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects authentication at the proxy level and supports rate limits and access policies. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

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

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT
