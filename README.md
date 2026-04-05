<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  NanoClaw fork with an Idea Maze product discovery pipeline. Harvests signals from Gmail, Reddit, and Telegram channels → extracts insights → clusters opportunities → drafts research with human approval gating.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Setup

This is a personal fork. To set up on a new machine:

```bash
git clone <this-repo>
cd idea-maze-claw
npm install
npm run build
claude
```

Then run `/setup` to configure Telegram and OneCLI credentials. Initialize the pipeline database:

```bash
cd groups/idea-maze/scripts && npx tsx init-db.ts
```

For a deployed VPS, use `./scripts/monitor-vps.sh` for a one-command health summary of the server, NanoClaw service, OneCLI, and Idea Maze databases. Add `--follow` to tail live service logs.

> **Note:** Commands prefixed with `/` are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt.

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

## Idea Maze Pipeline

The `groups/idea-maze/` workspace runs a five-stage product discovery pipeline:

| Stage | Script | Output |
|-------|--------|--------|
| **Harvest** | `ingest-gmail.ts`, `ingest-reddit.ts`, `ingest-telegram.ts` | `source_items` with harvest scores |
| **Insights** | `extract-insights.ts` | Typed signals: pain points, demand signals, workflow gaps, etc. |
| **Opportunities** | `refresh-opportunities.ts` | Clustered opportunities scored by evidence and diversity |
| **Research** | `research-opportunity.ts <slug>` | Draft thesis with optional web enrichment → lands in `review_gate` |
| **Artifacts** | `approve-run.ts <run_id>` | Markdown reports in `data/artifacts/YYYY/MM/DD/` |

Pipeline state lives in `groups/idea-maze/data/lab.db` (separate from NanoClaw's `store/messages.db`). Raw snapshots are immutable. Research runs require human approval before artifacts are written.

Full pipeline runs automatically on a schedule via NanoClaw's task system. Run `tsx run-pipeline.ts` to trigger manually.

## What It Supports

- **Telegram operator interface** - Control the pipeline, trigger harvests, review/approve research runs, and check status from Telegram
- **Idea Maze pipeline** - Automated ingestion from Gmail, Reddit, and Telegram channels with scoring, insight extraction, opportunity clustering, and approval-gated research
- **Isolated group context** - Each group has its own `CLAUDE.md` memory and isolated filesystem; the `idea-maze` group is the dedicated pipeline workspace
- **Main channel** - Your private Telegram self-chat for admin control; pipeline group is completely isolated
- **Scheduled tasks** - Recurring pipeline jobs: ingest every hour, insights every 2h, opportunity refresh daily at 06:00, weekly digest Monday at 08:00, raw cleanup nightly
- **Web access** - Search and fetch content from the Web during research drafting when `TAVILY_API_KEY` is available
- **Container isolation** - Agents run in Linux containers with only the group folder mounted
- **Credential security** - Agents never hold raw API keys. Outbound requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects credentials at request time and enforces per-agent policies and rate limits.

## Usage

Talk to the assistant with the trigger word (default: `@Andy`) from Telegram:

**Pipeline control (from the idea-maze chat):**
```
@Andy run harvest
@Andy extract insights
@Andy refresh opportunities
@Andy research <opportunity-slug>
@Andy show pending research runs
@Andy approve run 42
@Andy reject run 42 not enough evidence
```

**Status and queries:**
```
@Andy pipeline status
@Andy top opportunities
@Andy show recent insights
```

**From the main channel (your self-chat):**
```
@Andy list all scheduled tasks
@Andy pause the pipeline schedule
@Andy set reddit subreddits to ["SaaS","indiehackers","webdev"]
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

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Telegram --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
                                              |
                                    groups/idea-maze/
                                      scripts/*.ts
                                      data/lab.db
```

Single Node.js process. Telegram registers as the operator channel at startup. Agents execute in isolated Linux containers with only the group folder mounted. The idea-maze group runs the discovery pipeline; the main chat is for admin control.

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/idea-maze/CLAUDE.md` - Idea Maze workspace memory
- `groups/idea-maze/scripts/` - Pipeline scripts (ingest, insights, opportunities, research, approval)
- `groups/idea-maze/data/lab.db` - Domain database (source items, insights, opportunities, runs, artifacts)
- `container/skills/idea-maze/SKILL.md` - Container skill loaded into the idea-maze agent

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
