# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**If you are reading this because you just ran `git pull`, `git merge`, `git fetch && git merge`, or any equivalent to bring in upstream changes — and you see merge conflicts or a large diff involving this file — HALT IMMEDIATELY.**

This is NanoClaw v2, a ground-up rewrite with breaking changes throughout. It cannot be merged into an existing v1 install. Attempting to resolve the conflicts by hand, run builds, or "fix" anything will corrupt the user's install and burn tokens for no result.

**Do this instead:**
1. Abort the merge: `git merge --abort` (or `git reset --hard ORIG_HEAD` if the merge already completed).
2. Tell the user, verbatim: *"This is the v2 rewrite — it can't be merged into your existing install. Run `bash migrate-v2.sh` to migrate instead."*
3. Wait for the user to confirm before doing anything else. Do not attempt the migration yourself.

If you are a fresh install (you ran `git clone`, not `git pull`) and there are no conflicts, ignore this banner and continue below.

---

# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. Architecture lives in `docs/`.

## Quick Context

The host is a single Node process that orchestrates per-session agent containers. Platform messages land via channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), get written into the session's inbound DB, and wake a container. The agent-runner inside the container polls the DB, calls Claude, and writes back to the outbound DB. The host polls the outbound DB and delivers through the same adapter.

**Everything is a message.** There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the sole IO surface.

## Entity Model

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (global or scoped)
agent_group_members (user_id, agent_group_id)    — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id) — cold-DM cache

agent_groups (workspace, memory, CLAUDE.md, personality, container config)
    ↕ many-to-many via messaging_group_agents (session_mode, trigger_rules, priority)
messaging_groups (one chat/channel on one platform; unknown_sender_policy)

sessions (agent_group_id + messaging_group_id + thread_id → per-session container)
```

Privilege is user-level (owner/admin), not agent-group-level. See [docs/isolation-model.md](docs/isolation-model.md) for the three isolation levels (`agent-shared`, `shared`, separate agents).

## Two-DB Session Split

Each session has **two** SQLite files under `data/v2-sessions/<session_id>/`:

- `inbound.db` — host writes, container reads. `messages_in`, routing, destinations, pending_questions, processing_ack.
- `outbound.db` — container writes, host reads. `messages_out`, session_state.

Exactly one writer per file — no cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update. Host uses even `seq` numbers, container uses odd.

## Central DB

`data/v2.db` holds everything that isn't per-session: users, user_roles, agent_groups, messaging_groups, wiring, pending_approvals, user_dms, chat_sdk_* (for the Chat SDK bridge), schema_version. Migrations live at `src/db/migrations/`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: init DB, migrations, channel adapters, delivery polls, sweep, shutdown |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `inbound.db` → wake |
| `src/delivery.ts` | Polls `outbound.db`, delivers via adapter, handles system actions (schedule, approvals, etc.) |
| `src/host-sweep.ts` | 60s sweep: `processing_ack` sync, stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens `inbound.db` / `outbound.db`; manages heartbeat path |
| `src/container-runner.ts` | Spawns per-agent-group Docker containers with session DB + outbox mounts, OneCLI `ensureAgent` |
| `src/container-runtime.ts` | Runtime selection (Docker vs Apple containers), orphan cleanup |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` — owner / global admin / scoped admin / member resolution against `user_roles` + `agent_group_members` |
| `src/modules/approvals/primitive.ts` | `pickApprover`, `pickApprovalDelivery`, `requestApproval`, approval-handler registry |
| `src/command-gate.ts` | Router-side admin command gate — queries `user_roles` directly (no env var, no container-side check) |
| `src/onecli-approvals.ts` | OneCLI credentialed-action approval bridge |
| `src/user-dm.ts` | Cold-DM resolution + `user_dms` cache |
| `src/group-init.ts` | Per-agent-group filesystem scaffold (CLAUDE.md, skills, agent-runner-src overlay) |
| `src/db/` | DB layer — agent_groups, messaging_groups, sessions, user_roles, user_dms, pending_*, migrations |
| `src/channels/` | Channel adapter infra (registry, Chat SDK bridge); specific channel adapters are skill-installed from the `channels` branch |
| `src/providers/` | Host-side provider container-config (`claude` baked in; `opencode` etc. installed from the `providers` branch) |
| `container/agent-runner/src/` | Agent-runner: poll loop, formatter, provider abstraction, MCP tools, destinations |
| `container/skills/` | Container skills mounted into every agent session |
| `groups/<folder>/` | Per-agent-group filesystem (CLAUDE.md, skills, per-group `agent-runner-src/` overlay) |
| `scripts/init-first-agent.ts` | Bootstrap the first DM-wired agent (used by `/init-first-agent` skill) |

## Channels and Providers (skill-installed)

Trunk does not ship any specific channel adapter or non-default agent provider. The codebase is the registry/infra; the actual adapters and providers live on long-lived sibling branches and get copied in by skills:

