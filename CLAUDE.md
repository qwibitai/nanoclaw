# NeoPaw

Personal agent workstation for AI+X learners, built on the NEOLAF framework. Forked from NanoClaw.

## Quick Context

Dual-mode educational agent: **Service mode** (channels, 24/7 via containers) + **CLI mode** (local, no container). NEOLAF skills are embedded in the container agent and synced to CLI workspace. Individual learners self-deploy.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Service mode orchestrator: state, message loop, agent invocation |
| `src/cli.ts` | CLI mode entry point: workspace setup, skill sync, spawns claude |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/container-runner.ts` | Spawns agent containers with mounts + skill sync |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | NEOLAF skills (auto-synced to agents) |

## NEOLAF Skills (container/skills/)

| Skill | Purpose |
|-------|---------|
| `run-module` | Deliver AIX course modules via seven-step pedagogical framework |
| `kstar-loop` | Record KSTAR learning traces, build skill profiles |
| `qmd-memory` | Flashcards, spaced repetition, concept maps |
| `aix-explainer` | Explain AI+X framework to any audience |
| `scientific-writing` | Write manuscripts with IMRAD structure |
| `research-lookup` | Search academic literature via Perplexity Sonar |
| `agent-browser` | Browser automation (Chromium in container) |

## Instance Skills (.claude/skills/)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

```bash
npm run cli          # CLI mode (no container)
npm run dev          # Service mode with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
npm test             # Run tests
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.neopaw.plist
launchctl unload ~/Library/LaunchAgents/com.neopaw.plist
launchctl kickstart -k gui/$(id -u)/com.neopaw  # restart

# Linux (systemd)
systemctl --user start neopaw
systemctl --user stop neopaw
systemctl --user restart neopaw
```
