# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**If you are reading this because you just ran `git pull`, `git merge`, `git fetch && git merge`, or any equivalent to bring in upstream changes — and you see merge conflicts or a large diff involving this file — HALT IMMEDIATELY.**

This is NanoClaw v2, a ground-up rewrite with breaking changes throughout. It cannot be merged into an existing v1 install. Attempting to resolve the conflicts by hand, run builds, or "fix" anything will corrupt the user's install and burn tokens for no result.

**Do this instead:**
1. Abort the merge: `git merge --abort` (or `git reset --hard ORIG_HEAD` if the merge already completed).
2. Tell the user, verbatim: *"This is the v2 rewrite — it can't be merged into your existing install. Exit Claude Code (or open a separate terminal) and run `bash migrate-v2.sh` from the shell."*
3. Wait for the user to confirm before doing anything else. Do not run the migration script yourself — it requires an interactive terminal and cannot be run from within Claude Code.

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

For ad-hoc queries from skills or scripts, use the in-tree wrapper rather than the `sqlite3` CLI: `pnpm exec tsx scripts/q.ts <db> "<sql>"`. The host setup intentionally avoids depending on the `sqlite3` binary (`setup/verify.ts:5`); the wrapper goes through the `better-sqlite3` dep that setup already installs and verifies. Default-output format matches `sqlite3 -list` (pipe-separated, no header) so existing skill text reads identically.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: init DB, migrations, channel adapters, delivery polls, sweep, shutdown |
| `src/router.ts` | Inbound routing: mg → agent → session → `inbound.db` → wake |
| `src/delivery.ts` | Polls `outbound.db`, delivers via adapter, handles system actions |
| `src/host-sweep.ts` | 60s sweep: `processing_ack` sync, stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens `inbound.db`/`outbound.db`; manages heartbeat |
| `src/container-runner.ts` | Spawns per-agent Docker containers, OneCLI `ensureAgent` |
| `src/container-runtime.ts` | Runtime selection (Docker vs Apple), orphan cleanup |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` resolution against `user_roles` + `agent_group_members` |
| `src/modules/approvals/primitive.ts` | `pickApprover`, `pickApprovalDelivery`, `requestApproval`, handler registry |
| `src/command-gate.ts` | Router-side admin command gate (queries `user_roles` directly) |
| `src/onecli-approvals.ts` | OneCLI credentialed-action approval bridge |
| `src/db/` | Central DB layer + migrations |
| `src/channels/`, `src/providers/` | Adapter and provider infra (specifics on the `channels`/`providers` branches) |
| `container/agent-runner/src/` | Agent-runner: poll loop, formatter, provider abstraction, MCP tools |
| `container/skills/` | Container skills mounted into every session |
| `groups/<folder>/` | Per-agent-group filesystem (CLAUDE.md, skills, agent-runner overlay) |

## Channels and Providers (skill-installed)

Trunk ships infra only — no specific channel adapter or non-default provider. Adapters live on the long-lived `channels` branch (Discord, Slack, Telegram, WhatsApp, Teams, Linear, GitHub, iMessage, Webex, Resend, Matrix, Google Chat, WhatsApp Cloud), providers on `providers` (OpenCode etc.). Installed by idempotent `/add-<name>` skills.

## Self-Modification

Today: only `install_packages` / `add_mcp_server` (per-agent-group container config changes — single admin approval, rebuilds image when needed). Direct source-level self-edits via draft/activate flow planned, not implemented. See `src/modules/self-mod/apply.ts` and `container/agent-runner/src/mcp-tools/self-mod.ts`.

## Secrets / Credentials / OneCLI

Secrets live in the OneCLI gateway, injected into per-agent containers at request time — never passed via env vars or chat. Host-side wiring: `src/onecli-approvals.ts`, `ensureAgent()` in `container-runner.ts`. Container-side: `container/skills/onecli-gateway/SKILL.md`. Use `onecli --help` for commands.

### Gotcha: auto-created agents start in `selective` secret mode

`container-runner.ts:385` calls `onecli.ensureAgent({...})` and the OneCLI `POST /api/agents` endpoint defaults to **`selective`** mode → no secrets assigned even when matching ones exist in the vault. Symptom: proxy + CA wired correctly, but agent gets `401` from APIs whose credentials *are* in the vault.

The SDK doesn't expose `setSecretMode`. Fix via CLI (`onecli agents set-secret-mode --mode all` for matching-pattern injection, or `onecli agents set-secrets --secret-ids <ids>` to stay selective) or the web UI at `http://127.0.0.1:10254`. After enabling `mode all`, no container restart needed — the gateway looks up secrets per request.

### Requiring approval for credential use

