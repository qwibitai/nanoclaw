# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Cases — Isolated Work Items

Every piece of work is a **case**. Cases provide isolated containers, sessions, and (for dev) git worktrees. See `.claude/skills/cases/SKILL.md` for full docs.

- **work** cases use tooling to do useful work. **dev** cases improve tooling/workflows.
- Lifecycle: `SUGGESTED → BACKLOG → ACTIVE → DONE → REVIEWED → PRUNED`
- Kaizen: on completion, agents reflect on impediments and suggest dev improvements.
- With 2+ active cases, Haiku routes incoming messages to the right case.
- Replies are prefixed `[case: name]` in Telegram.
- **All dev work MUST be in a case with its own worktree.** Never modify code in main checkout.
- Case naming: `YYMMDD-HHMM-kebab-description` (e.g., `260315-1430-fix-auth`)

## Harness / Vertical Architecture

NanoClaw is a **harness** — a platform that powers multiple private vertical business repos. Each vertical is a separate private repo under Garsson-io with its own domain workflows, tools, and data.

```
NanoClaw (harness, public)              Verticals (private repos)
┌────────────────────────┐      ┌──────────────────────┐
│ Channels (TG, WA, etc) │      │ garsson-insurance     │
│ Container runtime      │─────▶│ garsson-prints        │
│ Cases & routing        │      │ (future verticals)    │
│ Skills system          │      └──────────────────────┘
│ Base Dockerfile        │
└────────────────────────┘
```

### Dependency placement rules

| Dependency type | Where it goes | Example |
|----------------|---------------|---------|
| Universal system deps | Harness Dockerfile (`container/Dockerfile`) | `chromium`, `git`, `node` |
| Vertical-specific system deps | Declared by vertical, installed in container | `poppler-utils` (insurance), `ghostscript` (prints) |
| Vertical npm deps | Vertical's `package.json` | `sharp`, `pdfjs-dist` |
| Domain tools/workflows | Vertical repo | `policy-cache-manager.js`, `workflows/` |
| Harness infrastructure | This repo | `src/`, `container/`, skills |

**Rules:**
- **NEVER install packages on the host** — system deps go in Dockerfiles, npm deps in package.json
- **Domain-specific code goes in the vertical repo**, not here
- **Verticals are mounted into containers** at `/workspace/extra/{name}/`
- **Work agents** get read-only tools, read-write data. **Dev agents** modify code in worktrees.

### IP protection (future)

- Vertical repos: private (domain knowledge, customer data)
- Harness differentiators: move to private skills when needed
- Base NanoClaw: stays open-source (the framework)

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/cases.ts` | Case model, DB ops, workspace management, lifecycle |
| `src/case-router.ts` | Haiku-based message routing to cases |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher, task/case processing |
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
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/contribute-skill` | Build and submit a new skill to the NanoClaw ecosystem |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |
| `/kaizen` | Recursive process improvement — escalation framework (Level 1→2→3) |

## Dev Agent Policies (Kaizen)

These policies were learned from past mistakes. Follow them strictly.

1. **Architecture decisions require explicit approval.** When choosing where code lives, what dependencies to use, or what tools to install — present options with tradeoffs and ask Aviad before proceeding. Don't assume.
2. **NEVER install packages on the host machine.** System deps go in Dockerfiles. npm deps go in project package.json. The container is the runtime environment, not the host.
3. **Research before installing.** Check existing NanoClaw skills first (some may already solve the problem). Search for modern, agent-compatible, container-friendly tools. Don't impulsively install the first package that comes to mind — evaluate alternatives. Present findings before proceeding.
4. **Ask "harness or vertical?"** before writing any code. Domain-specific code (workflows, tools, business data) belongs in the vertical repo. Infrastructure code (channels, routing, containers) belongs here.
5. **Put durable knowledge in CLAUDE.md and docs/, not just local memory.** `~/.claude/` memory is local to one machine and not synced to git. Any knowledge that future agents need must be in repo files.
6. **Work agents get read-only tools.** They can USE tools but not modify them. Dev agents modify in worktrees.
7. **Every code change MUST be tested before committing.** Run the code. Verify imports resolve. Execute the test suite. If no tests exist, write them. If the code can't run on the host (e.g., needs chromium), test module loading and error paths on the host, and verify full behavior in a container. A PR that merges untested code wastes more time than writing the tests. "It should work" is not a test.
8. **Skill branches must stay clean.** A `skill/*` branch is for upstream contribution — it contains ONLY that skill's changes on top of upstream/main. NEVER merge our fork's main into a skill branch. To update a skill branch, cherry-pick only the relevant skill-related commits. Fixes go to main first, then cherry-pick to the skill branch.
9. **Declare ALL dependencies.** Every `require()` or `import` must have a corresponding entry in the relevant `package.json`. Never assume a package is "globally available." Run `npm install` in a clean state and verify the code loads.
10. **Prefer simpler dependency stacks.** Before adding wrapper/plugin packages, check if the base library can achieve the same with configuration. Fewer deps = fewer failure points.
11. **Recursive kaizen on every fix-PR.** See `.claude/skills/kaizen/SKILL.md` for the full framework. After every fix, assess:
    - **What level is this fix?** Level 1 (instructions) → Level 2 (hooks/checks) → Level 3 (mechanistic code)
    - **Has this type of failure happened before?** If yes, the previous level wasn't enough — escalate.
    - **Affects humans directly?** → Must be Level 3 (humans should never wait on agent mistakes)
    - CLAUDE.md instructions are Level 1 — necessary but not sufficient. When they fail, escalate to hooks (Level 2) or architectural enforcement (Level 3).

