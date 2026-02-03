<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  My personal Claude assistant that runs securely in Firecracker microVMs. Lightweight and built to be understood and customized for your own needs.
</p>

## Why I Built This

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project with a great vision. But I can't sleep well running software I don't understand with access to my life. OpenClaw has 52+ modules, 8 config management files, 45+ dependencies, and abstractions for 15 channel providers. Security is application-level (allowlists, pairing codes) rather than OS isolation. Everything runs in one Node process with shared memory.

NanoClaw gives you the same core functionality in a codebase you can understand in 8 minutes. One process. A handful of files. Agents run in actual Firecracker microVMs with their own Linux kernel — not behind permission checks, not in Docker containers — real VM isolation.

## Quick Start

### Prerequisites

- **Ubuntu Server 24.04** (Intel x86_64)
- **Node.js 22+**
- **Firecracker v1.7.0** — [Installation guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)
- **Firecracker-compatible kernel** at `/opt/firecracker/vmlinux.bin`
- **KVM access** — your user must be in the `kvm` group
- **Claude Max subscription** + [Vercel AI Gateway](https://vercel.com/account/ai-gateway) API key

### Setup

```bash
# Clone and install
git clone https://github.com/gavrielc/nanoclaw.git
cd nanoclaw
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Vercel AI Gateway API key

# Set up Firecracker networking (creates bridge + NAT)
npm run setup-network

# Build the agent rootfs image (one-time, takes a few minutes)
npm run build-rootfs

# Authenticate WhatsApp
npm run auth

# Run NanoClaw
npm run start
```

Or use Claude Code for guided setup:

```bash
claude
```

Then run `/setup`.

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers. Have Claude Code walk you through it.

**Secure by VM isolation.** Each agent task gets its own Firecracker microVM with its own Linux kernel. Groups are fully isolated at the hypervisor level. Bash access is safe because commands run inside the microVM, not on your host.

**Built for one user.** This isn't a framework. It's working software that fits my exact needs. You fork it and have Claude Code make it match your exact needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that this is safe.

**AI-native.** No installation wizard; Claude Code guides setup. No monitoring dashboard; ask Claude what's happening. No debugging tools; describe the problem, Claude fixes it.

**Skills over features.** Contributors shouldn't add features (e.g. support for Telegram) to the codebase. Instead, they contribute [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need, not a bloated system trying to support every use case.

**Best harness, best model.** This runs Claude Code CLI directly inside microVMs. The harness matters. A bad harness makes even smart models seem dumb, a good harness gives them superpowers. Claude Code is (IMO) the best harness available.

**$0 API costs.** Uses Vercel AI Gateway to route through your existing Claude Max subscription. No per-token charges.

## What It Supports

- **WhatsApp I/O** — Message Claude from your phone
- **Isolated group context** — Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own Firecracker microVM with only that filesystem mounted
- **Main channel** — Your private channel (self-chat) for admin control; every other group is completely isolated
- **Scheduled tasks** — Recurring jobs that run Claude and can message you back
- **Web access** — Search and fetch content
- **Firecracker VM isolation** — Each agent gets its own Linux kernel, separate from the host and all other agents
- **Optional integrations** — Add Gmail (`/add-gmail`) and more via skills

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

There are no configuration files to learn. Just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Architecture

```
WhatsApp (Baileys) → SQLite → Polling Loop → Firecracker microVM (Claude Code CLI) → Response
```

Single Node.js process on the host. Each agent task boots a fresh Firecracker microVM with its own Linux kernel, runs Claude Code CLI via SSH, syncs changed files back, and destroys the VM. No persistent VM state.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Host (Ubuntu Server 24.04)                    │
│                                                                  │
│  NanoClaw (Node.js)                                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ index.ts              WhatsApp → SQLite → Poll → Dispatch │  │
│  │ firecracker-runner.ts Spawns microVM, SSH task, cleanup    │  │
│  │ task-scheduler.ts     Cron/recurring tasks                 │  │
│  └──────────────────────────┬─────────────────────────────────┘  │
│                              │                                    │
│          ┌───────────────────┼───────────────────┐               │
│  ┌───────▼───────┐  ┌───────▼───────┐  ┌────────▼──────┐       │
│  │  microVM 1    │  │  microVM 2    │  │  microVM N    │       │
│  │  (own kernel) │  │  (own kernel) │  │  (own kernel) │       │
│  │  Claude Code  │  │  Claude Code  │  │  Claude Code  │       │
│  │  172.16.0.2   │  │  172.16.0.3   │  │  172.16.0.N+1 │       │
│  └───────┬───────┘  └───────┬───────┘  └────────┬──────┘       │
│          └───────────────────┼───────────────────┘               │
│                    ┌─────────▼─────────┐                         │
│                    │ Bridge: fcbr0     │                         │
│                    │ 172.16.0.1/24     │                         │
│                    └─────────┬─────────┘                         │
│                              │ NAT                                │
└──────────────────────────────┼───────────────────────────────────┘
                               ▼
                    Vercel AI Gateway
                  (Claude Max passthrough)
```

Key files:
- `src/index.ts` — Main app: WhatsApp connection, routing, IPC
- `src/firecracker-runner.ts` — Spawns Firecracker microVMs
- `src/task-scheduler.ts` — Runs scheduled tasks
- `src/db.ts` — SQLite operations
- `groups/*/CLAUDE.md` — Per-group memory

## Vercel AI Gateway Setup

NanoClaw uses [Vercel AI Gateway](https://vercel.com/account/ai-gateway) to route Claude requests through your existing Claude Max subscription, so there are no per-token API costs.

1. Go to https://vercel.com/account/ai-gateway
2. Create or copy your API key
3. Add it to your `.env` file:
   ```
   VERCEL_AI_GATEWAY_KEY=your-key-here
   ```
4. Ensure your Claude Max subscription is active

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

## Requirements

- Ubuntu Server 24.04 (or compatible Linux with KVM support)
- Node.js 22+
- [Firecracker](https://github.com/firecracker-microvm/firecracker/releases) v1.7.0+
- [Claude Code](https://claude.ai/download)
- KVM access (`/dev/kvm`)
- Vercel AI Gateway API key + Claude Max subscription

## FAQ

**Why WhatsApp and not Telegram/Signal/etc?**

Because I use WhatsApp. Fork it and run a skill to change it. That's the whole point.

**Why Firecracker instead of Docker?**

Docker uses Linux namespaces — shared kernel isolation. Firecracker gives each agent its own Linux kernel via KVM. It's the same isolation technology AWS Lambda uses. Stronger security, and VMs boot in under 5 seconds.

**Is this secure?**

Agents run in microVMs with their own kernel, not behind application-level permission checks. They can only access files explicitly copied into the rootfs. The mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) controls what directories can be provided to agents.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach.

**What changes will be accepted into the codebase?**

Security fixes, bug fixes, and clear improvements to the base configuration. Everything else should be contributed as skills.

## License

MIT
