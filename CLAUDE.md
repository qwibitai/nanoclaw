# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Cases — Isolated Work Items

Every piece of work is a **case**. Cases provide isolated containers, sessions, and (for dev) git worktrees. See `.claude/skills/cases/SKILL.md` for full docs.

**Architecture:** Cases are backed by a cloud CRM (GitHub Issues for the demo company, replaceable with any CRM). SQLite is a **local cache** — fast and offline-capable, but not the source of truth. All case access goes through the domain model (`cases.ts`) or MCP abstraction — never raw SQL.

- **work** cases use tooling to do useful work. **dev** cases improve tooling/workflows.
- Lifecycle: `SUGGESTED → BACKLOG → ACTIVE → DONE → REVIEWED → PRUNED`
- Kaizen: on completion, agents reflect on impediments and suggest dev improvements.
- With 2+ active cases, Haiku routes incoming messages to the right case.
- Replies are prefixed `[case: name]` in Telegram.
- **All dev work MUST be in a case with its own worktree.** Never modify code in main checkout. Enforced by `enforce-case-exists.sh` (L2 hook — blocks source edits in worktrees without a case).
- **Dev safe word escalation:** Non-main groups normally spawn work agents. Including a configured safe word in the trigger message escalates to dev mode — the container gets GitHub token, and dev cases bypass the approval gate. Configure per-group via `devSafeWords` in the group's `containerConfig` (in `registered_groups` table), or globally via `DEV_SAFE_WORDS` in `src/config.ts`. See `docs/safe-word-dev-escalation-spec.md`.
- Case naming: `YYMMDD-HHMM-kebab-description` (e.g., `260315-1430-fix-auth`)
- **Kaizen case naming:** `YYMMDD-HHMM-kNN-kebab-description` (e.g., `260318-2107-k21-fix-newline-prefix`). The `kNN` embeds the kaizen issue number, making it visible in branch names and `git worktree list`.

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
| Universal system deps | Harness Dockerfile (`container/Dockerfile`) | `chromium`, `git`, `node`, `ghostscript`, `poppler-utils` |
| Vertical-specific system deps | Declared by vertical, installed in container | `tesseract-ocr` (insurance) |
| Vertical npm deps | Vertical's `package.json` | `sharp`, `pdfjs-dist` |
| Domain tools/workflows | Vertical repo | `policy-cache-manager.js`, `workflows/` |
| Harness infrastructure | This repo | `src/`, `container/`, skills |

**Rules:**
- **NEVER install system packages on the host** (no `sudo apt install`) — system deps go in Dockerfiles. npm deps go in the relevant `package.json` and are installed via `npm install`
- **Dockerfile cache policy:** Layers are ordered least-frequently-changed → most-frequently-changed. When adding a new dependency, **ADD a new `RUN` layer** at the latest valid position — do NOT modify existing heavy layers (that invalidates all downstream cache and costs minutes in CI). See the cache strategy comments in `container/Dockerfile` for the layer map.
- **Domain-specific code goes in the vertical repo**, not here
- **Verticals are mounted into containers** at `/workspace/extra/{name}/`
- **Work agents** get read-only tools, read-write data. **Dev agents** modify code in worktrees.

### Vertical configuration contract

Verticals provide domain-specific configuration via files in their `config/` directory, mounted into containers at `/workspace/extra/{name}/config/`. The harness reads these files and acts on them. This keeps deployment-specific config portable with the repo — no host-level reconfiguration when moving between machines.

| Config file | Purpose | Docs |
|-------------|---------|------|
| `config/escalation.yaml` | Escalation policy: admins, gap types, priority signals, notification rules | See `escalation.example.yaml` in any vertical |
| `config/materials.json` | Material definitions, pricing | Vertical-specific |

The pattern: **harness provides mechanism, vertical provides policy**. The harness knows HOW to create cases, compute priority, and send notifications. The vertical knows WHO the admins are, WHAT gaps matter, and WHEN to notify.

### IP protection (future)

