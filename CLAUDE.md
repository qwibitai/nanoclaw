# AgentLite

SDK for running Claude agents in isolated BoxLite VMs with messaging channel integration. See [README.md](README.md) for setup.

## Quick Context

Single Node.js process. Two-level API: `createAgentLite()` returns a platform instance, `agentlite.createAgent()` creates per-project agents. Messages route to Claude Agent SDK running in BoxLite VMs (hardware-isolated). Each group has isolated filesystem and memory. Public types live in `src/api/`, implementation is hidden.

## Key Files

| File | Purpose |
|------|---------|
| `src/api/sdk.ts` | Public API: `createAgentLite()`, `AgentLite` interface |
| `src/api/agent.ts` | Public API: `Agent` interface |
| `src/api/channel-driver.ts` | Public API: `ChannelDriver` interface |
| `src/api/options.ts` | Public API: `AgentLiteOptions`, `AgentOptions` |
| `src/api/channels/telegram.ts` | Public API: `telegram()` factory |
| `src/agentlite-impl.ts` | AgentLite implementation (not exported) |
| `src/agent-impl.ts` | Agent implementation: channels, message loop, groups |
| `src/agent-config.ts` | Immutable per-agent config (paths, identity, credentials) |
| `src/runtime-config.ts` | Immutable shared runtime config (box, timeouts) |
| `src/cli.ts` | CLI entry point (bin): process handlers, channel auto-discovery |
| `src/box-runtime.ts` | BoxLite VM runtime management |
| `src/container-runner.ts` | Spawns agent VMs with volume mounts |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent VMs (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in AgentLite. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-agentlite` | Bring upstream AgentLite updates into a customized install |
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
launchctl load ~/Library/LaunchAgents/com.agentlite.plist
launchctl unload ~/Library/LaunchAgents/com.agentlite.plist
launchctl kickstart -k gui/$(id -u)/com.agentlite  # restart

# Linux (systemd)
systemctl --user start agentlite
systemctl --user stop agentlite
systemctl --user restart agentlite
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