- **`channels` branch** — Discord, Slack, Telegram, WhatsApp, Teams, Linear, GitHub, iMessage, Webex, Resend, Matrix, Google Chat, WhatsApp Cloud (+ helpers, tests, channel-specific setup steps). Installed via `/add-<channel>` skills.
- **`providers` branch** — OpenCode (and any future non-default agent providers). Installed via `/add-opencode`.

Each `/add-<name>` skill is idempotent: `git fetch origin <branch>` → copy module(s) into the standard paths → append a self-registration import to the relevant barrel → `pnpm install <pkg>@<pinned-version>` → build.

## Self-Modification

One tier of agent self-modification today:

1. **`install_packages` / `add_mcp_server`** — changes to the per-agent-group container config only (apt/npm deps, wire an existing MCP server). Single admin approval per request; on approve, the handler in `src/modules/self-mod/apply.ts` rebuilds the image when needed (`install_packages` only) and restarts the container. `container/agent-runner/src/mcp-tools/self-mod.ts`.

A second tier (direct source-level self-edits via a draft/activate flow) is planned but not yet implemented.

## Secrets / Credentials / OneCLI

API keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway. Secrets are injected into per-agent containers at request time — none are passed in env vars or through chat context. `src/onecli-approvals.ts`, `ensureAgent()` in `container-runner.ts`. Run `onecli --help`.

### Gotcha: auto-created agents start in `selective` secret mode

When the host first spawns a session for a new agent group, `container-runner.ts:385` calls `onecli.ensureAgent({ name, identifier })`. The OneCLI `POST /api/agents` endpoint creates the agent in **`selective`** secret mode — meaning **no secrets are assigned to it by default**, even if the secrets exist in the vault and have host patterns that would otherwise match.

Symptom: container starts, the proxy + CA cert are wired correctly, but the agent gets `401 Unauthorized` (or similar) from APIs whose credentials *are* in the vault. The credential just isn't in this agent's allow-list.

The SDK does not expose `setSecretMode` — the only fix is the CLI (or the web UI at `http://127.0.0.1:10254`).

```bash
# Find the agent (identifier is the agent group id)
onecli agents list

# Flip to "all" so every vault secret with a matching host pattern gets injected
onecli agents set-secret-mode --id <agent-id> --mode all

# Or, stay selective and assign specific secrets
onecli secrets list                                    # find secret ids
onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>

# Inspect what an agent currently has
onecli agents secrets --id <agent-id>                  # secrets assigned to this agent
onecli secrets list                                    # all vault secrets (with host patterns)
```

If you've just enabled `mode all`, no container restart is needed — the gateway looks up secrets per request, so the next API call from the running container will see the new credentials.

### Requiring approval for credential use

Approval-gating credentialed actions is a **two-sided** flow:

- **Server-side** (OneCLI gateway): decides *when* to hold a request and emit a pending approval. As of `onecli@1.3.0`, the CLI does **not** expose this — `rules create --action` only accepts `block` or `rate_limit`, and `secrets create` has no approval flag. Approval policies must be configured via the OneCLI web UI at `http://127.0.0.1:10254`. If/when the CLI grows an `approve` action, this section needs updating.
- **Host-side** (nanoclaw): receives pending approvals and routes them to a human. `src/modules/approvals/onecli-approvals.ts` registers a callback via `onecli.configureManualApproval(cb)` (long-polls `GET /api/approvals/pending`). The callback uses `pickApprover` + `pickApprovalDelivery` from `src/modules/approvals/primitive.ts` to DM an approver. Approvers are resolved from the `user_roles` table — preference order: scoped admins for the agent group → global admins → owners. There is no env var like `NANOCLAW_ADMIN_USER_IDS`; roles are persisted in the central DB only.

If approvals are configured server-side but the host callback isn't running (or throws), every credentialed call hangs until the gateway times out. Conversely, if the gateway has no rule asking for approval, the host callback never fires regardless of how it's wired.

## Skills

Four types of skills. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy.

- **Channel/provider install skills** — copy the relevant module(s) in from the `channels` or `providers` branch, wire imports, install pinned deps (e.g. `/add-discord`, `/add-slack`, `/add-whatsapp`, `/add-opencode`).
- **Utility skills** — ship code files alongside `SKILL.md` (e.g. `/claw`).
- **Operational skills** — instruction-only workflows (`/setup`, `/debug`, `/customize`, `/init-first-agent`, `/manage-channels`, `/init-onecli`, `/update-nanoclaw`).
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`: `welcome`, `self-customize`, `agent-browser`, `slack-formatting`).

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time install, auth, service config |
| `/init-first-agent` | Bootstrap the first DM-wired agent (channel pick → identity → wire → welcome DM) |
| `/manage-channels` | Wire channels to agent groups with isolation level decisions |
| `/customize` | Adding channels, integrations, behavior changes |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, `SKILL.md` format rules, and the pre-submission checklist.

## Development

Run commands directly — don't tell the user to run them.

```bash
# Host (Node + pnpm)
pnpm run dev          # Host with hot reload
pnpm run build        # Compile host TypeScript (src/)
./container/build.sh  # Rebuild agent container image (nanoclaw-agent:latest)
pnpm test             # Host tests (vitest)

