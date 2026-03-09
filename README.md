<p align="center">
  <strong>NeoPaw</strong><br>
  <em>Personal Agent Workstation for AI+X Learners</em>
</p>

<p align="center">
  Built on the NEOLAF framework. Forked from <a href="https://github.com/qwibitai/nanoclaw">NanoClaw</a>.
</p>

NeoPaw is a 24/7 personal companion agent for AI+X program learners. It bundles educational skills — course delivery, scientific writing, research, memory management — into a secure container-based agent that's always available via messaging channels or CLI.

## Quick Start

```bash
git clone https://github.com/your-org/neopaw.git
cd neopaw
claude
```

Then run `/setup`. Claude Code handles dependencies, authentication, and workspace creation.

### CLI Mode (fastest)

```bash
npm run cli
```

Launches NeoPaw directly in your terminal — no containers needed. Interactive educational agent with all NEOLAF skills.

### Service Mode (24/7)

Run `/setup` and choose a messaging channel (WhatsApp, Telegram, Slack, Discord). NeoPaw runs as a background service, responding to messages around the clock.

## What NeoPaw Can Do

### Educational Skills (built-in)

| Skill | What It Does |
|-------|-------------|
| **run-module** | Deliver AI+X course modules using the seven-step pedagogical framework |
| **kstar-loop** | Record KSTAR learning traces (Knowledge-Situation-Task-Action-Result) and build skill profiles |
| **qmd-memory** | Create flashcards, spaced repetition reviews (SM-2), and concept maps |
| **aix-explainer** | Explain the AI+X framework to any audience (30s pitch to 5min talk) |
| **scientific-writing** | Write manuscripts with IMRAD structure, citations, reporting guidelines |
| **research-lookup** | Search academic literature via Perplexity Sonar Pro |

### Platform Features

- **Dual mode** — CLI for interactive local use, channels for 24/7 mobile access
- **Container isolation** — Agents run in Docker/Apple Container with filesystem isolation
- **Per-group memory** — Each conversation group has its own isolated CLAUDE.md and workspace
- **Scheduled tasks** — Recurring jobs (daily reviews, weekly summaries)
- **Web access** — Search and fetch content from the web
- **Customizable** — Modify code directly; small enough to understand

## Learner Workspace

NeoPaw creates a structured workspace for each learner:

```
groups/cli/
├── CLAUDE.md           # NeoPaw agent identity
├── modules/            # Course content and lesson plans
├── notes/              # Study journal
│   ├── progress.json   # Module progress tracker
│   ├── kstar-traces.json  # Learning traces
│   └── memory/         # QMD flashcards and concept maps
├── research/           # Research outputs
├── papers/             # Scientific writing drafts
└── conversations/      # Archived transcripts
```

## Usage Examples

### CLI Mode
```bash
# Interactive session
npm run cli

# Single prompt
npm run cli -- "teach me about neural networks"
npm run cli -- "start module intro-to-ml"
npm run cli -- "quiz me on what I learned yesterday"
```

### Channel Mode (via messaging)
```
@Paw start module intro-to-ai
@Paw explain AI+X to me like I'm a business student
@Paw help me write the methods section for my paper
@Paw review my learning progress this week
@Paw make flashcards from today's lesson
```

## Architecture

```
CLI Mode:     Terminal → cli.ts → claude CLI (direct, no container)
Service Mode: Channel → index.ts → Container (Claude Agent SDK) → Response
```

Single Node.js process. Channels self-register at startup. Agents execute in isolated Linux containers. NEOLAF skills are synced from `container/skills/` into each agent's workspace. IPC via filesystem.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- Docker (for service mode) or [Apple Container](https://github.com/apple/container) (macOS)

### Optional

- `OPENROUTER_API_KEY` in `.env` — enables research-lookup skill (Perplexity Sonar)

## Development

```bash
npm run cli          # CLI mode (no container)
npm run dev          # Service mode with hot reload
npm run build        # Compile TypeScript
npm test             # Run tests
./container/build.sh # Rebuild agent container
```

## Customizing

Tell Claude Code what you want:
- "Add Telegram as a channel" → `/add-telegram`
- "Change the trigger word to @Neo"
- "Add a new module about data science"

Or run `/customize` for guided changes.

## License

MIT