- Vertical repos: private (domain knowledge, customer data)
- Harness differentiators: move to private skills when needed
- Base NanoClaw: stays open-source (the framework)

## Architecture Layers & File Naming

NanoClaw has a layered architecture. File names encode which layer they belong to. **Do not mix layers** — each file should belong to exactly one layer.

```
Container (agent-facing MCP tools)          Host (harness)
┌──────────────────────────┐    IPC     ┌──────────────────────────────┐
│ mcp-*  or ipc-mcp-*.ts   │ ───────▶  │ ipc.ts (dispatcher)          │
│ (tool definitions)       │  JSON files│ ipc-{domain}.ts (handlers)   │
└──────────────────────────┘            │          ↓                   │
                                        │ {domain}.ts (model + logic)  │
                                        │ {domain}-auth.ts (policy)    │
                                        │          ↓                   │
                                        │ {domain}-backend.ts (iface)  │
                                        │ {domain}-backend-{prov}.ts   │
                                        │          ↓                   │
                                        │ {provider}-api.ts (REST)     │
                                        └──────────────────────────────┘
```

| Layer | Naming pattern | Example | Responsibility |
|-------|---------------|---------|----------------|
| **MCP tools** (container) | `mcp-*` or in `container/agent-runner/` | `ipc-mcp-stdio.ts` | Agent-facing tool definitions |
| **IPC dispatcher** | `ipc.ts` | `src/ipc.ts` | File watcher, routing to domain handlers |
| **IPC domain handlers** | `ipc-{domain}.ts` | `src/ipc-cases.ts` | Domain-specific IPC business logic |
| **Domain model** | `{domain}.ts` | `src/cases.ts` | Data types, DB ops, lifecycle logic |
| **Domain policy** | `{domain}-auth.ts` | `src/case-auth.ts` | Authorization gates, policy decisions |
| **Backend interface** | `{domain}-backend.ts` | `src/case-backend.ts` | Backend-agnostic adapter interface |
| **Backend implementation** | `{domain}-backend-{provider}.ts` | `src/case-backend-github.ts` | Provider-specific backend (CRM sync) |
| **Provider API client** | `{provider}-api.ts` | `src/github-api.ts` | Low-level REST API client |

**Rules:**
- Backend files (`*-backend*.ts`) handle cloud sync. They never touch IPC or MCP.
- IPC handlers (`ipc-*.ts`) translate IPC requests into domain operations. They never call provider APIs directly — they go through the domain model or backend adapter.
- Domain model files (`cases.ts`, `case-auth.ts`) are the single source of truth for business logic. Both IPC handlers and backends depend on them.
- Provider API files (`github-api.ts`) are pure REST clients. They know nothing about cases, sync, or IPC.

### Cases and Kaizen — How They Relate

There are two case types: **work** (customer tasks) and **dev** (tooling improvements / kaizen). Both use the same case system, same MCP tools, same lifecycle.

**The kaizen loop:**
- Work agents encounter friction → file improvement requests → these become **dev cases** (backed by `Garsson-io/kaizen`)
- Dev agents also encounter friction → file improvement requests → also become **dev cases**
- When any case is marked done, the agent reflects on impediments → `case_suggest_dev` → new dev case suggested

**All case operations go through the case MCP tools** (`case_create`, `case_mark_done`, `case_suggest_dev`, etc.) for container agents, or via `node dist/cli-kaizen.js case-create` for host-side CLI agents. Never use raw SQL or `gh` CLI for case operations. The backend adapter (`case-backend-github.ts`) handles GitHub sync transparently.

**Separate CRM backends:** customer cases → per-customer CRM repo, dev/kaizen cases → `Garsson-io/kaizen`. The domain model (`cases.ts`) and backend adapter abstract this — agents don't know or care which repo backs their case.

**Dev workflow skills** (`/pick-work` → `/accept-case` → `/implement-spec` → `/kaizen`) manage the kaizen lifecycle. Host-side skills use `cli-kaizen.ts` for backlog queries and case creation.