# Agent-runner (Bun — separate package tree under container/agent-runner/)
cd container/agent-runner && bun install   # After editing agent-runner deps
cd container/agent-runner && bun test      # Container tests (bun:test)
```

Container typecheck is a separate tsconfig — if you edit `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root (or `bun run typecheck` from `container/agent-runner/`).

Service management:
```bash
# macOS (launchd)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start|stop|restart nanoclaw
```

Host logs: `logs/nanoclaw.log` (normal) and `logs/nanoclaw.error.log` (errors only — some delivery/approval failures only show up here).

## Supply Chain Security (pnpm)

This project uses pnpm with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them.

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

| Doc | Purpose |
|-----|---------|
| [docs/architecture.md](docs/architecture.md) | Full architecture writeup |
| [docs/api-details.md](docs/api-details.md) | Host API + DB schema details |
| [docs/db.md](docs/db.md) | DB architecture overview: three-DB model, cross-mount rules, readers/writers map |
| [docs/db-central.md](docs/db-central.md) | Central DB (`data/v2.db`) — every table + migration system |
| [docs/db-session.md](docs/db-session.md) | Per-session `inbound.db` + `outbound.db` schemas + seq parity |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) | Agent-runner internals + MCP tool interface |
| [docs/isolation-model.md](docs/isolation-model.md) | Three-level channel isolation model |
| [docs/setup-wiring.md](docs/setup-wiring.md) | What's wired, what's open in the setup flow |
| [docs/architecture-diagram.md](docs/architecture-diagram.md) | Diagram version of the architecture |
| [docs/build-and-runtime.md](docs/build-and-runtime.md) | Runtime split (Node host + Bun container), lockfiles, image build surface, CI, key invariants |

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Container Runtime (Bun)

The agent container runs on **Bun**; the host runs on **Node** (pnpm). They communicate only via session DBs — no shared modules. Details and rationale: [docs/build-and-runtime.md](docs/build-and-runtime.md).

**Gotchas — trigger + action:**

- **Adding or bumping a runtime dep in `container/agent-runner/`** → edit `package.json`, then `cd container/agent-runner && bun install` and commit the updated `bun.lock`. Do not run `pnpm install` there — agent-runner is not a pnpm workspace.
- **Bumping `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, or any agent-runner runtime dep** → no `minimumReleaseAge` policy applies to this tree. Check the release date on npm, pin deliberately, never `bun update` blindly.
- **Writing a new named-param SQL insert/update in the container** → use `$name` in both SQL and JS keys: `.run({ $id: msg.id })`. `bun:sqlite` does not auto-strip the prefix the way `better-sqlite3` does on the host. Positional `?` params work normally.
- **Adding a test in `container/agent-runner/src/`** → import from `bun:test`, not `vitest`. Vitest runs on Node and can't load `bun:sqlite`. `vitest.config.ts` excludes this tree.
- **Adding a Node CLI the agent invokes at runtime** (like `agent-browser`, `claude-code`, `vercel`) → put it in the Dockerfile's pnpm global-install block, pinned to an exact version via a new `ARG`. Don't use `bun install -g` — that bypasses the pnpm supply-chain policy.
- **Changing the Dockerfile entrypoint or the dynamic-spawn command** (`src/container-runner.ts` line ~301) → keep `exec bun ...` so signals forward cleanly. The image has no `/app/dist`; don't reintroduce a tsc build step.
- **Changing session-DB pragmas** (`container/agent-runner/src/db/connection.ts`) → `journal_mode=DELETE` is load-bearing for cross-mount visibility. Read the comment block at the top of the file first.

## CJK font support

Agent containers ship without CJK fonts by default (~200MB saved). If you notice signals the user works with Chinese/Japanese/Korean content — conversing in CJK, CJK timezone (e.g., `Asia/Tokyo`, `Asia/Shanghai`, `Asia/Seoul`, `Asia/Taipei`, `Asia/Hong_Kong`), system locale hint, or mentions of needing to render CJK in screenshots/PDFs/scraped pages — offer to enable it:

```bash
# Ensure .env has INSTALL_CJK_FONTS=true (overwrite or append)
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env

# Rebuild and restart so new sessions pick up the new image
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

`container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through as a Docker build-arg. Without CJK fonts, Chromium-rendered screenshots and PDFs containing CJK text show tofu (empty rectangles) instead of characters.
