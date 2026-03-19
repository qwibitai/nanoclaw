# Atlas: Discord-based AI Agent Platform

Atlas is a personal AI agent platform operated through Discord with two core capabilities:

1. **Deep Research** — `/research` command triggers multi-step autonomous research, streaming progress to a Discord thread and delivering a comprehensive markdown report.
2. **Autonomous Prototyping** — `/build` command for iterating on specs and triggering autonomous builds that produce GitHub PRs.

Atlas is a **fork of NanoClaw** (https://github.com/qwibitai/nanoclaw) with Discord instead of WhatsApp, inheriting container-per-agent isolation, CLAUDE.md memory, agent swarms, and Claude Agent SDK runtime.

---

## Architecture

```
Discord (discord.js)
├── #control (main channel)
│   • System administration and status
│   • isMain: true (admin privileges)
│   • Can see all tasks, modify Atlas code
│
├── #research → /research [topic]
│   └── Creates thread → spawns research agent container
│       └── Claude Agent SDK + web search tools
│       └── Streams progress to thread
│       └── Outputs: research.md attached to thread
│
├── #builds → /build [description]
│   └── Creates thread → iteration mode
│       └── User + Claude refine CLAUDE.md spec
│       └── "go build" → spawns builder container
│           └── Claude Agent SDK + filesystem/bash/git
│           └── Clones repo, drops CLAUDE.md, builds autonomously
│           └── Outputs: GitHub PR + optional deploy preview
│
└── NanoClaw core (inherited)
    ├── Container orchestration (Docker/Apple Container)
    ├── Per-thread CLAUDE.md memory
    ├── Agent swarms (for research sub-agents)
    ├── SQLite persistence
    └── Credential proxy
```

**Tech Stack:**
- Runtime: Node.js / TypeScript
- Discord: discord.js with slash commands
- Agent SDK: Claude Agent SDK (via container)
- Containers: Docker or Apple Container
- Database: SQLite (inherited from NanoClaw)
- GitHub: gh CLI inside containers

---

## Discord Server Structure

```
Your Private Discord Server "Atlas"
│
├── #control                    ← Main channel (isMain: true)
│   • Admin/control interface
│   • Run /status command
│   • Chat with Atlas about system
│   • Persistent conversation history
│
├── #research                   ← Research workspace
│   • Run /research [topic] here
│   • Creates threads:
│   ├── 🧵 Research: AI chip architecture
│   ├── 🧵 Research: Quantum computing
│   └── 🧵 Research: Web3 security
│
└── #builds                     ← Build workspace
    • Run /build [description] here
    • Creates threads:
    ├── 🧵 Build: Todo app with auth
    ├── 🧵 Build: Discord bot template
    └── 🧵 Build: Static site generator
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator (inherited from NanoClaw) |
| `src/channels/discord.ts` | Discord adapter (replaces WhatsApp) |
| `src/commands/research.ts` | /research slash command handler |
| `src/commands/build.ts` | /build slash command handler |
| `src/commands/status.ts` | /status slash command handler |
| `src/agents/research-prompt.ts` | Research agent system prompt |
| `src/agents/build-prompt.ts` | Builder agent system prompt |
| `src/container-runner.ts` | Container lifecycle (inherited) |
| `src/group-queue.ts` | Per-group concurrency (inherited) |
| `groups/control/` | Control channel memory (persistent) |
| `groups/thread-{id}/` | Research/build thread memory (ephemeral) |

---

## Privileges

| Context | isMain | Capabilities |
|---------|--------|--------------|
| **#control** | ✅ Yes | See all tasks, write global memory, access project root |
| **Research threads** | ❌ No | Own folder only, web search, write research.md |
| **Build threads** | ❌ No | Own workspace, git/bash/files, create PRs |

---

## Environment Variables

```
DISCORD_TOKEN=                    # Discord bot token
DISCORD_CONTROL_CHANNEL_ID=       # #control channel ID (isMain)
ANTHROPIC_API_KEY=                # For Claude Agent SDK
GITHUB_TOKEN=                     # For creating PRs from builder
```

---

## Development Commands

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run tests
./container/build.sh # Rebuild agent container
```

---

## Research Agent System Prompt

Deep, multi-step autonomous research:

1. DECOMPOSE: Break topic into 3-5 research questions
2. INVESTIGATE: Multiple searches per question, read full articles
3. EVALUATE: Assess gaps, contradictions, unsupported claims
4. DEEPEN: Targeted searches to fill gaps
5. SYNTHESIZE: Write comprehensive report to research.md

Report format:
- Executive summary (3-4 sentences)
- Findings organized by theme (not by source)
- Each claim cited with [Source](URL)
- "Confidence & Gaps" section
- Full sources list

Rules:
- Minimum 3 research passes before synthesis
- Favor depth over breadth
- Investigate conflicts, don't just note them
- Write in own words
- Update research.md after each pass (progress visibility)

---

## Builder Agent System Prompt

Autonomous code generation from CLAUDE.md spec:

1. Read CLAUDE.md thoroughly
2. Plan implementation (file structure, dependencies, key decisions)
3. Build incrementally, test after each component
4. Commit frequently with descriptive messages
5. Ensure project runs when complete

Rules:
- Follow spec precisely (document ambiguities in comments)
- Production-quality code with error handling
- Create README.md with setup/run instructions
- Final commit summarizes what was built
- Push to branch, create PR

---

## What We're NOT Building

Atlas is **not**:
- A SaaS product or multi-tenant platform
- A general-purpose chatbot
- A framework for others to extend
- A showcase of multi-model diversity
- Feature-complete before being useful

**Goal:** Ship projects faster via AI-driven deep research and autonomous building, orchestrated from Discord.