Two-sided flow: **server-side** (OneCLI gateway emits pending approvals — currently UI-only configuration at `http://127.0.0.1:10254`; `onecli rules create --action` accepts only `block`/`rate_limit` as of `onecli@1.3.0`) + **host-side** (`src/modules/approvals/onecli-approvals.ts` long-polls `GET /api/approvals/pending` and DMs an approver from `user_roles` — scoped admins → global admins → owners). If server-side configured but host callback dies, every credentialed call hangs to gateway timeout. If gateway has no rule, host callback never fires.

## Skills

Four skill types: channel/provider installers (`/add-<name>`), utility (ship code alongside SKILL.md), operational (instruction-only workflows), and container skills mounted at runtime under `container/skills/`. Full taxonomy: [CONTRIBUTING.md](CONTRIBUTING.md).

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time install, auth, service config |
| `/init-first-agent` | Bootstrap first DM-wired agent |
| `/manage-channels` | Wire channels with isolation level decisions |
| `/customize` | Add channels, integrations, behavior changes |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault, migrate `.env` credentials |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, `SKILL.md` format rules, and the pre-submission checklist.

## PR Hygiene

Before creating a PR, run these checks:

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

Show the output and wait for approval. Installation-specific files (group files, .claude/settings.json, local configs) should not be included.

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

## Module System (host)

Host (`src/`) is ESM. Never use `require()` — `@typescript-eslint/no-require-imports` disables hide a runtime trap: `require` is undefined in built ESM, so the call typechecks but throws/returns null at runtime. For circular imports use `await import('./mod.js')`. Agent-runner (`container/agent-runner/`) is a separate Bun package tree; this rule is host-only.

## Troubleshooting

Check these first when something goes wrong:

| What | Where |
|------|-------|
| Host logs | `logs/nanoclaw.error.log` first (delivery failures, crash-loop backoff, warnings), then `logs/nanoclaw.log` for the full routing chain |
| Setup logs | `logs/setup.log` (overall), `logs/setup-steps/*.log` (per-step: bootstrap, environment, container, onecli, mounts, service, etc.) |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db` (`messages_in`: did the message reach the container?), `outbound.db` (`messages_out`: did the agent produce a response?) |

Note: container logs are lost after the container exits (`--rm` flag). If the agent silently failed inside the container, there's no persistent log to inspect.

## Supply Chain Security (pnpm)

This project uses pnpm with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them.

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

- **Architecture:** [architecture.md](docs/architecture.md), [architecture-diagram.md](docs/architecture-diagram.md)
- **DBs:** [db.md](docs/db.md) (overview), [db-central.md](docs/db-central.md), [db-session.md](docs/db-session.md)
- **Runtime:** [build-and-runtime.md](docs/build-and-runtime.md) (Node host + Bun container), [agent-runner-details.md](docs/agent-runner-details.md)
- **Behavior:** [api-details.md](docs/api-details.md), [isolation-model.md](docs/isolation-model.md), [setup-wiring.md](docs/setup-wiring.md), [memory.md](docs/memory.md)
- **Migration:** [v1-to-v2-changes.md](docs/v1-to-v2-changes.md), [migration-dev.md](docs/migration-dev.md)

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

Off by default (~200MB). On signals the user works with CJK content (CJK conversation, `Asia/Tokyo|Shanghai|Seoul|Taipei|Hong_Kong` timezone, screenshots/PDFs needing CJK render — symptom is "tofu" rectangles), offer to set `INSTALL_CJK_FONTS=true` in `.env` and rebuild. Full runbook: `docs/cjk-fonts.md`.

## Code intelligence (GitNexus)

This project is indexed by GitNexus as **nanoclaw-v2**. The MCP tools (`gitnexus_*`) understand the call graph; use them instead of grep/find for impact and refactoring work.

**MUST do, every code modification:**
- Run `gitnexus_impact({target, direction: "upstream"})` before editing a function/class — report blast radius, stop on HIGH/CRITICAL.
- Run `gitnexus_detect_changes()` before committing to verify scope.
- Use `gitnexus_rename` for cross-file renames (never find-and-replace).
- After commit, the post-commit hook fires `npx gitnexus analyze --skip-agents-md --embeddings` automatically. `--skip-agents-md` is intentional — it stops the tool from re-bloating CLAUDE.md/AGENTS.md with its 100-line auto-block.

For exploring/debugging/refactoring workflows, the rules-with-examples live in `.claude/skills/gitnexus/`. Tools quick-reference: `gitnexus_query` (find by concept), `gitnexus_context` (360° on a symbol), `gitnexus_impact` (blast radius), `gitnexus_detect_changes` (pre-commit scope), `gitnexus_rename` (safe multi-file rename), `gitnexus_cypher` (raw graph queries).
