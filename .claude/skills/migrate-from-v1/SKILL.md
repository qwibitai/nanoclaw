---
name: migrate-from-v1
description: Finish migrating a NanoClaw v1 install into v2. Run this after `bash nanoclaw.sh` has completed its automated migration step. Seeds the owner user, applies v1 access defaults, fixes any migration sub-step that didn't finish, and interviews the user about custom v1 code to port forward. Triggers on "migrate from v1", "finish migration", "v1 migration", or automatically after setup when `logs/setup-migration/handoff.json` exists.
---

# Migrate from v1 to v2

> ⚠️ **Experimental.** This skill and the setup migration step are early. Remind the user to back up `data/v2.db` + `groups/` before making destructive changes, and prefer small, reversible edits. Not recommended yet for high-stakes production installs.

The setup flow's `migration` step (in `setup/migrate-v1.ts`) already ran a best-effort automated pass. Your job is to finish what it couldn't do automatically, then interview the user about any custom code they had in v1 and help port it forward.

Read [docs/v1-to-v2-changes.md](../../../docs/v1-to-v2-changes.md) before doing anything — it's the vocabulary for where v1 things moved to in v2.

## What the automation did

The setup flow ran these sub-steps (each as its own progression-log entry):

| Sub-step | What it did |
|----------|-------------|
| `migrate-detect` | Found v1 install on disk (scanned `~/nanoclaw`, `~/.nanoclaw`, `~/Code/nanoclaw`, etc., or `$NANOCLAW_V1_PATH`). |
| `migrate-validate` | Checked v1 DB has expected tables + required columns. |
| `migrate-db` | Seeded `agent_groups` + `messaging_groups` + `messaging_group_agents` from `registered_groups`. Mapped `trigger_pattern`/`requires_trigger` → `engage_mode`/`engage_pattern`. Did NOT seed `users`/`user_roles`. |
| `migrate-groups` | Copied v1 `groups/<folder>/` to v2. v1 `CLAUDE.md` → v2 `CLAUDE.local.md`. v1 `container_config` JSON → `.v1-container-config.json` sidecar (don't silent-map to v2's `container.json`). |
| `migrate-env` | Merged v1 `.env` keys into v2 `.env` (never overwrote existing keys). |
| `migrate-channel-auth` | Copied non-env auth state per channel (Baileys keystore, matrix state, etc.) based on `CHANNEL_AUTH_REGISTRY` in `setup/migrate-v1/shared.ts`. |
| `migrate-channels` | Ran `setup/install-<channel>.sh` for each channel detected in `registered_groups`. |
| `migrate-tasks` | Ported active v1 `scheduled_tasks` into each session's `inbound.db` as `kind='task'` rows. Inactive tasks dumped to `inactive-tasks.json` for reference. |

## Artifacts to read first

- `logs/setup-migration/handoff.json` — **start here.** Structured summary of every sub-step: `status`, `fields`, `notes`, plus detected channels, group selection, and a top-level `followups` list. The top-level `overall_status` tells you at a glance what kind of session this is.
- `logs/setup.log` — the progression log. Each `migrate-*` sub-step has one entry with status, duration, and a pointer to its raw log.
- `logs/setup-steps/NN-migrate-*.log` — raw per-sub-step stdout+stderr. Read these when a step failed or you need to understand why.
- `logs/setup-migration/schema-mismatch.json` — only exists if `migrate-validate` rejected the v1 DB shape. Describes what was missing.
- `logs/setup-migration/inactive-tasks.json` — v1 scheduled tasks we didn't migrate (completed, stopped, or unmappable schedule types).

## Flow

### Phase A — always run: owner seeding + access policy

The automation deliberately did not seed `users`, `user_roles`, or flip `messaging_groups.unknown_sender_policy`. v1 has no ground truth for who the owner is, and no single source for the "anyone can message / only known users" setting. Ask the user.

1. Read `handoff.json` → `detected_channels` to know which channel(s) to address the user on.
2. Use `AskUserQuestion` to ask "Which handle on `<primary channel>` is yours?" with options pulled from context if you have any hints (e.g. recent v1 message senders), plus "Let me type it" and "Use a different channel." Build the user id as `<channel_type>:<handle>`.
3. Insert into v2 central DB (`data/v2.db`):
   - `users(id, kind, display_name, created_at)` — use the channel_type as `kind`.
   - `user_roles(user_id, role='owner', agent_group_id=NULL, granted_by=NULL, granted_at=now)`.
4. Ask "In v1, could anyone message your assistant, or only known users?" via `AskUserQuestion`:
   - "Anyone could message it" → update every row in `messaging_groups` (for migrated channel_types) to `unknown_sender_policy='public'`.
   - "Only known users" → leave `unknown_sender_policy='strict'`; walk the user through seeding `agent_group_members` rows for each trusted handle they name.

Use the DB helpers in `src/db/agent-groups.ts`, `src/db/messaging-groups.ts`, and `src/db/user-roles.ts` rather than hand-rolling SQL — they keep the companion `agent_destinations` and indexes correct. Always init the central DB first:

