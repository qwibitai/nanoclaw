# OpenClaw → NanoClaw Migration

A comprehensive migration guide for moving an agent fleet from OpenClaw/clawdbot to NanoClaw, with both Docker and **native (host-mode) runners**. Based on the actual migration of the **Popashot** agent to Discord, April 2026.

This document captures:

- **Why** the move happened (OpenClaw complexity vs NanoClaw leanness)
- **Two runtime modes**: `container` (Docker) and `native` (host process)
- **Changes to run locally** — the native runner restoration and skill auto-sync
- How 60+ skills were ported from the OpenClaw ecosystem into `container/skills/`
- How those skills are tracked in `toolkit/external-dependencies.yaml`
- What Popashot-specific replication work looks like

---

## Table of Contents

1. [Why the Migration](#why-the-migration)
2. [Runtime Modes: Container vs Native](#runtime-modes-container-vs-native)
3. [Phase 0: Fork & Bootstrap](#phase-0-fork--bootstrap)
4. [Phase 1: Pick a Runtime Mode](#phase-1-pick-a-runtime-mode)
5. [Phase 2: Credentials (OneCLI + `.env`)](#phase-2-credentials-onecli--env)
6. [Phase 3: Channels (Discord first)](#phase-3-channels-discord-first)
7. [Phase 4: Persona Replication](#phase-4-persona-replication)
8. [Phase 5: Integrations](#phase-5-integrations)
9. [Phase 6: Cron Jobs](#phase-6-cron-jobs)
10. [Phase 7: Learnings & Patterns](#phase-7-learnings--patterns)
11. [Phase 8: Skills System](#phase-8-skills-system)
12. [Phase 9: Verification](#phase-9-verification)
13. [Gap Analysis](#gap-analysis)
14. [Manifest Tracking (agents-in-a-box)](#manifest-tracking-agents-in-a-box)
15. [Troubleshooting](#troubleshooting)

---

## Why the Migration

[OpenClaw](https://github.com/openclaw/openclaw) (aka clawdbot) runs a multi-agent fleet on WhatsApp using a Node.js orchestrator with per-agent persona files (`SOUL.md`, `IDENTITY.md`, `STANDING_ORDERS.md`), clan-wide shared learnings, and a Convex-backed Mission Control dashboard. It's powerful but sprawls — ~500k LoC, 53 config files, 70+ dependencies, application-level security only.

[NanoClaw](https://github.com/qwibitai/nanoclaw) is a lean rewrite of the same core idea:

- **One process**, a handful of files
- **Real OS-level isolation** via Docker containers (or native process per group in host mode)
- **Single `CLAUDE.md` per group** (no more SOUL/IDENTITY/STANDING_ORDERS sprawl)
- **OneCLI credential gateway** — tokens never touch container filesystems
- **Channels-as-skills** — `/add-discord`, `/add-telegram`, etc.

**Our fork**: `qwibitai/nanoclaw` (branch `main-a9b9f9f8`) with two material customizations applied locally:

| Commit | Change |
|---|---|
| `d59f74a` | `feat: restore native runner mode and discord reply-to-bot trigger` |
| `16fef7c` | `fix(native-runner): sync container/skills to ~/.claude/skills not per-group dir` |

These two commits are the "changes to run locally" — they make NanoClaw work natively on macOS without Docker and make the skills system behave correctly in that mode.

---

## Runtime Modes: Container vs Native

NanoClaw dispatches the agent runner based on `RUNTIME_MODE` in `.env`:

```env
RUNTIME_MODE=native     # host process, shares your real HOME
# or
RUNTIME_MODE=container  # Docker container with isolated filesystem (default)
```

The dispatch happens in `src/index.ts` and `src/task-scheduler.ts`:

```ts
import { runNativeAgent } from './native-runner.js';
import { runContainerAgent } from './container-runner.js';

const runner = RUNTIME_MODE === 'native' ? runNativeAgent : runContainerAgent;
```

### When to use each

| Situation | Mode |
|---|---|
| Production on a Linux VM (GCP, etc.) | `container` |
| macOS dev laptop (Docker for Mac is slow/heavy) | `native` |
| Need filesystem isolation from the host | `container` |
| Need tmux/host Claude Code/SSH keys/gitconfig directly | `native` |
| Want skills to live in your real `~/.claude/skills/` | `native` |

### Key differences

|   | `container` | `native` |
|---|---|---|
| **HOME** | `/home/agent` inside container | `os.homedir()` (your real home) |
| **Filesystem isolation** | Full — only mounted paths visible | None — agent sees your whole machine |
| **SSH keys, gh auth, gitconfig** | Must mount explicitly | Works out of the box |
| **Claude SDK skills path** | `/home/agent/.claude/skills/` | `~/.claude/skills/` |
| **tmux access** | Needs host socket mount | Already there |
| **Startup cost** | Docker image build + container spawn | Node child process (fast) |

### The native-runner sync trick

In native mode, the Claude SDK reads skills from the real `~/.claude/skills/`. But NanoClaw's git-versioned source of truth is `container/skills/`. So the native runner copies `container/skills/*` → `~/.claude/skills/*` on every agent spawn (`src/native-runner.ts`):

```ts
const skillsSrc = path.join(projectRoot, 'container', 'skills');
const skillsDst = path.join(os.homedir(), '.claude', 'skills');
if (fs.existsSync(skillsSrc)) {
  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(skillsDst, skillDir);
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }
}
```

**What this means for you:**

- Edit a skill in `container/skills/<name>/SKILL.md` in the nanoclaw repo
- Next agent run copies it into `~/.claude/skills/<name>/`
- Claude Code (and any other host-mode tool reading `~/.claude/skills/`) picks it up automatically
- The git-versioned source stays in the nanoclaw repo; `~/.claude/skills/` is a live mirror

**Caveat:** the copy overwrites, so if you edit `~/.claude/skills/<name>/` directly and then run a nanoclaw agent, your edits get clobbered. Always edit upstream.

---

## Phase 0: Fork & Bootstrap

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
bash setup.sh              # or /setup in Claude Code
```

Then apply the two local-runner commits from this fork (or cherry-pick them):

- `d59f74a` — restores native runner mode
- `16fef7c` — syncs skills to `~/.claude/skills/`

(If you're cloning `stevengonsalvez/nanoclaw` branch `main-a9b9f9f8`, you already have them.)

---

## Phase 1: Pick a Runtime Mode

### Native (recommended on macOS)

```env
# .env
RUNTIME_MODE=native
TZ=Europe/London
ASSISTANT_NAME=popashot
DISCORD_BOT_TOKEN=<token>
```

No Docker required. `npm run build && npm start` spawns the orchestrator, which spawns per-group Node child processes on demand.

### Container

```env
RUNTIME_MODE=container
```

Then build the agent image:

```bash
./container/build.sh
docker info  # verify daemon running
```

Container mode mounts only what you tell it to (see Phase 8 for mount configuration).

---

## Phase 2: Credentials (OneCLI + `.env`)

### 2.1 Install OneCLI

OneCLI is NanoClaw's credential gateway. It runs locally and injects secrets into API requests so tokens never land in container filesystems.

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
export PATH="$HOME/.local/bin:$PATH"
onecli config set api-host http://127.0.0.1:10254
```

Add to `.env`:

```env
ONECLI_URL=http://127.0.0.1:10254
```

### 2.2 Register secrets

```bash
# Anthropic (Claude subscription token or API key)
claude setup-token   # if using subscription
onecli secrets create --name Anthropic --type anthropic \
  --value <TOKEN> --host-pattern api.anthropic.com

# Slack
onecli secrets create --name Slack --type generic \
  --value <SLACK_BOT_TOKEN> --host-pattern slack.com \
  --header-name Authorization --value-format 'Bearer {value}'

# Sentry
onecli secrets create --name Sentry --type generic \
  --value <SENTRY_TOKEN> --host-pattern sentry.io \
  --header-name Authorization --value-format 'Bearer {value}'

# imgbb (bug report image upload)
onecli secrets create --name imgbb --type generic \
  --value <KEY> --host-pattern api.imgbb.com

# Mission Control (Convex)
onecli secrets create --name MissionControl --type generic \
  --value <MC_TOKEN> --host-pattern convex.site \
  --header-name X-MC-Token --value-format '{value}'
```

### 2.3 `.env` (channel tokens + non-API config)

```env
TZ=Europe/London
RUNTIME_MODE=native
ONECLI_URL=http://127.0.0.1:10254
ASSISTANT_NAME=popashot
DISCORD_BOT_TOKEN=<discord-token>
SLACK_BOT_TOKEN=<slack-token>
SENTRY_AUTH_TOKEN=<sentry-token>
SENTRY_ORG=shotclubhouse
SENTRY_PROJECT=shotapp
SENTRY_URL=https://de.sentry.io/
IMGBB_API_KEY=<imgbb-key>
MC_AUTH_TOKEN=<mc-token>
```

For container mode only:

```bash
mkdir -p data/env && cp .env data/env/env
```

Native mode reads `.env` directly — no copy needed.

---

## Phase 3: Channels (Discord first)

### 3.1 Merge the Discord channel skill

```bash
# From Claude Code:
/add-discord

# Or manually:
git remote add discord https://github.com/qwibitai/nanoclaw-discord.git
git fetch discord main
git merge discord/main
npm install && npm run build
```

### 3.2 Create a Discord bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it (e.g., "Popashot")
2. **Bot** tab → **Reset Token** → save as `DISCORD_BOT_TOKEN` in `.env`
3. Enable **Message Content Intent** and **Server Members Intent**
4. **OAuth2** → **URL Generator** → Scopes: `bot` → Permissions: `Send Messages`, `Read Message History`, `View Channels`
5. Copy the invite URL → open → invite bot to your server

### 3.3 Register channels

Enable Developer Mode in Discord (Settings → Advanced). Right-click channels to copy IDs.

```bash
# Main channel (trigger-only — responds only when @-mentioned)
npx tsx setup/index.ts --step register -- \
  --jid "dc:<channel-id>" \
  --name "server #nano" \
  --folder "discord_nano" \
  --trigger "@popashot" \
  --channel discord

# Silent bug-reports channel (agent never replies; only auto-creates issues)
npx tsx setup/index.ts --step register -- \
  --jid "dc:<channel-id>" \
  --name "server #bug-reports" \
  --folder "discord_bug-reports" \
  --trigger "@popashot" \
  --channel discord

# Alpha-testing channel
npx tsx setup/index.ts --step register -- \
  --jid "dc:<channel-id>" \
  --name "server #alpha-testing" \
  --folder "discord_alpha-testing" \
  --trigger "@popashot" \
  --channel discord
```

---

## Phase 4: Persona Replication

The core of the migration — collapsing OpenClaw's many persona files into NanoClaw's single `groups/<folder>/CLAUDE.md`.

### 4.1 Decrypt OpenClaw configs (if encrypted)

```bash
cd ~/path/to/clawdbot-backup
transcrypt -c aes-256-cbc -p '<transcrypt-password>'
```

### 4.2 Map OpenClaw files to `CLAUDE.md` sections

| OpenClaw File | CLAUDE.md Section |
|---|---|
| `SOUL.md` | Top-level personality |
| `IDENTITY.md` | Voice & Personality, Anti-Patterns, Personality DNA |
| `STANDING_ORDERS.md` | Standing Orders (adapted for single agent) |
| `CHANNEL_RULES.md` | Discord Formatting, Message Formatting |
| `agents/<name>/config.yaml` | Repo routing, integrations, triggers |
| `.clan/corrections-raw.jsonl` | Learned Patterns (distilled) |
| `.clan/patterns.md` | Learned Patterns (curated) |

### 4.3 Build `groups/discord_nano/CLAUDE.md`

Sections, in order:

1. **Identity & Mission**
2. **Voice & Personality**
3. **Emoji Language**
4. **Repositories** (route table → repo)
5. **Bug Report Pipeline** (silent channel)
6. **Integration APIs** (Convex, Sentry, etc.)
7. **Standing Orders**
8. **Learned Patterns**
9. **Communication** (output tags, MCP tools)
10. **Memory** (conversation storage, learnings)
11. **Mounts** (container mode only)
12. **Scheduled Jobs** (cron definitions)

### 4.4 Standing orders: kept vs dropped

For Popashot (18 → 13 adapted):

| # | OpenClaw Rule | Status | Why |
|---|---|---|---|
| 1 | Inbox Protocol | Adapted | Direct Convex calls, no MC gateway |
| 2 | Tagging (agent-to-agent) | **Dropped** | Single agent, no fleet |
| 3 | Repetition Detection | Kept | Universal |
| 4 | Git Discipline | Kept | Core |
| 5 | Discord Formatting | Kept | Channel-specific |
| 6 | Coding Tools | Adapted | "Claude Code primary" |
| 7 | Safety | Kept | Never expose secrets |
| 8 | Correction Logging | Kept | Self-improvement |
| 9 | Config Safety | Adapted | Different config structure |
| 10 | Reply Style | Kept | Anti-sycophancy |
| 11 | Mortal Inbox | Adapted | "Ask Stevie directly when blocked" |
| 12 | Discord Threads | Kept | Thread-per-task |
| 13 | Security PR Gate | Kept | Security review |
| 14 | Coding Session Lifecycle | Kept | Cleanup ownership |
| 15 | Discovery Protocol | Kept | Document non-obvious findings |
| 16 | Research Loop | Kept | `PROPOSAL.md` for arch changes |
| 17 | Repo Manifest Protocol | Kept | `.clan/manifest.yaml` |
| 18 | Agent Comms Protocol | **Dropped** | Single agent |

### 4.5 Per-channel CLAUDE.md files

- **`groups/discord_nano/CLAUDE.md`** — full persona, all integrations, standing orders, learnings, cron jobs
- **`groups/discord_bug-reports/CLAUDE.md`** — silent mode: NEVER reply, auto-create GitHub issues, notify `#alpha-testing`
- **`groups/discord_alpha-testing/CLAUDE.md`** — active discussion, abbreviated config

The bug-reports `CLAUDE.md` must explicitly state **"NEVER reply conversationally"** and define the full issue-creation pipeline.

---

## Phase 5: Integrations

### 5.1 GitHub

`gh` CLI is available in both runtime modes.

- **Native mode**: uses your host `gh auth` state directly
- **Container mode**: mount `~/.config/gh` read-only or use OneCLI-injected tokens

Repo routing in `CLAUDE.md`:

```markdown
| Route | Repo | Match Keywords |
|---|---|---|
| app | SHOTClubhouse/SHOTclubhouse | app, migrations, RLS |
| platform | stevengonsalvez/wololo-platform | infra, tunnels, GCP |
| dashboard | stevengonsalvez/mission-control | convex, inbox, dashboard |
| biolift | stevengonsalvez/biolift | fitness, workout |
```

### 5.2 Sentry

```env
SENTRY_AUTH_TOKEN=<token>
SENTRY_ORG=shotclubhouse
SENTRY_PROJECT=shotapp
SENTRY_URL=https://de.sentry.io/
```

### 5.3 imgbb (bug report images)

```env
IMGBB_API_KEY=<key>
```

Pipeline:
```bash
curl -s -X POST "https://api.imgbb.com/1/upload?key=$IMGBB_API_KEY" \
  -F "image=@<path>" | jq -r '.data.display_url'
```

### 5.4 Mission Control (Convex)

Called directly via `curl` from the agent:

```env
MC_AUTH_TOKEN=<token>
```

Document all endpoints in `CLAUDE.md`: `poll`, `send`, `ack`, `start-work`, `complete`, `fail`, `note`, `link-pr`, `reassign`. Include the mortal inbox protocol for escalating to the human.

### 5.5 Slack (outbound)

Token stored for cross-channel notifications. Full Slack channel integration requires `/add-slack`.

---

## Phase 6: Cron Jobs

NanoClaw uses the `schedule_task` MCP tool for recurring jobs. Define them in `CLAUDE.md` under **Scheduled Jobs** — the agent registers them on first interaction.

### Migrated jobs (47 → 4)

| Job | Cron | Description |
|---|---|---|
| Daily Pipeline Update | `30 7 * * *` | Git/PR/issue summary across all repos |
| Reflection Cycle | `0 9,21 * * *` | Scan corrections, promote patterns |
| Pipeline Poll | `*/15 * * * *` | CI/CD status, approved PRs |
| System Backup | `0 */6 * * *` | Back up configs/state |

### Script gating

Each job should have a pre-check script that returns `{ "wakeAgent": true|false }` to avoid pointless API calls. Example for Pipeline Poll:

```bash
gh pr list --repo SHOTClubhouse/SHOTclubhouse \
  --json number,statusCheckRollup,reviewDecision | \
  jq '{ wakeAgent: (map(select(.reviewDecision == "APPROVED" or (.statusCheckRollup | any(.conclusion == "FAILURE")))) | length > 0) }'
```

---

## Phase 7: Learnings & Patterns

### 7.1 Assess

OpenClaw may have thousands of raw corrections and hundreds of patterns. Triage ruthlessly:

- **2,202 corrections** → distil to ~50 actionable patterns
- **286 patterns** → review for applicability (drop WhatsApp-specific and fleet-specific ones)
- **36 discoveries** → port those relevant to current repos

### 7.2 Categorize and distill

| Category | Example Patterns |
|---|---|
| Discord | Box-drawing tables, @mention formatting |
| Security | Never expose creds, constant-time compare, `Set.has()` for ACL |
| Git & PRs | Check state before diff, verify fixes against main |
| Testing | Check real schema before suggesting SQL |
| Architecture | `apt-get` lock timeout, launchd KeepAlive, read signatures before wrapping |
| Tools & Shell | Single-quoted heredocs, quote API paths in zsh |

### 7.3 Add to `CLAUDE.md`

Put distilled patterns in a **Learned Patterns** section. 1-2 lines each, grouped by `###` heading.

### 7.4 Self-improvement system

```markdown
### Correction Logging
When corrected (by human, agent, or build failure):
1. Log to `self-improving/corrections.md` IMMEDIATELY
2. 3rd+ similar pattern → promote to `self-improving/memory.md` (HOT tier)
3. Do NOT wait, do NOT batch. Each correction gets its own entry.
```

The **Reflection Cycle** cron (Phase 6) automates pattern promotion.

---

## Phase 8: Skills System

NanoClaw ships ~88 skills in `container/skills/`. In native mode the runner auto-syncs them into `~/.claude/skills/` on every agent run (see [Runtime Modes](#runtime-modes-container-vs-native)).

### Skill categories in the NanoClaw fork

| Category | Examples |
|---|---|
| **Workflow & meta** | plan, plan-tdd, plan-gh, implement, validate, workflow, commit, handover, prime, brainstorm, critique, discuss, reflect, research, research-cache, sync-learnings, find-missing-tests, make-github-issues, do-issues, gh-issue, gh-issues |
| **Self-improvement** | self-improving, self-reflection, session-logs, build-tracker, capabilities, status, healthcheck |
| **Coding agents** | coding-agent, cloud-coding-agent, oracle, mcporter |
| **Swarm orchestration** | swarm-create, swarm-join, swarm-inbox, swarm-status, swarm-orchestration, swarm-shutdown, swarm-agent-troubleshooting, attach-agent-worktree, list-agent-worktrees, cleanup-agent-worktree, merge-agent-work, spawn-agent |
| **UI/UX (impeccable family)** | teach-impeccable, adapt, animate, arrange, audit, bolder, clarify, colorize, delight, distill, extract, harden, normalize, onboard, optimize, overdrive, peekaboo, polish, quieter, typeset |
| **Notes & productivity** | apple-notes, bear-notes, obsidian, summarize, blogwatcher |
| **Messaging & social** | slack, slack-formatting, bird, wacli, gog |
| **Security & recon** | argus, pentagi, shannon, webcopilot, sentry-cli |
| **Credentials** | bitwarden |
| **Media** | video-frames, camsnap, gifgrep, spotify-player |
| **IoT / hardware** | eightctl, openhue |
| **GitHub ops** | github, gh-issue, gh-issues |

### Editing skills

**Always edit upstream** in `container/skills/<name>/SKILL.md`. The native runner will overwrite `~/.claude/skills/<name>/` on the next run.

```bash
# Edit the source
vim container/skills/coding-agent/SKILL.md

# Commit to nanoclaw
git add container/skills/coding-agent/SKILL.md
git commit -m "feat(coding-agent): add retry pattern"

# Next agent run syncs the change automatically
```

### Adding a new skill

```bash
mkdir container/skills/my-skill
cat > container/skills/my-skill/SKILL.md <<'EOF'
---
name: my-skill
description: What it does
---
# /my-skill
...
EOF

git add container/skills/my-skill
git commit -m "feat(skills): add my-skill"
```

---

## Phase 9: Verification

### 9.1 Service health

```bash
# Native mode
ps -ef | grep -v grep | grep 'nanoclaw'
tail -f logs/nanoclaw.log

# Container mode (macOS)
launchctl list | grep nanoclaw
# (Linux)
systemctl --user status nanoclaw

# Channels
sqlite3 store/messages.db "SELECT jid, name, requires_trigger, is_main FROM registered_groups"

# OneCLI
onecli secrets list
```

### 9.2 Test each channel

1. **`#nano`** — `@popashot hello` → should respond in-character
2. **`#bug-reports`** — post a bug → should NOT reply, should create a GitHub issue, notify `#alpha-testing`
3. **`#alpha-testing`** — `@popashot status` → should respond

### 9.3 Verify persona

Check the agent:
- Never opens with "Great question!" or "I'd be happy to help!"
- Uses emoji language correctly
- Routes repo questions to the right repo
- Formats Discord tables with box-drawing characters
- Responds with dry wit, not corporate filler

### 9.4 Diagnostics

```bash
npx tsx setup/index.ts --step verify
```

### 9.5 Verify skills auto-sync (native mode only)

```bash
# Trigger one agent run (any channel message)
# Then check the skills are mirrored:
ls ~/.claude/skills/coding-agent/SKILL.md
diff container/skills/coding-agent/SKILL.md ~/.claude/skills/coding-agent/SKILL.md
# (should be identical)
```

---

## Gap Analysis

Features that existed in OpenClaw but are missing, degraded, or require workarounds in NanoClaw. Organised by severity. Native mode resolves a few of the container-era gaps.

### Hard Gaps (no NanoClaw equivalent)

#### 1. Multi-agent fleet orchestration
**OpenClaw:** 7 specialized agents (popashot, cantona, splinter, zerocool, tank, velma, slash) with Agent Communication Protocol v1 (ACP/1), inter-agent tagging, concurrency limits.
**NanoClaw:** One agent per group. Groups can't message each other directly.
**Workaround:** Register multiple groups and coordinate via Discord channels.

#### 2. Voice integration
**OpenClaw:** Telnyx phone, Discord voice, TTS (OpenAI tts-1), STT (Deepgram nova-3).
**NanoClaw:** Text only.
**Workaround:** None.

#### 3. Orchestrator hooks (correction-detector, inbox-enforcer, etc.)
**OpenClaw:** 8 TypeScript hook handlers at the orchestrator level.
**NanoClaw:** No orchestrator hook system.
**Workaround:** Put correction detection rules in `CLAUDE.md` as self-monitoring.

#### 4. Prose workflow engine
**OpenClaw:** Declarative `.prose` files for multi-step automation.
**NanoClaw:** No workflow engine.
**Workaround:** Encode workflows as `CLAUDE.md` instructions or new container skills.

#### 5. Plugin system
**OpenClaw:** Modular plugins (voice, Brave search, Google, lossless-CLAW, open-prose, lobster).
**NanoClaw:** Capabilities via container skills, MCP servers, or code changes.

### Degraded (work differently)

#### 6. Clan-wide shared learnings
**OpenClaw:** Centralized `~/d/clan-learnings/` with dedup tracking and render scripts; all agents read/write the same knowledge base.
**NanoClaw:** Each group has isolated `self-improving/`.
**Workaround:** Mount a shared `learnings/` directory across groups; add a consolidator cron.
**Native-mode advantage:** In native mode you can point `self-improving/` at a shared host path directly.

#### 7. Browser profile persistence
**OpenClaw:** Custom CDP client with persistent `browser/clawd/` profile (cookies, LocalStorage).
**NanoClaw container:** Every run starts with a clean browser.
**NanoClaw native:** Can use host Chrome profile directly — no mount plumbing needed.

#### 8. Cron scheduling (47 → 4)
**OpenClaw:** 47 jobs with delivery modes, heartbeat-based wake, session targeting.
**NanoClaw:** `schedule_task` with pre-check gating. Simpler but covers core needs.

#### 9. Memory & context management
**OpenClaw:** Cache-TTL mode, soft trim at 65%, hard clear at 85%, token budgeting, vector embeddings.
**NanoClaw:** Relies on Claude SDK's built-in context management.

#### 10. Security scanning suite
**OpenClaw:** Ghost skills (`scan-secrets`, `scan-deps`, `scan-code`), `fleet-audit.sh`, Splinter agent.
**NanoClaw:** No built-in scan framework. PR gate is instruction-based.
**Workaround:** Add `argus`, `pentagi`, `shannon`, `webcopilot`, `supabase-sentinel` as container skills (already done in our fork).

#### 11. Bitwarden access
**OpenClaw:** Full `bw` CLI integration with vault session support.
**NanoClaw container:** No vault session inside container.
**NanoClaw native:** `bw` CLI works directly on the host — use the `bitwarden` skill.

#### 12. GCP / IaC deployment
**OpenClaw:** Nix/NixOS flake, cloud-init, Bitwarden-based `provision-secrets.sh`, systemd on GCP, Tailscale funnel.
**NanoClaw:** Local-only. No IaC story.
**Workaround:** Build it yourself.

### Where native mode helps

| Gap | Container mode | Native mode |
|---|---|---|
| SSH keys | Must mount `~/.ssh` | Already there |
| gh auth | Must mount `~/.config/gh` or use OneCLI | Already there |
| gitconfig | Must mount `~/.gitconfig` | Already there |
| tmux socket | Must mount `/tmp/tmux-<uid>` | Already there |
| Host Claude Code / Codex | Can't reach host binaries | Just calls them |
| Bitwarden CLI | No vault session | Works directly |
| Browser profile persistence | Needs mount + rebuild | Uses your real profile |
| Shared learnings across groups | Needs mount plumbing | Point at host path |

Trade-off: native mode loses filesystem isolation. Use container mode for production and anything running untrusted code or handling highly sensitive data; use native mode for trusted dev and operator workflows.

---

## Manifest Tracking (agents-in-a-box)

If you also use the [agents-in-a-box](https://github.com/stevengonsalvez/agents-in-a-box) toolkit alongside NanoClaw, it tracks all skills, plugins, and agents across the ecosystem in `toolkit/external-dependencies.yaml`. NanoClaw-sourced skills live under the `nanoclaw-skills:` section of that manifest, with a pointer back to this doc as the source of truth.

### What's tracked

| Section | What it contains |
|---|---|
| `bundled-skills` | Skills shipping in `toolkit/packages/skills/` |
| `agent-skills` | Cross-agent git repos (agentskills.io standard) |
| `claude-plugins` | Installed via `claude plugin install` |
| `npx-skills` | Installed via `npx skills add` (including `caveman`, `impeccable`) |
| `nanoclaw-skills` | Skills sourced from `qwibitai/nanoclaw`'s `container/skills/`, synced to `~/.claude/skills/` by the native runner |
| `security-skills` | Pentesting / recon skills bundled via NanoClaw (argus, pentagi, shannon, webcopilot, supabase-sentinel) |
| `mcp-servers` | MCP servers configured in `~/.claude/settings.json` |
| `marketplaces` | Claude plugin marketplaces added |

### Why NanoClaw skills get their own section

Most of the skills now available in `~/.claude/skills/` didn't get there via `npx skills add` or `claude plugin install`. They arrived via the NanoClaw native runner's auto-sync from `container/skills/`. That's a materially different install path, so it gets its own manifest section with the source repo and sync mechanism documented.

### Identifying upstream vs NanoClaw-native skills

Some skills in `container/skills/` are bundled-but-upstream (e.g., the 20-skill **impeccable** family comes from `pbakaus/impeccable`). These are tracked under `npx-skills.impeccable` with their upstream source, and the NanoClaw fork ships them as a convenience.

NanoClaw-native skills (no upstream) include:
- `capabilities`, `status`, `session-logs`, `build-tracker` — NanoClaw-specific tooling
- `coding-agent`, `cloud-coding-agent` — NanoClaw's Task-vs-tmux delegation patterns
- `healthcheck`, `self-improving`, `self-reflection` — OpenClaw heritage, carried across
- Swarm skills (`swarm-*`) — container-orchestrated multi-agent patterns

---

## Troubleshooting

### Bot not responding

1. Check service is running: `ps -ef | grep nanoclaw` (native) or `launchctl list | grep nanoclaw` (container/macOS)
2. Check logs: `tail -f logs/nanoclaw.log`
3. Check channel registration: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'dc:%'"`
4. Trigger-only channels: ensure message includes `@popashot`

### API rate limiting (429 errors)

If `system/api_retry` appears in logs, the Claude subscription is rate-limited — likely because another Claude session is consuming quota.
- Wait for the other session to finish
- Use a separate API key for NanoClaw
- Register a second token with OneCLI

### Container won't start (container mode)

```bash
docker info          # is Docker running?
docker images        # is the nanoclaw image built?
./container/build.sh # rebuild if missing
```

### Native runner crashes on startup

```bash
# Check HOME and project root are readable
node -e 'console.log(require("os").homedir())'
ls container/skills/ | head

# If skills dir is missing, you're on the wrong branch or setup.sh didn't finish
git status
```

### Skills not syncing in native mode

1. Verify `RUNTIME_MODE=native` in `.env`
2. Check the sync ran: `ls -la ~/.claude/skills/<skill-name>/SKILL.md`
3. Compare with source: `diff container/skills/<name>/SKILL.md ~/.claude/skills/<name>/SKILL.md`
4. Force a sync by sending any message to a registered channel

### OneCLI issues

```bash
onecli version       # installed?
onecli secrets list  # secrets registered?
curl http://127.0.0.1:10254/api/health  # gateway running?
```

### Discord bot sees messages but doesn't reply

- Check **Message Content Intent** is enabled in Discord Developer Portal
- Check `requires_trigger` — if `1`, messages need `@popashot`
- Check `is_main` — if `0` and `requires_trigger` is `0`, something else is wrong

---

## Reference

### File structure after migration (native mode)

```
nanoclaw/
├── .env                          # RUNTIME_MODE=native, channel tokens, config
├── store/messages.db             # SQLite: registered groups, history
├── groups/
│   ├── discord_nano/
│   │   ├── CLAUDE.md             # Full persona, rules, integrations, crons
│   │   ├── conversations/        # Chat history
│   │   ├── self-improving/       # Corrections, memory (HOT patterns)
│   │   └── logs/                 # Native runner logs per group
│   ├── discord_bug-reports/
│   │   └── CLAUDE.md             # Silent mode: auto-issue pipeline
│   └── discord_alpha-testing/
│       └── CLAUDE.md             # Bug triage, testing coordination
├── container/
│   ├── Dockerfile                # Only used in RUNTIME_MODE=container
│   └── skills/                   # Git-versioned source of truth (synced to ~/.claude/skills/ in native mode)
├── docs/
│   └── MIGRATION-OPENCLAW-TO-NANOCLAW.md  # This document
└── src/
    ├── native-runner.ts          # Native mode agent spawner + skills sync
    ├── container-runner.ts       # Container mode agent spawner
    ├── task-scheduler.ts         # Dispatches to native/container runner
    └── index.ts                  # Orchestrator entry point
```

### Key files changed for native mode

From the nanoclaw fork, commits `d59f74a` and `16fef7c`:

| File | Purpose |
|---|---|
| `src/config.ts` | Adds `RUNTIME_MODE` env var (`native` \| `container`) |
| `src/native-runner.ts` | New file — spawns agent as host child process, syncs skills |
| `src/container-runner.ts` | Existing — spawns agent as Docker container |
| `src/index.ts` | Dispatches to `runNativeAgent` or `runContainerAgent` based on mode |
| `src/task-scheduler.ts` | Same dispatch for scheduled jobs |
| `container/Dockerfile` | Adds tmux to container (for container mode) |
| `container/skills/` | Git-versioned source of truth for ~88 skills |

### Registered groups (Popashot example final state)

```
dc:1491178527498960966 | nano           | requires_trigger=1 | is_main=0
dc:1491216183045652650 | bug-reports    | requires_trigger=1 | is_main=0
dc:1491216139550851093 | alpha-testing  | requires_trigger=1 | is_main=0
```

All channels require `@popashot`. No channel is designated "main" (responds to all).

---

*Migration originally performed April 2026 (Popashot to Discord). Native runner restoration + skills auto-sync applied April 2026 on fork branch `main-a9b9f9f8`. This guide reflects both the container and native runtime modes.*
