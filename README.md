<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Powered by OpenCode + any OpenAI-compatible LLM. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
gh repo fork wpcapaper/nanoclaw-oc --clone --branch feat/oc-migration
cd nanoclaw-oc
opencode
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [wpcapaper/nanoclaw-oc](https://github.com/wpcapaper/nanoclaw-oc) on GitHub (click the Fork button)
2. `git clone --branch feat/oc-migration https://github.com/<your-username>/nanoclaw-oc.git`
3. `cd nanoclaw-oc`
4. `opencode`

</details>

Then run `/setup`. OpenCode handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are skills. Type them inside the OpenCode CLI prompt, not in your regular terminal.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask your assistant to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have OpenCode modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**

- No installation wizard; OpenCode guides setup.
- No monitoring dashboard; ask the assistant what's happening.
- No debugging tools; describe the problem and the assistant fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit skills like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Universal LLM compatibility.** NanoClaw uses OpenCode, supporting any OpenAI-compatible LLM via LM Studio, Ollama, or cloud providers. Run local models for privacy or use cloud APIs. The skills system (`.claude/skills/**/SKILL.md`) and `CLAUDE.md` memory conventions remain fully supported for backward compatibility.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run agents and can message you back
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

NanoClaw doesn't use configuration files. To make changes, just tell your assistant what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that the assistant can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**

- `/add-signal` - Add Signal as a channel

**Session Management**

- `/clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session).

## Requirements

- macOS or Linux
- Node.js 20+
- [OpenCode](https://github.com/opencode-ai/opencode)
- LM Studio, Ollama, or any OpenAI-compatible LLM endpoint
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Installation

### 1. Install OpenCode CLI

```bash
npm install -g opencode
```

Or install via Homebrew:

```bash
brew install opencode-ai/tap/opencode
```

### 2. Install oh-my-opencode Plugin (Required)

The [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) plugin provides compaction hooks and context management features that NanoClaw depends on. Without it, context compaction (summarizing long conversations to stay within token limits) will not work properly.

```bash
opencode plugins add oh-my-opencode
```

The plugin configuration is already set up in `.opencode/oh-my-opencode.jsonc` with non-essential hooks disabled, keeping only the compaction-related functionality that NanoClaw needs.

### 3. Verify Installation

```bash
opencode --version
```

Then start NanoClaw setup:

```bash
opencode
/setup
```

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (OpenCode + LLM) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

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

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell the assistant to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw works with any OpenAI-compatible LLM endpoint via a flexible JSON configuration system.

**Primary Method: JSON Configuration (Recommended)**

Set `NANOCLAW_LLM_CONFIG` with a JSON object specifying your provider and model:

```bash
NANOCLAW_LLM_CONFIG='{
  "provider": {
    "openai-compatible": {
      "options": {
        "baseURL": "http://host.docker.internal:1234/v1",
        "apiKey": "not-needed"
      }
    }
  },
  "model": "openai-compatible/your-model-name"
}'
```

You can also override just the model with `NANOCLAW_LLM_MODEL`:

```bash
NANOCLAW_LLM_MODEL=openai-compatible/llama3.1
```

**Examples**

LM Studio (local):

```bash
NANOCLAW_LLM_CONFIG='{
  "provider": {
    "openai-compatible": {
      "options": {
        "baseURL": "http://host.docker.internal:1234/v1",
        "apiKey": "not-needed"
      }
    }
  },
  "model": "openai-compatible/your-model"
}'
```

Ollama (local):

```bash
NANOCLAW_LLM_CONFIG='{
  "provider": {
    "openai-compatible": {
      "options": {
        "baseURL": "http://host.docker.internal:11434/v1",
        "apiKey": "not-needed"
      }
    }
  },
  "model": "openai-compatible/llama3.1"
}'
```

OpenRouter (cloud):

```bash
NANOCLAW_LLM_CONFIG='{
  "provider": {
    "openai-compatible": {
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKey": "your-api-key"
      }
    }
  },
  "model": "openai-compatible/openai/gpt-4o-mini"
}'
```

**Legacy Method: Environment Variables**

For backward compatibility, you can still use individual environment variables:

```bash
NANOCLAW_LLM_BASE_URL=http://localhost:1234/v1
NANOCLAW_LLM_MODEL_ID=your-model-name
NANOCLAW_LLM_API_KEY=your-api-key
```

If `NANOCLAW_LLM_CONFIG` is not set, these variables will be used to construct the provider configuration automatically.

**How do I debug issues?**

Ask your assistant. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, the assistant will try to dynamically fix them. If that doesn't work, run `opencode`, then run `/debug`. If you find an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

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