**Architecture docs:** See [`docs/kaizen-ipc-architecture.md`](docs/kaizen-ipc-architecture.md) for the full architecture diagram and [`docs/kaizen-cases-unification-spec.md`](docs/kaizen-cases-unification-spec.md) for the unification spec.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/cases.ts` | Case model, DB ops, workspace management, lifecycle |
| `src/case-auth.ts` | Case creation authorization gate |
| `src/case-backend.ts` | Backend-agnostic sync adapter interface |
| `src/case-backend-github.ts` | GitHub Issues CRM backend implementation |
| `src/case-router.ts` | Haiku-based message routing to cases |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher + dispatcher |
| `src/ipc-cases.ts` | Case lifecycle IPC handlers |
| `src/github-api.ts` | GitHub REST API client (shared by CRM + kaizen) |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `store/messages.db` | SQLite database (messages, chats, cases, api_usage) |
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
| `/pick-work` | Intelligently select next kaizen issue — filters claimed, balances epic momentum vs diversity |
| `/gap-analysis` | Strategic analysis of kaizen backlog — finds tooling/testing gaps, horizon concentration, unnamed dimensions |
| `/make-a-dent` | Autonomous deep-dive — fix root cause category behind repeated issues, add interaction tests, ship one high-impact PR |

### Dev work skill chain — MUST follow this workflow

When the conversation involves **selecting, evaluating, or starting dev work**, activate the right skills in sequence. Do NOT jump straight to writing code.

```
User asks "where are the gaps", "analyze gaps", "what should we invest in"
  → /gap-analysis  (strategic: tooling/testing gaps, horizon concentration, unnamed dimensions)
    → produces: low-hanging fruit, feature PRD candidates, meta/horizon PRD candidates

User asks "make a dent", "hero mode", "fix the category", "deep dive", "autonomous fix"
  → /make-a-dent  (autonomous: find root cause category, fix bugs, add interaction tests, ship PR)

User asks "what's next", "pick work", "pick a kaizen", "what should we work on"
  → /pick-work  (filter claimed issues, score by momentum/diversity, present options)

User discusses a specific issue, PR, case, or spec
  → /accept-case  (collision check, evaluate, find low-hanging fruit, get admin input)

User greenlights: "lets do it", "go ahead", "build it", "do it", "yes", etc.
  → /implement-spec  (five-step algorithm, create case + worktree, then execute)
  → MUST pass githubIssue number when creating case for a kaizen issue

Work is large enough to need multiple PRs
  → /plan-work  (break into sequenced PRs with dependency graph)

Work is done
  → /kaizen  (reflect on impediments, suggest improvements)
