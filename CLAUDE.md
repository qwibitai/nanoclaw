# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Standard Toolset

Full tool manifest at `/home/psg/TOOLS_MANIFEST.md`. Key tools to prefer over custom code:

**Data & Analytics:** `sqlite3`, `jq`, `duckdb`, `xsv`

**ML / RAG Stack:**
- `Docling` — Structured PDF/XLSX extraction → heading-aware markdown; venv at `~/.local/share/docling/.venv`
- `LlamaIndex` — RAG pipeline (chunking, embedding, vector store, query engine); use project-local `.venv`
- `ChromaDB` — Embedded vector store (SQLite-backed, no server); `chromadb.PersistentClient(path=...)` — keep storage local, not S3 (random I/O)

**Scripting:** `just` (Justfile over Makefile), `entr` (auto-run on file change)

**Monitoring:** `lnav` (log viewer), `btop` (system monitor)

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## VPS Reboot Procedures

**BEFORE any VPS reboot/rescale:** Use the automation scripts (recommended) or `/home/psg/REBOOT_CHECKLIST.md`.

### Quick Start (Automation)
```bash
# Pre-reboot: gracefully stop all services
bash /home/psg/reboot-prepare.sh

# After reboot: start all services
bash /home/psg/reboot-start.sh
```

### Why This Matters

NanoClaw's systemd service requires graceful shutdown to preserve WhatsApp session state. The scripts/checklist handle:
- Pre-reboot verification (backup status, service health)
- Graceful service shutdown (rclone → ai-chat → nanoclaw → Docker)
- Post-reboot startup (Docker → ai-chat → nanoclaw → rclone)
- Reboot history tracking

**Never:** Kill NanoClaw with `SIGKILL` or `docker kill`—use the scripts' graceful shutdown sequence.
