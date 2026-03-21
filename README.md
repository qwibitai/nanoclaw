# Atlas

A personal AI agent platform operated through Discord. Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) with a Discord frontend, deep research, autonomous building, and scheduled briefings.

---

## Features

| Command | What it does |
|---|---|
| `/research [topic]` | Spawns a research agent in a Discord thread. Uses Brave Search for discovery, Llama 3.1 for page summarization, Claude Sonnet for synthesis. Delivers a verified report as a file attachment. |
| `/build [description]` | Opens a spec thread. Iterate on `CLAUDE.md` with Claude, then trigger an autonomous build that produces a GitHub PR. |
| `/report [topic] [schedule]` | Schedules recurring briefings to a channel. Auto-detects job listing topics and switches format. Runs on Claude Haiku to keep costs low. |
| `/status` | Shows active containers, registered groups, and scheduled tasks. |

---

## Stack

- **Runtime:** Node.js / TypeScript
- **Discord:** discord.js with slash commands
- **Agent runtime:** Claude Agent SDK (via Docker container per agent)
- **Local LLMs:** Ollama + Llama 3.1 8B (page summarization, free)
- **Search:** Brave Search MCP (token-efficient discovery)
- **Database:** SQLite
- **GitHub:** `gh` CLI inside build containers

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/harris-mohamed/atlas.git
cd atlas
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
DISCORD_TOKEN=               # Discord bot token
DISCORD_CONTROL_CHANNEL_ID=  # #control channel ID
ANTHROPIC_API_KEY=           # Claude API key
GITHUB_TOKEN=                # GitHub PAT (for /build PR creation)
BRAVE_API_KEY=               # Brave Search API key (free tier: brave.com/search/api)
TZ=America/Denver            # Your timezone
```

### 3. Start Ollama (local LLMs)

Requires Docker with NVIDIA Container Toolkit for GPU support.

```bash
# Install NVIDIA Container Toolkit (first time only)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Start Ollama + pull Llama 3.1 8B (~5GB, one-time)
docker compose up -d
```

Llama 3.1 8B pulls automatically on first run. Open WebUI is available at `http://localhost:3000` (or `http://titan.local:3000` with mDNS).

To enable mDNS hostname resolution on your network:
```bash
sudo apt install avahi-daemon -y && sudo systemctl enable --now avahi-daemon
```

### 4. Build the agent container

```bash
./container/build.sh
```

### 5. Run Atlas

```bash
# Development
npm run dev

# Production (systemd)
systemctl --user start nanoclaw
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Discord bot token |
| `DISCORD_CONTROL_CHANNEL_ID` | ✅ | Channel ID for `#control` (admin interface) |
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `GITHUB_TOKEN` | Optional | GitHub PAT for `/build` PR creation |
| `BRAVE_API_KEY` | Optional | Brave Search API key. Free tier: 2,000 queries/month |
| `OLLAMA_HOST` | Optional | Ollama endpoint. Default: `http://host.docker.internal:11434` |
| `TZ` | Optional | Timezone for cron schedules. Default: system timezone |
| `LOG_LEVEL` | Optional | `trace`, `debug`, `info`, `warn`, `error`. Default: `info` |

---

## Architecture

```
Discord
├── #control          → isMain: true (admin, sees all tasks)
├── Research threads  → /research creates thread → container → research-verified.md attached
└── Build threads     → /build creates thread → spec iteration → container → GitHub PR

Each container run:
  Claude Agent SDK
  ├── Brave Search MCP  (discovery, uses snippets to triage)
  ├── Ollama MCP        (llama3.1:8b, summarizes fetched pages before Claude reads them)
  └── NanoClaw IPC MCP  (task management, group state)
```

**Cost optimizations:**
- Brave Search replaces full-page browsing for discovery (~3:1 search-to-fetch ratio)
- Ollama summarizes pages locally before they enter Claude's context window
- `/report` tasks use Claude Haiku (~10x cheaper than Sonnet)
- Credential proxy injects `cache_control` on all system prompts (caches CLAUDE.md across API calls)

---

## CI/CD

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Pull request to `main` | Format check, typecheck, tests |
| `bump-version.yml` | Push to `main` (src/ or container/) | Bumps patch version in `package.json` |

**Required GitHub setting:** Settings → Actions → General → Workflow permissions → **Read and write permissions** (needed for the version bump commit).

---

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run tests
npm run format       # Format source files
./container/build.sh # Rebuild agent container
```

---

## Key Files

| File | Purpose |
|---|---|
| `src/index.ts` | Orchestrator — message loop, agent invocation |
| `src/channels/discord.ts` | Discord adapter — slash commands, thread management |
| `src/commands/research.ts` | `/research` command |
| `src/commands/build.ts` | `/build` command |
| `src/commands/report.ts` | `/report` command |
| `src/commands/status.ts` | `/status` command |
| `src/agents/research-prompt.ts` | Research agent system prompt |
| `src/agents/build-prompt.ts` | Builder agent system prompt |
| `src/credential-proxy.ts` | Injects API keys + prompt caching headers |
| `src/task-scheduler.ts` | Cron-based task runner |
| `container/Dockerfile` | Agent container (Claude Code + Brave MCP + Ollama MCP + gh CLI) |
| `docker-compose.yml` | Ollama + Open WebUI |
| `groups/*/CLAUDE.md` | Per-group agent memory |

---

## Based On

Atlas is a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) with Discord replacing WhatsApp and Atlas-specific research/build capabilities added on top.

---

## License

MIT