```

**Key triggers to recognize:**
- **Strategic gap analysis:** "gap analysis", "analyze gaps", "where are problems concentrated", "tooling gaps", "testing gaps" → `/gap-analysis`
- **Autonomous deep-dive:** "make a dent", "hero mode", "fix the category", "deep dive kaizen", "autonomous fix" → `/make-a-dent`
- **Selecting work from backlog:** "pick a kaizen", "what's next", "what should we work on", "find work", "choose issue" → `/pick-work`
- **Evaluating specific work:** "look at issue #N", "check PR #N", "find low hanging fruit", "evaluate this" → `/accept-case`
- **Greenlighting work:** "lets do it", "go ahead", "build it", "start on this", "ship it", "make it happen" → `/implement-spec`
- **All dev work MUST be in a case.** If `/implement-spec` activates, create a case with worktree before writing any code.
- **Kaizen issue lifecycle:** When working on a kaizen issue, the `status:active`/`status:done` labels are auto-synced by `case-backend-github.ts`. Collision detection in `ipc-cases.ts` blocks duplicate case creation for the same issue.

## The Zen of Kaizen

The philosophy behind everything in this section. Run `/zen` to see the full commentary (`.claude/kaizen/zen.md`).

```
Compound interest is the greatest force in the universe.
Small improvements compound. Large rewrites don't ship.
Tsuyoku naritai — I want to become stronger. Not perfect today. Stronger tomorrow.
It's kaizens all the way down. Improve the work. Improve how you work. Improve how you improve.
No promises without mechanisms. "Later" without a signal is "never."
Reflection without action is decoration. An insight not filed is an insight lost.
Instructions are necessary but never sufficient.
Enforcement is love. The hook that blocks you at 2 AM saves the human at 9 AM.
An enforcement point is worth a thousand instructions. Put policy where intent meets action.
The right level matters more than the right fix.
Map the territory before you move through it.
A good taxonomy of the problem outlasts any solution.
Specs are hypotheses. Incidents are data. When they conflict, trust the data.
Every failure is a gift — if you file the issue.
The fix isn't done until the outcome is verified. "It should work" is not a test.
Humans should never wait on agent mistakes.
Isolation prevents contamination. Your worktree, your state, your problem.
Avoiding overengineering is not a license to underengineer.
Build what the problem needs. Not more, not less.
The most dangerous requirement is the one nobody re-examined.
When in doubt, escalate the level, not the volume.
The goal is not to be done. The goal is to be better at not being done.
```

## Dev Agent Policies (Kaizen)

These policies were learned from past mistakes. Follow them strictly.

1. **Architecture decisions require explicit approval.** When choosing where code lives, what dependencies to use, or what tools to install — present options with tradeoffs and ask Aviad before proceeding. Don't assume.
2. **NEVER install system packages on the host machine** (no `sudo apt install`). System deps go in Dockerfiles. npm deps go in the relevant `package.json` and are installed via `npm install` (the root `postinstall` script also installs `container/agent-runner` deps for host-side type-checking).
3. **Research before installing.** Check existing NanoClaw skills first (some may already solve the problem). Search for modern, agent-compatible, container-friendly tools. Don't impulsively install the first package that comes to mind — evaluate alternatives. Present findings before proceeding.
4. **Ask "harness or vertical?"** before writing any code. Domain-specific code (workflows, tools, business data) belongs in the vertical repo. Infrastructure code (channels, routing, containers) belongs here.
5. **Put durable knowledge in CLAUDE.md and docs/, not just local memory.** `~/.claude/` memory is local to one machine and not synced to git. Any knowledge that future agents need must be in repo files.
6. **Work agents get read-only tools.** They can USE tools but not modify them. Dev agents modify in worktrees.
7. **Write tests BEFORE production code (TDD).** Tests written after code verify what you built; tests written before code verify what should be true. The ordering matters — failing tests are a diagnostic tool that reveals bugs code reading alone misses (see kaizen #120). The cycle: RED (write failing tests expressing target invariants) → GREEN (minimal production code to pass) → REFACTOR. Run the full test suite after. If the code can't run on the host, test module loading and error paths on the host and verify full behavior in a container. "It should work" is not a test.
8. **Skill branches must stay clean.** A `skill/*` branch is for upstream contribution — it contains ONLY that skill's changes on top of upstream/main. NEVER merge our fork's main into a skill branch. To update a skill branch, cherry-pick only the relevant skill-related commits. Fixes go to main first, then cherry-pick to the skill branch.
9. **Declare ALL dependencies.** Every `require()` or `import` must have a corresponding entry in the relevant `package.json`. Never assume a package is "globally available." Run `npm install` in a clean state and verify the code loads.
10. **Prefer simpler dependency stacks.** Before adding wrapper/plugin packages, check if the base library can achieve the same with configuration. Fewer deps = fewer failure points.
11. **Recursive kaizen on every fix-PR.** See `.claude/skills/kaizen/SKILL.md` for the full framework. After every fix, assess:
    - **What level is this fix?** Level 1 (instructions) → Level 2 (hooks/checks) → Level 3 (mechanistic code)
    - **Has this type of failure happened before?** If yes, the previous level wasn't enough — escalate.
    - **Affects humans directly?** → Must be Level 3 (humans should never wait on agent mistakes)
    - CLAUDE.md instructions are Level 1 — necessary but not sufficient. When they fail, escalate to hooks (Level 2) or architectural enforcement (Level 3).
12. **Hooks are the foundation of our kaizen infrastructure.** The `.claude/kaizen/hooks/` directory contains Level 2 enforcement — automated checks that catch mistakes before they reach humans. See `.claude/kaizen/README.md` for the full kAIzen Agent Control Flow system documentation. When a hook blocks you:
    - **Do NOT override it blindly.** The hook exists because a past mistake proved instructions alone weren't enough.
    - **If it's a false positive**, fix the hook. Improve its matching logic, add exclusions with rationale, and add a test case that covers the false-positive scenario. This is recursive kaizen — making the enforcement smarter, not weaker.
    - **If it's a true positive**, fix the underlying issue. The hook is doing its job.
    - **Always add a test** for any hook change in `.claude/kaizen/hooks/tests/`. Hooks without tests are Level 1 pretending to be Level 2.
14. **MCP tools are Level 3 enforcement points, not passthroughs.** When an agent behavior problem surfaces through an MCP tool, the fix belongs in the tool's logic — validation, auto-detection, or rejection. Don't default to updating the tool's description text (Level 1) when the kaizen rules demand Level 3. The MCP boundary is where agent intent meets system action; that's where policy enforcement belongs. Level 1 description improvements are defense-in-depth on top of Level 3, not a substitute.
15. **Authoritative security files: do NOT duplicate, do NOT bypass.** Files with `security`, `auth`, or `allowlist` in their name (`case-auth.ts`, `mount-security.ts`, `sender-allowlist.ts`) are the single source of truth for their policy domain. All authorization decisions in that domain MUST go through the authoritative file. Never inline ad-hoc authorization checks elsewhere — call the gate function instead. Changes to these files require careful review and tests.
16. **Hooks MUST be worktree-isolated.** A hook running in worktree A must NEVER read, modify, or block based on state from worktree B. This is a hard safety invariant — violations cause cross-worktree contamination where one agent's work hijacks another agent's session. All state file iteration MUST go through `lib/state-utils.sh` (`is_state_for_current_worktree`, `list_state_files_for_current_worktree`). Never iterate `/tmp/.pr-review-state/` directly. State files without a BRANCH field are treated as unattributable and skipped.
17. **Co-commit source and test changes.** Every source file change must have a corresponding test file change in the same PR. Test utilities use the `.test-util.ts` extension (excluded from coverage checks). If a source change genuinely doesn't need tests (e.g., trivial constant change, already covered by existing tests), declare it in the PR body using the `test-exceptions` fenced block — this is public and auditable.

## Verification Discipline (Kaizen #11, #15, #17)

### Path Tracing — MANDATORY before any fix

Before writing ANY fix, map the full execution path from trigger to user-visible outcome:

```
1. MAP the chain: input → layer 1 → layer 2 → ... → user-visible outcome
2. For each link: how to verify it works, what artifact/log/query proves it
3. After the fix: verify EVERY link, not just the one you changed
4. Self-review must trace the path — "I changed layer N, what happens at N+1...?"
```

**Never fix a single layer and declare done.** The fix isn't complete until the final outcome is verified end-to-end.

### Invariant Statement — MANDATORY before writing tests

Before writing ANY test, state explicitly:

```
INVARIANT: [what must be true]
SUT: [exact system/function/artifact under test]
VERIFICATION: [how the test proves the invariant holds]
```

**Anti-patterns to avoid:**
- Testing mocks instead of real code (you're proving your mocks work, not your code)
- Testing the wrong artifact (e.g., `/app/dist/` when runtime uses `/tmp/dist/`)
- "All 275 tests pass" when none cover the actual change
- Verifying implementation details (`cpSync was called`) instead of outcomes (`agent has the tool`)

### Runtime Artifact Verification

Always test the **actual deployed artifact**, not just source presence:
- If code is compiled, test the compiled output
- If code runs in a container, verify inside the container
- If a mount provides a file, verify the mount exists AND the consumer reads it
- "The file exists in the repo" is not verification — "the agent receives it at runtime" is

### Smoke Tests — MANDATORY when review identifies them

When a PR review says a smoke test is needed, **you must perform it before declaring the PR ready**. "Pending manual smoke test" is not an acceptable review outcome — it means the review is incomplete.

Smoke test checklist:
1. **Identify what to smoke test** — the review will name the untested path (e.g., "never hit real GitHub API", "never ran in container")
2. **Run it** — execute the actual end-to-end path. If it requires credentials or infrastructure you don't have, ask the user to provide them or run the test together.
3. **Record the result** — include the smoke test output (success or failure) in the PR or review comment.
4. **If you can't smoke test** — explicitly state what's blocking and ask the user. Don't hand-wave it as "recommended before deploy."

The point of review is to catch gaps. A gap identified but not closed is not a review — it's a TODO list.

## Kaizen Backlog

Future work, process improvements, and cross-repo engineering proposals are tracked as GitHub Issues in [`Garsson-io/kaizen`](https://github.com/Garsson-io/kaizen). Dev agents file improvements via `case_suggest_dev` MCP tool (never raw `gh` CLI). Host-side skills query the backlog via `node dist/cli-kaizen.js list|view` and create cases via `node dist/cli-kaizen.js case-create`. Include: what, why, when, how, reproduction steps, and verification criteria.

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

### After every merge: sync local main

After merging a PR (via `gh pr merge`), always sync local main immediately:

```bash
git -C /home/aviadr1/projects/nanoclaw fetch origin main && git -C /home/aviadr1/projects/nanoclaw merge --ff-only origin/main
```

This ensures hooks, settings, and CLAUDE.md changes take effect in the current session. Skipping this causes hooks registered in merged PRs to remain inactive.

**NEVER `cd` to the main checkout.** The main checkout is the production instance — other agents may be using it, and dirtying it can cause cross-agent contamination. Always use `git -C` for the sync and stay in your worktree. If you need follow-up work after merge, create a new branch from within your worktree.

### Critical rules

- **Build BEFORE restart** — never restart with an untested build
- **Never leave leads uninformed** — they must know if the system is down or degraded
- **If anything fails, keep running on the old version** — availability > new features

## Database

SQLite database at `store/messages.db` (path defined by `STORE_DIR` in `src/config.ts`). Uses `better-sqlite3` (NOT the `sqlite3` CLI, which is not installed). **For cases, always use the CLI instead of raw SQL:**

```bash
node dist/cli-kaizen.js case-list                              # all cases
node dist/cli-kaizen.js case-list --status active,blocked       # filter by status
node dist/cli-kaizen.js case-by-branch <branch-name>            # find case for a branch
node dist/cli-kaizen.js case-update-status <name> <status>      # update case status
```

For other tables, query via `better-sqlite3`:
```bash
node -e "const db=require('better-sqlite3')('store/messages.db'); console.log(JSON.stringify(db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 5').all(), null, 2))"
```

Tables: `messages`, `chats`, `cases`, `sessions`, `api_usage`, `usage_categories`, `scheduled_tasks`, `task_run_logs`, `registered_groups`, `router_state`.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm install          # Install deps (also installs container/agent-runner deps via postinstall)
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

## End-of-Session Cleanup

Before ending a dev session, run through this checklist:

1. **Dirty files** — `git status` on main and all verticals. Commit meaningful changes, discard noise.
2. **Stale branches** — delete local branches for merged PRs (`git branch -d <branch>`). Use `-d` (not `-D`) to avoid deleting unmerged work.
3. **Stale worktrees** — prune ONLY worktrees you created in this session. **NEVER force-remove worktrees you didn't create** — other Claude agents may be actively working in them. Check `git worktree list` and only remove worktrees whose branch names match your completed PRs. When in doubt, leave it.
4. **Kaizen issues** — close any resolved issues in `Garsson-io/kaizen`.
5. **Service health** — `systemctl --user status nanoclaw` — verify active and running.
6. **Notify leads** if any pending action items remain for them.

## Git Remotes

This is a fork of `qwibitai/nanoclaw`. Remotes:
- `origin` = `Garsson-io/nanoclaw` (our fork — PRs for main go here)
- `upstream` = `qwibitai/nanoclaw` (upstream — only for skill contributions)

**Always use `--repo Garsson-io/nanoclaw`** with `gh` commands. The `gh` CLI may default to upstream otherwise.

## Merging PRs

Branch protection has `strict: true` status checks. Auto-merge is enabled. The agent handles the full merge loop autonomously — do NOT ask the user unless something is genuinely broken after retries.

Required status checks (all must pass before merge):
- **ci** — typecheck, format, contract check, unit tests (harness + agent-runner)
- **pr-policy** — test coverage for changed source files, verification section in PR body
- **e2e** — container build + Tier 1 (MCP tool registration) + Tier 2 (IPC round-trip with stub API). Uses BuildKit with GHA cache; skips expensive steps on docs-only PRs via path filter.

```bash
# Step 1: Queue auto-merge (non-blocking — GitHub merges when CI passes + branch is current)
gh pr merge <url> --repo Garsson-io/nanoclaw --squash --delete-branch --auto

# Step 2: Actively monitor CI (do NOT use `gh run watch` — it blocks with no visibility)
# Poll job-level status every 15-30s:
gh run view <run-id> --repo Garsson-io/nanoclaw --json jobs --jq '.jobs[] | "\(.name): \(.status) \(.conclusion)"'
# IMPORTANT: Interleave PR state checks — auto-merge fires as soon as checks pass.
# Check PR state every 2-3 CI polls to detect completion promptly:
gh pr view <url> --repo Garsson-io/nanoclaw --json state --jq .state
# If state is "MERGED", skip to step 4. Do NOT keep polling CI after merge completes.
# When a job completes, note its duration. When the last job is running, check step-level progress:
gh run view <run-id> --repo Garsson-io/nanoclaw --json jobs --jq '.jobs[] | select(.status=="in_progress") | .steps[] | "\(.name): \(.status) \(.conclusion)"'
# If Docker build > 2min, check logs for cache misses. If all layers CACHED but still slow, it's I/O (image export).
# Report progress proactively: "CI: 2/3 jobs passed, e2e running — Docker build 57s all cached, now running IPC tests"

# Step 3: Verify merge completed
gh pr view <url> --repo Garsson-io/nanoclaw --json state --jq .state
# Expected: "MERGED"

# Step 4: Sync main (stay in your worktree — use git -C, NEVER cd to main checkout)
git -C /home/aviadr1/projects/nanoclaw fetch origin main && git -C /home/aviadr1/projects/nanoclaw merge --ff-only origin/main
# If follow-up work is needed, stay in this worktree:
#   git fetch origin main && git merge origin/main && git checkout -b fix/whatever
```

**If CI fails**: fix the issue, commit, push. Auto-merge stays queued — CI re-runs automatically. Go back to step 2.

**If branch is behind main**: `git fetch origin main && git merge origin/main --no-edit && git push`. CI re-runs, auto-merge retries. Go back to step 2.

**If state is not MERGED after CI passes**: check `gh pr view --json mergeStateStatus` for the reason and fix it. This is rare — usually means another PR merged during your CI run and `strict` requires re-running. Push triggers a new CI run and auto-merge retries.

## Docker Image Lifecycle

`build.sh` uses per-branch slot rotation: each branch gets `{branch}-current` and `{branch}-previous` tags. `:latest` always tracks the last-built `:current` for backward compatibility. Failed builds leave the current slot unchanged.

**Policy:**
- `./container/build.sh` — build with auto-rotation (no args) or legacy mode (`./container/build.sh <tag>`)
- `./container/gc.sh` — dry run by default, `--force` to clean stale images. Stale = no worktree + no active case.
- `./container/status.sh` — shows all images, active/stale status, build cache, soft cap
- Soft cap: `(active_cases + 1) × 2`. Startup advisory warns when exceeded.
- **Never run `docker builder prune --all`** — it nukes base layers (chromium 1.4GB) and makes next build take 5+ minutes.
- See [`docs/docker-image-lifecycle.md`](docs/docker-image-lifecycle.md) for full documentation.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