```ts
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { DATA_DIR } from '../src/config.js';
import path from 'path';
const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);
```

### Phase B — branch on `handoff.json: overall_status`

**If `overall_status === 'success'`** and `followups` is empty: go straight to Phase C (customization interview).

**Otherwise (partial, failed, or non-empty followups)**: walk `handoff.steps` and `handoff.followups` top-to-bottom. For each entry:

- Read the step's `fields` and `notes` and its raw log (`logs/setup-steps/NN-<step>.log`).
- Explain the situation to the user in one sentence, then propose a fix.
- Do the fix yourself when it's mechanical (re-running an install script, seeding a missed `agent_destinations` row, re-copying a channel's auth files, manually translating an unsupported `schedule_type`). Use `AskUserQuestion` when a judgment call is needed (is this orphan channel worth keeping? is this v1 container_config still relevant?).

Common cases:

- **`migrate-validate` status=failed**: the v1 DB had an unexpected shape. Read `schema-mismatch.json`. If tables are missing, the user may have run a very old or customized v1 — ask before trying to salvage. If only columns are missing, you can often proceed by hand-writing the SELECT with the columns that exist.
- **`migrate-db` status=partial, SKIPPED>0**: some `registered_groups` rows didn't seed. The `notes` field of the step entry names each failed folder. Most commonly: a JID we couldn't parse. Ask the user whether to manually wire each.
- **`migrate-channels` status=partial, some entries `not_supported`**: v1 had channels v2 doesn't ship a skill for yet. Ask the user whether to keep the `messaging_groups` rows (they'll stay orphaned until v2 grows the adapter) or delete them.
- **`migrate-channel-auth` has `files_missing`**: for WhatsApp specifically, encryption sessions often can't survive the copy — tell the user a fresh pair may be needed via `/add-whatsapp`.
- **Per-folder `.v1-container-config.json` sidecars exist**: read each, discuss with the user, and translate to v2's `groups/<folder>/container.json` format.

### Phase C — customizations (fork-aware)

NanoClaw recommends running on a fork, so most real v1 installs have at least some customizations.

**Start with divergence detection.** In the v1 repo at `handoff.v1_path`:

```bash
cd <v1_path>
git remote -v                           # identify the upstream remote
git log --oneline <upstream>/main..HEAD # commits ahead of upstream
```

If the log is **empty**: stock v1. Tell the user "no customizations to port" and skip the rest of Phase C.

If the log has commits, show them to the user and offer a scope via `AskUserQuestion`:

1. **Mechanical** (recommended) — copy the portable categories (skills, docs), stash the rest as reference.
2. **Full interview** — walk each commit with me, decide one-by-one. Use `Explore` sub-agents for diffs > 10 files.
3. **Reference only** — stash everything to `docs/v1-fork-reference/`, copy nothing now.

**Portability rules of thumb:**
- **Portable**: `container/skills/*`, `.claude/skills/*`, `docs/*`, top-level config. Scan each with `scanForV1Patterns` (in `setup/migrate-v1/shared.ts`) before copying — clean ones land as-is, dirty ones get a followup.
- **Not portable**: `src/*` (host) and `container/agent-runner/src/*` (agent-runner). v2's architecture is fundamentally different (Node host with split session DBs vs v1's single process + IPC file queue). Stash to `docs/v1-fork-reference/` with a README explaining the v1→v2 mapping — **don't translate**. Mechanical translation is a trap; let the user rebuild the feature on v2 primitives.
- **Already handled**: `groups/*` — `migrate-groups` copied these and flagged v1 patterns. Don't redo in Phase C.
- **Case by case**: `package.json` deps — check whether v2 already has each; never add to v2's lockfile without approval (supply-chain `minimumReleaseAge` applies).

When stashing, write `docs/v1-fork-reference/README.md` with commits list, stashed source files, and the suggested porting plan.

## Principles

- **Never silently copy code.** Read, explain, propose, apply. Show diffs before applying when non-trivial.
- **Credentials are masked when displayed** (first 4 + `...` + last 4 characters). The handoff file doesn't contain values; keep it that way.
- **The v1 checkout is read-only.** We never delete or modify `~/nanoclaw`. If the user wants to retire it later, that's a separate conversation.
- **No migration re-runs.** The `migrate-*` sub-steps are idempotent, but re-running them from inside this skill is almost always the wrong move — finish by hand. Re-running is for when the user re-runs `bash nanoclaw.sh`.
- **`handoff.json` is source of truth across context compactions.** If the conversation gets compacted mid-work, re-read it and `git status` to recover state. Do not maintain a separate state file.

## When you're done

- Delete `logs/setup-migration/handoff.json` once every followup is cleared and the user confirms. The file is a working document, not a record — if the user wants a record, offer to move it to `docs/migration-<date>.md` before deleting.
- Tell the user: if the service is running (check `launchctl list | grep nanoclaw` on macOS or `systemctl --user status nanoclaw*` on Linux), restart it so the seeded `users` / `user_roles` / any channel installs take effect.