## Kaizen Backlog

Future work, process improvements, and cross-repo engineering proposals are tracked as GitHub Issues in [`Garsson-io/kaizen`](https://github.com/Garsson-io/kaizen). When a dev agent identifies an improvement that's out of scope for the current PR, file it there with the `kaizen` label. Include: what, why, when, how, reproduction steps, and verification criteria.

## Post-Merge: Deploy & Maintenance Policy

After merging to main, classify the change and follow the appropriate procedure. **Leads (Aviad/Liraz) MUST be notified** via Telegram at every stage.

### Change classification

| Change type | Action needed | Downtime |
|------------|--------------|----------|
| CLAUDE.md, docs/ | None — read on next conversation | Zero |
| Vertical repo (tools, workflows) | None — mounted live into containers | Zero |
| `src/` code | `npm run build` + service restart | ~10s |
| `container/Dockerfile` or `agent-runner/` | `./container/build.sh` then restart | Build: 1-5min (zero), restart: ~10s |
| `package.json` deps | `npm install` + build + restart | ~10s |

### Procedure for restart-required changes

```
1. CLASSIFY — what action is needed?
2. PRE-FLIGHT checks:
   - `git status` on main checkout — must be clean. If dirty, investigate (don't blindly stash).
   - `docker ps` — verify Docker is available (if container build needed).
   - `git pull origin main` — ensure main is up to date.
3. NOTIFY leads BEFORE starting:
   "🔧 Maintenance: [what changed]. Building now, will restart when ready (~Xmin)."
4. BUILD while still running (zero downtime during build):
   - npm install (if deps changed)
   - npm run build (if src/ changed)
   - ./container/build.sh (if Dockerfile changed)
5. If build FAILS → DO NOT restart. Report:
   "❌ Build failed: [error]. Still running previous version."
   Stop and investigate.
6. If build SUCCEEDS → report:
   "🔧 Build done. Restarting now (~10s downtime)."
   Then restart the service.
7. Verify health — can the service respond to messages?
8. Report completion:
   "✅ Maintenance complete. New capabilities: [list]."
   OR "❌ Restart failed: [error]. Investigating."
```

### For zero-downtime changes

Notify only: "✅ Updated [what]. Active on next conversation, no restart needed."

### Critical rules

- **Build BEFORE restart** — never restart with an untested build
- **Never leave leads uninformed** — they must know if the system is down or degraded
- **If anything fails, keep running on the old version** — availability > new features

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

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Sending Messages via IPC

To send a Telegram message from the host (outside a container), write a JSON file to the group's `messages` directory:

```bash
cat > data/ipc/{group_folder}/messages/msg-$(date +%s).json << 'EOF'
{
  "type": "message",
  "chatJid": "tg:{chat_id}",
  "text": "Your message here"
}
EOF
```

**Common mistakes:**
- Type must be `"message"`, NOT `"send_message"`
- Directory must be `messages/`, NOT `tasks/`
- The `tasks/` directory is for scheduled tasks, not direct messages

**Known group JIDs:**
- Garsson: `tg:-5128317012` (folder: `telegram_garsson`)

## Git Remotes

This is a fork of `qwibitai/nanoclaw`. Remotes:
- `origin` = `Garsson-io/nanoclaw` (our fork — PRs for main go here)
- `upstream` = `qwibitai/nanoclaw` (upstream — only for skill contributions)

**Always use `--repo Garsson-io/nanoclaw`** with `gh` commands. The `gh` CLI may default to upstream otherwise.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
