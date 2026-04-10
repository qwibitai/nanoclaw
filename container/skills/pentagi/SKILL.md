---
name: pentagi
description: "PentAGI - Penetration testing Artificial General Intelligence. Fully autonomous AI pentest system. Use for: pentest, penetration testing, automated vulnerability scanning, security assessment. Docker-based with 20+ security tools, multi-agent architecture, knowledge graph memory. Located at ~/d/git/pentagi/. NOT for routine code review."
---

# PentAGI Skill

[PentAGI](https://github.com/vxcontrol/pentagi) — Penetration testing Artificial General Intelligence. Fully autonomous multi-agent pentesting system with sandboxed Docker execution, knowledge graph memory, and 20+ built-in security tools.

## Location

`~/d/git/pentagi/`

## Prerequisites

- **Docker + Docker Compose** must be running
- **LLM API key** (Anthropic, OpenAI, Ollama, etc.) set in `.env`
- Minimum **16GB RAM** recommended for full stack

## Quick Start

```bash
cd ~/d/git/pentagi

# First time setup
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY or other LLM provider

# Start the full stack
docker compose up -d

# Access UI
# http://localhost:3000 (Frontend)
# http://localhost:8080 (API)
```

## Architecture

Multi-agent system with specialist roles:

| Agent | Role |
|-------|------|
| Orchestrator | Coordinates flow, queries memory, plans tasks |
| Researcher | Analyzes target, searches for vulnerabilities |
| Developer | Plans attack strategies, selects exploits |
| Executor | Runs security tools in sandboxed containers |
| Adviser/Mentor | Monitors execution, prevents loops (optional) |
| Reflector | Handles errors, graceful termination |

Key subsystems:
- **Knowledge Graph** — Neo4j + Graphiti for semantic memory
- **Vector Store** — PostgreSQL/pgvector for embeddings
- **Security Tools** — 20+ tools (nmap, metasploit, sqlmap, etc.) in sandboxed Docker
- **Web Scraper** — Isolated browser for live recon
- **Monitoring** — Grafana + Prometheus + Loki dashboards

## Environment Variables

```bash
# Core LLM
ANTHROPIC_API_KEY=
OPEN_AI_KEY=

# Execution monitoring (optional, recommended for small models)
EXECUTION_MONITOR_ENABLED=true
EXECUTION_MONITOR_SAME_TOOL_LIMIT=5
EXECUTION_MONITOR_TOTAL_TOOL_LIMIT=10

# Task planning (optional)
AGENT_PLANNING_STEP_ENABLED=true

# API authentication
API_BEARER_TOKEN=your-token-here
```

## Key Features

- **Execution Monitoring** — Beta feature. Adviser agent intervenes when it detects loops or stuck execution. 2x quality improvement on smaller models (<32B). Enable with `EXECUTION_MONITOR_ENABLED=true`
- **Task Planning** — Beta feature. Planner decomposes complex attacks into 3-7 actionable steps before execution. Enable with `AGENT_PLANNING_STEP_ENABLED=true`
- **Smart Memory** — Learns from past pentests. Stores successful approaches for reuse
- **Chain Summarization** — Manages context window growth automatically

## Comparing to Other Tools

| Tool | Scope | Model | Best For |
|------|-------|-------|----------|
| **pentagi** | Full pentest, multi-agent, 20+ tools | Any LLM | Production autonomous pentesting |
| **shannon** | Full pentest, 5-phase | Claude only | White-box analysis + POC exploits |
| **argus** | Reconnaissance | N/A | Quick surface scans |
| **webcopilot** | Lightweight scan | N/A | Known CVE patterns |

PentAGI is the heaviest option — full Docker stack, Neo4j, PostgreSQL, multi-agent orchestration. Use when you need fully autonomous pentesting with memory and planning.

## Tips

- For small models (<32B): enable both Execution Monitoring and Task Planning for 2x better results
- Adviser agent works best with a stronger model or max reasoning mode
- First run: `docker compose up -d` pulls ~5-10GB of images. Wait before accessing UI
- API docs: Swagger at `http://localhost:8080/swagger/` after startup
- Reports generated per pentest flow — check the UI or API for artifacts
