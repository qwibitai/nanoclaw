# AgentLite

An SDK for running Claude agents in isolated BoxLite VMs with messaging channel integration.

## SDK Usage

```typescript
import { AgentLite } from '@boxlite-ai/agentlite';
import { TelegramChannel } from '@boxlite-ai/agentlite/channels/telegram';

const agent_lite = new AgentLite();
await agent_lite.start();

await agent_lite.registerChannel(new TelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN }));
agent_lite.registerGroup('tg:7123844036', { name: 'Main', isMain: true });
```

## Quick Start

```bash
git clone https://github.com/boxlite-ai/agentlite.git
cd agentlite
npm install
npm run dev
```

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own BoxLite VM
- **Main channel** - Your private channel for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **BoxLite VM isolation** - Agents are sandboxed in hardware-isolated VMs (KVM on Linux, Hypervisor.framework on macOS)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Dynamic channels** - Register channels and groups at runtime via the SDK

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

## Requirements

- macOS (Apple Silicon) or Linux (with KVM)
- Node.js 20+
- [BoxLite](https://github.com/boxlite-ai/boxlite) runtime (installed via `npm install @boxlite-ai/boxlite`)

## Architecture

```
Channels --> SQLite --> Polling loop --> BoxLite VM (Claude Agent SDK) --> Response
```

Single Node.js process. Channels register dynamically via the SDK. Agents execute in isolated BoxLite VMs with hardware-level isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:
- `src/sdk.ts` - AgentLite SDK class (public API)
- `src/orchestrator.ts` - Orchestrator: state, message loop, agent invocation
- `src/box-runtime.ts` - BoxLite VM runtime management
- `src/container-runner.ts` - Spawns streaming agent VMs
- `src/channels/registry.ts` - Channel registry
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Is this secure?**

Agents run in hardware-isolated BoxLite VMs, not behind application-level permission checks. They can only access explicitly mounted directories. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Can I use third-party or open-source models?**

Yes. AgentLite supports any Claude API-compatible model endpoint. Set these environment variables in your `.env` file:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**How do I debug issues?**

Check `groups/{name}/logs/container-*.log` for agent execution logs, or `logs/agentlite.log` for the orchestrator log.

## License

MIT
