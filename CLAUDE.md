# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

**Mission log:** See [`docs/superpowers/INDEX.md`](docs/superpowers/INDEX.md) for the append-only record of all `/build-it` missions.

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
| `src/health.ts` | Optional Unix domain socket health endpoint (opt-in via `HEALTH_SOCKET_PATH` or `NANOCLAW_HEALTH=1`) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/deploy-digitalocean` | Provision a DigitalOcean droplet and install NanoClaw end-to-end from Claude Code |
| `/add-almanda-core` | Install Almanda persona: rename Andy→Almanda, global operating rules, capability index, main-group systemPrompt fix |
| `/add-company-kb` | Wire Alma Labs internal knowledge base MCP (company Q&A, teammates, products, policies) |
| `/add-linear-ops` | Add Linear read + write (issues, projects, cycles, teams) — writes require user approval |
| `/add-github-ops` | Add GitHub read + write (code search, PRs, issues, files) — writes require user approval |
| `/add-slack-intel` | Add Slack read access (channels, history, threads, user directory, search) |
| `/add-slack-ops` | Add Slack write access (post to channels + DMs, react) — writes require user approval |
| `/add-identity` | Install cross-channel identity layer: maps @almalabs.ai employees to Slack/Telegram IDs |
| `/add-policy` | Install role-based capability layer: admin/member roles, policy.json, checkCapability enforcement |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |
| `/add-whatsapp` | Add WhatsApp as a channel (QR or pairing code authentication) |
| `/add-telegram` | Add Telegram as a channel (control-only, passive, or full) |
| `/add-slack` | Add Slack as a channel via Socket Mode (no public URL needed) |
| `/add-discord` | Add Discord bot channel integration |
| `/add-gmail` | Add Gmail integration (tool or full channel mode) |
| `/add-compact` | Add /compact command for manual context compaction in long sessions |
| `/add-emacs` | Add Emacs as a channel via local HTTP bridge |
| `/add-image-vision` | Add image vision for WhatsApp image attachments |
| `/add-voice-transcription` | Add voice message transcription via OpenAI Whisper API |
| `/add-pdf-reader` | Add PDF reading capability via pdftotext CLI |
| `/add-reactions` | Add WhatsApp emoji reaction support (receive, send, store, search) |
| `/add-karpathy-llm-wiki` | Add persistent wiki knowledge base to a group |
| `/add-macos-statusbar` | Add macOS menu bar status indicator for NanoClaw |
| `/add-ollama-tool` | Add Ollama MCP server for local model calls |
| `/add-telegram-swarm` | Add agent swarm (teams) support to Telegram |
| `/channel-formatting` | Convert Claude Markdown to each channel's native text syntax |
| `/convert-to-apple-container` | Switch from Docker to Apple Container for macOS-native isolation |
| `/migrate-from-openclaw` | Migrate from OpenClaw to NanoClaw |
| `/migrate-nanoclaw` | Upgrade NanoClaw by reapplying customizations on a clean base |
| `/update-skills` | Check for and apply updates to installed skill branches |
| `/use-local-whisper` | Switch to whisper.cpp local transcription (Apple Silicon) |
| `/use-native-credential-proxy` | Replace OneCLI gateway with built-in .env credential proxy |
| `/x-integration` | X (Twitter) integration: post tweets, like, reply, retweet |
| `/claw` | Install claw CLI tool for running NanoClaw agent containers from command line |
| `/add-slack-ops` | Add Slack write access (post to channels + DMs, react) — writes require user approval |
| `/build-it` | Drive a change end-to-end: intake → brainstorm → plan → implement → test → review → PR → release → deploy → verify |
| `/build-it --resume` | Resume an interrupted `/build-it` mission from its last checkpoint |
| `/catch-up` | Cold-start helper: given a Linear ID or slug, reconstruct current phase, last artifact, and next action |
| `nanoclaw-docs-sync` | Audit CLAUDE.md/README/CONTRIBUTING against the tree; write ADR; update INDEX.md; commit doc fixes |
| `nanoclaw-release` | Bump semver, append CHANGELOG entry, tag, push — phase [8] of `/build-it` |
| `nanoclaw-deploy-droplet` | SSH-deploy a version tag to the DO droplet, rebuild container, restart, probe health |
| `nanoclaw-postdeploy-verify` | Run smoke-send.ts probes after deploy; auto-rollback on failure |
| `nanoclaw-channel-smoke-matrix` | Run channel unit tests and optional container smoke for each impacted channel |

## Container Skills

Skills automatically loaded inside every agent container at runtime from `container/skills/`:

| Skill | Purpose |
|-------|---------|
| `agent-browser` | Playwright browser automation for the container agent |
| `almanda-ops` | Almanda-specific operational tools |
| `capabilities` | Agent capability index and tool listing |
| `company-kb` | Alma Labs knowledge base access |
| `github-ops` | GitHub read/write container tools |
| `linear-ops` | Linear read/write container tools |
| `slack-formatting` | Slack message formatting helpers |
| `slack-intel` | Slack read tools (channels, search, threads) |
| `slack-ops` | Slack write tools (post, react) |
| `status` | Agent status and health reporting |

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

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
