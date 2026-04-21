# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy

**This install uses the native credential proxy (`src/credential-proxy.ts`), NOT OneCLI.** API keys and OAuth tokens are read from `.env` and injected into container API requests by a local HTTP proxy on port 3001. Do NOT switch to OneCLI or remove the native credential proxy during updates — it is the only credential provider configured on this machine.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | N/A — this install uses the native credential proxy instead |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

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

## Protected Files (DO NOT overwrite during upgrades)

Any upstream merge that touches these files must preserve the local modifications. Losing any one causes a silent failure mode — the system *looks* up but behaves wrong.

- **`groups/global/CLAUDE.md`** -- Contains the "ABSOLUTE HARD RULES", System Change Discipline, Memory system, Notion Open Items, Snowflake, and Contacts sections. Every rule Nano actually follows lives here (injected into system prompt). Without it: emails sent without drafts, memory forgotten, rules ignored.
- **`src/credential-proxy.ts`** -- Native credential proxy. This install does not use OneCLI.
- **`src/db.ts`** -- `initDatabase` sets `journal_mode = WAL`. Without WAL, SIGKILL mid-write corrupts the DB (happened 2026-04-16).
- **`src/container-runner.ts`** -- Mounts `~/.snowflake/perplexity_computer_use.p8` read-only into container, injects `SNOWFLAKE_*` env vars. Removing this breaks Nano's Snowflake access.
- **`container/Dockerfile`** -- Installs Python + `snowflake-labs-mcp` into `/opt/snowflake-mcp-venv/`. Also copies `patches/snowflake-tools-config.yaml`. Container rebuild without these omits the Snowflake MCP entirely.
- **`container/agent-runner/src/index.ts`** -- (1) Loads global CLAUDE.md for ALL channels (not just non-main — main had been silently excluded). (2) Registers `snowflake:` MCP server. (3) Includes `mcp__snowflake__*` in allowedTools. If an upstream revert restores the `!isMain` gate, main channel (Gabe's Telegram) will silently lose every global rule.
- **`container/patches/snowflake-tools-config.yaml`** -- `other_services.query_manager: true` is what actually registers the SQL tool. Without it, the MCP advertises zero tools.
- **`nanoclawrules.md`** -- COO triage spec + Notion database schema + COO daily brief spec + retired-table notes.
- **`scripts/profitsword/`** -- ProfitSword API script + config.json. Container accesses at `/workspace/project/scripts/profitsword/scripts/profitsword_api.py`.
- **`scripts/toast/`** -- Toast POS API script + restaurant mapping. Container accesses at `/workspace/project/scripts/toast/scripts/toast_api.py`. Credentials in `.env` (TOAST_CLIENT_ID, TOAST_CLIENT_SECRET).
- **`container/skills/coo-briefing/`** -- COO Briefing skill: SKILL.md (full spec) + references/property_mapping.json. Triggered by pre-fetch IPC drop (~3:05am) not a fixed schedule. Writes `brief_sent.flag` on completion to prevent duplicate sends. 5:30am fallback task (`coo-brief-fallback-*`) catches pre-fetch failures.
- **`container/skills/coo-prefetch/`** -- COO Pre-Fetch skill: runs at 3:00am, parallelizes ProfitSword across all 12 hotels with retry pass, saves all Snowflake (7 queries, STR every day) + Toast to disk, then triggers the brief via IPC. Losing it means brief falls back to live fetching and risks timeout.
- **`data/coo-prefetch/`** -- Daily cache written by coo-prefetch at 3am. One directory per date. Not code -- safe to delete old dates, but do NOT delete today's directory while the brief is running.
- **`container/skills/system-monitor/`** -- System Monitor skill: runs every 6h, checks all data connections, DB health, credentials, backup status, COO brief delivery. Escalates failures to main Telegram.

Also: `~/Library/LaunchAgents/com.nanoclaw.token-sync.plist.disabled-apikey-mode` — the disabled token sync job. If you switch to OAuth mode in the future, rename back AND fix the script to append the env line when missing (see memory: nanoclaw_architecture.md). Re-enabling as-is will SIGKILL nanoclaw every 10 minutes.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
