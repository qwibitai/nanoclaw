# NanoClaw Skills Architecture

## Core Principle

Skills are self-contained, auditable packages that apply programmatically via standard git merge mechanics. Claude Code orchestrates the process — running git commands, reading skill manifests, and stepping in only when git can't resolve a conflict on its own. The system uses existing git features (`merge-file`, `rerere`, `apply`) rather than custom merge infrastructure.

### The Three-Level Resolution Model

Every operation in the system follows this escalation:

1. **Git** — deterministic, programmatic. `git merge-file` merges, `git rerere` replays cached resolutions, structured operations apply without merging. No AI involved. This handles the vast majority of cases.
2. **Claude Code** — reads `SKILL.md`, `.intent.md`, migration guides, and `state.yaml` to understand context. Resolves conflicts that git can't handle programmatically. Caches the resolution via `git rerere` so it never needs to resolve the same conflict again.
3. **User** — Claude Code asks the user when it lacks context or intent. This happens when two features genuinely conflict at an application level (not just a text-level merge conflict) and a human decision is needed about desired behavior.

The goal is that Level 1 handles everything on a mature, well-tested installation. Level 2 handles first-time conflicts and edge cases. Level 3 is rare and only for genuine ambiguity.

**Important**: a clean merge (exit code 0) does not guarantee working code. Semantic conflicts — a renamed variable, a shifted reference, a changed function signature — can produce clean text merges that break at runtime. **Tests must run after every operation**, regardless of whether the merge was clean. A clean merge with failing tests escalates to Level 2.

### Safe Operations via Backup/Restore

Many users clone the repo without forking, don't commit their changes, and don't think of themselves as git users. The system must work safely for them without requiring any git knowledge.

Before any operation, the system copies all files that will be modified to `.nanoclaw/backup/`. On success, the backup is deleted. On failure, the backup is restored. This provides rollback safety regardless of whether the user commits, pushes, or understands git.

---

## 1. The Shared Base

`.nanoclaw/base/` holds the clean core — the original codebase before any skills or customizations were applied. This is the stable common ancestor for all three-way merges, and it only changes on core updates.

- `git merge-file` uses the base to compute two diffs: what the user changed (current vs base) and what the skill wants to change (base vs skill's modified file), then combines both
- The base enables drift detection: if a file's hash differs from its base hash, something has been modified (skills, user customizations, or both)
- Each skill's `modify/` files contain the full file as it should look with that skill applied (including any prerequisite skill changes), all authored against the same clean core base

On a **fresh codebase**, the user's files are identical to the base. This means `git merge-file` always exits cleanly for the first skill — the merge trivially produces the skill's modified version. No special-casing needed.

When multiple skills modify the same file, the three-way merge handles the overlap naturally. If Telegram and Discord both modify `src/index.ts`, and both skill files include the Telegram changes, those common changes merge cleanly against the base. The result is the base + all skill changes + user customizations.

---

## 2. Two Types of Changes: Code Merges vs. Structured Operations

Not all files should be merged as text. The system distinguishes between **code files** (merged via `git merge-file`) and **structured data** (modified via deterministic operations).

### Code Files (Three-Way Merge)

Source code files where skills weave in logic — route handlers, middleware, business logic. These are merged using `git merge-file` against the shared base. The skill carries a full modified version of the file.

### Structured Data (Deterministic Operations)

Files like `package.json`, `docker-compose.yml`, `.env.example`, and generated configs are not code you merge — they're structured data you aggregate. Multiple skills adding npm dependencies to `package.json` shouldn't require a three-way text merge. Instead, skills declare their structured requirements in the manifest, and the system applies them programmatically.

**Structured operations are implicit.** If a skill declares `npm_dependencies`, the system handles dependency installation automatically. There is no need for the skill author to add `npm install` to `post_apply`. When multiple skills are applied in sequence, the system batches structured operations: merge all dependency declarations first, write `package.json` once, run `npm install` once at the end.

```yaml
# In manifest.yaml
structured:
  npm_dependencies:
    whatsapp-web.js: "^2.1.0"
    qrcode-terminal: "^0.12.0"
  env_additions:
    - WHATSAPP_TOKEN
    - WHATSAPP_VERIFY_TOKEN
    - WHATSAPP_PHONE_ID
  docker_compose_services:
    whatsapp-redis:
      image: redis:alpine
      ports: ["6380:6379"]
```

### Structured Operation Conflicts

Structured operations eliminate text merge conflicts but can still conflict at a semantic level:

- **NPM version conflicts**: two skills request incompatible semver ranges for the same package
- **Port collisions**: two docker-compose services claim the same host port
- **Service name collisions**: two skills define a service with the same name
- **Env var duplicates**: two skills declare the same variable with different expectations

The resolution policy:

1. **Automatic where possible**: widen semver ranges to find a compatible version, detect and flag port/name collisions
2. **Level 2 (Claude Code)**: if automatic resolution fails, Claude proposes options based on skill intents
3. **Level 3 (User)**: if it's a genuine product choice (which Redis instance should get port 6379?), ask the user

Structured operation conflicts are included in the CI overlap graph alongside code file overlaps, so the maintainer test matrix catches these before users encounter them.

### State Records Structured Outcomes

`state.yaml` records not just the declared dependencies but the resolved outcomes — actual installed versions, resolved port assignments, final env var list. This makes structured operations replayable and auditable.

### Deterministic Serialization

All structured output (YAML, JSON) uses stable serialization: sorted keys, consistent quoting, normalized whitespace. This prevents noisy diffs in git history from non-functional formatting changes.

---

## 3. Skill Package Structure

A skill contains only the files it adds or modifies. For modified code files, the skill carries the **full modified file** (the clean core with the skill's changes applied).

```
skills/
  add-whatsapp/
    SKILL.md                          # Context, intent, what this skill does and why
    manifest.yaml                     # Metadata, dependencies, env vars, post-apply steps
    tests/                            # Integration tests for this skill
      whatsapp.test.ts
    add/                              # New files — copied directly
      src/channels/whatsapp.ts
      src/channels/whatsapp.config.ts
    modify/                           # Modified code files — merged via git merge-file
      src/
        server.ts                     # Full file: clean core + whatsapp changes
        server.ts.intent.md           # "Adds WhatsApp webhook route and message handler"
        config.ts                     # Full file: clean core + whatsapp config options
        config.ts.intent.md           # "Adds WhatsApp channel configuration block"
```

### Why Full Modified Files

- `git merge-file` requires three full files — no intermediate reconstruction step
- Git's three-way merge uses context matching, so it works even if the user has moved code around — unlike line-number-based diffs that break immediately
- Auditable: `diff .nanoclaw/base/src/server.ts skills/add-whatsapp/modify/src/server.ts` shows exactly what the skill changes
- Deterministic: same three inputs always produce the same merge result
- Size is negligible since NanoClaw's core files are small

### Intent Files

Each modified code file has a corresponding `.intent.md` with structured headings:

```markdown
# Intent: server.ts modifications

## What this skill adds
Adds WhatsApp webhook route and message handler to the Express server.

## Key sections
- Route registration at `/webhook/whatsapp` (POST and GET for verification)
- Message handler middleware between auth and response pipeline

## Invariants
- Must not interfere with other channel webhook routes
- Auth middleware must run before the WhatsApp handler
- Error handling must propagate to the global error handler

## Must-keep sections
- The webhook verification flow (GET route) is required by WhatsApp Cloud API
```

Structured headings (What, Key sections, Invariants, Must-keep) give Claude Code specific guidance during conflict resolution instead of requiring it to infer from unstructured text.

### Manifest Format

```yaml
# --- Required fields ---
skill: whatsapp
version: 1.2.0
description: "WhatsApp Business API integration via Cloud API"
core_version: 0.1.0               # The core version this skill was authored against

# Files this skill adds
adds:
  - src/channels/whatsapp.ts
  - src/channels/whatsapp.config.ts

# Code files this skill modifies (three-way merge)
modifies:
  - src/server.ts
  - src/config.ts

# File operations (renames, deletes, moves — see Section 5)
file_ops: []

# Structured operations (deterministic, no merge — implicit handling)
structured:
  npm_dependencies:
    whatsapp-web.js: "^2.1.0"
    qrcode-terminal: "^0.12.0"
  env_additions:
    - WHATSAPP_TOKEN
    - WHATSAPP_VERIFY_TOKEN
    - WHATSAPP_PHONE_ID

# Skill relationships
conflicts: []              # Skills that cannot coexist without agent resolution
depends: []                # Skills that must be applied first

# Test command — runs after apply to validate the skill works
test: "npx vitest run src/channels/whatsapp.test.ts"

# --- Future fields (not yet implemented in v0.1) ---
# author: nanoclaw-team
# license: MIT
# min_skills_system_version: "0.1.0"
# tested_with: [telegram@1.0.0]
# post_apply: []
```

Note: `post_apply` is only for operations that can't be expressed as structured declarations. Dependency installation is **never** in `post_apply` — it's handled implicitly by the structured operations system.

---

## 4. Skills, Customization, and Layering

### One Skill, One Happy Path

A skill implements **one way of doing something — the reasonable default that covers 80% of users.** `add-telegram` gives you a clean, solid Telegram integration. It doesn't try to anticipate every use case with predefined configuration options and modes.

### Customization Is Just More Patching

The entire system is built around applying transformations to a codebase. Customizing a skill after applying it is no different from any other modification:

- **Apply the skill** — get the standard Telegram integration
- **Modify from there** — using the customize flow (tracked patch), direct editing (detected by hash tracking), or by applying additional skills that build on top

### Layered Skills

Skills can build on other skills:

```
add-telegram                    # Core Telegram integration (happy path)
  ├── telegram-reactions        # Adds reaction handling (depends: [telegram])
  ├── telegram-multi-bot        # Multiple bot instances (depends: [telegram])
  └── telegram-filters          # Custom message filtering (depends: [telegram])
```

Each layer is a separate skill with its own `SKILL.md`, manifest (with `depends: [telegram]`), tests, and modified files. The user composes exactly what they want by stacking skills.

### Custom Skill Application

A user can apply a skill with their own modifications in a single step:

1. Apply the skill normally (programmatic merge)
2. Claude Code asks if the user wants to make any modifications
3. User describes what they want different
4. Claude Code makes the modifications on top of the freshly applied skill
5. The modifications are recorded as a custom patch tied to this skill

Recorded in `state.yaml`:

```yaml
applied_skills:
  - skill: telegram
    version: 1.0.0
    custom_patch: .nanoclaw/custom/telegram-group-only.patch
    custom_patch_description: "Restrict bot responses to group chats only"
```

On replay, the skill applies programmatically, then the custom patch applies on top.

---

## 5. File Operations: Renames, Deletes, Moves

Core updates and some skills will need to rename, delete, or move files. These are not text merges — they're structural changes handled as explicit scripted operations.

### Declaration in Manifest

```yaml
file_ops:
  - type: rename
    from: src/server.ts
    to: src/app.ts
  - type: delete
    path: src/deprecated/old-handler.ts
  - type: move
    from: src/utils/helpers.ts
    to: src/lib/helpers.ts
```

### Execution Order

File operations run **before** code merges, because merges need to target the correct file paths:

1. Pre-flight checks (state validation, core version, dependencies, conflicts, drift detection)
2. Acquire operation lock
3. **Backup** all files that will be touched
4. **File operations** (renames, deletes, moves)
5. Copy new files from `add/`
6. Three-way merge modified code files
7. Conflict resolution (rerere auto-resolve, or return with `backupPending: true`)
8. Apply structured operations (npm deps, env vars, docker-compose — batched)
9. Run `npm install` (once, if any structured npm_dependencies exist)
10. Update state (record skill application, file hashes, structured outcomes)
11. Run tests (if `manifest.test` defined; rollback state + backup on failure)
12. Clean up (delete backup on success, release lock)

### Path Remapping for Skills

When the core renames a file (e.g., `server.ts` → `app.ts`), skills authored against the old path still reference `server.ts` in their `modifies` and `modify/` directories. **Skill packages are never mutated on the user's machine.**

Instead, core updates ship a **compatibility map**:

```yaml
# In the update package
path_remap:
  src/server.ts: src/app.ts
  src/old-config.ts: src/config/main.ts
```

The system resolves paths at apply time: if a skill targets `src/server.ts` and the remap says it's now `src/app.ts`, the merge runs against `src/app.ts`. The remap is recorded in `state.yaml` so future operations are consistent.

### Safety Checks

Before executing file operations:

- Verify the source file exists
- For deletes: warn if the file has modifications beyond the base (user or skill changes would be lost)

---

## 6. The Apply Flow

When a user runs the skill's slash command in Claude Code:

### Step 1: Pre-flight Checks

- Core version compatibility
- Dependencies satisfied
- No unresolvable conflicts with applied skills
- Check for untracked changes (see Section 9)

### Step 2: Backup

Copy all files that will be modified to `.nanoclaw/backup/`. If the operation fails at any point, restore from backup.

### Step 3: File Operations

Execute renames, deletes, or moves with safety checks. Apply path remapping if needed.

### Step 4: Apply New Files

```bash
cp skills/add-whatsapp/add/src/channels/whatsapp.ts src/channels/whatsapp.ts
```

### Step 5: Merge Modified Code Files

For each file in `modifies` (with path remapping applied):

```bash
git merge-file src/server.ts .nanoclaw/base/src/server.ts skills/add-whatsapp/modify/src/server.ts
```

- **Exit code 0**: clean merge, move on
- **Exit code > 0**: conflict markers in file, proceed to resolution

### Step 6: Conflict Resolution (Three-Level)

1. **Check shared resolution cache** (`.nanoclaw/resolutions/`) — load into local `git rerere` if a verified resolution exists for this skill combination. **Only apply if input hashes match exactly** (base hash + current hash + skill modified hash).
2. **`git rerere`** — checks local cache. If found, applied automatically. Done.
3. **Claude Code** — reads conflict markers + `SKILL.md` + `.intent.md` (Invariants, Must-keep sections) of current and previously applied skills. Resolves. `git rerere` caches the resolution.
4. **User** — if Claude Code cannot determine intent, it asks the user for the desired behavior.

### Step 7: Apply Structured Operations

Collect all structured declarations (from this skill and any previously applied skills if batching). Apply deterministically:

- Merge npm dependencies into `package.json` (check for version conflicts)
- Append env vars to `.env.example`
- Merge docker-compose services (check for port/name collisions)
- Run `npm install` **once** at the end
- Record resolved outcomes in state

### Step 8: Post-Apply and Validate

1. Run any `post_apply` commands (non-structured operations only)
2. Update `.nanoclaw/state.yaml` — skill record, file hashes (base, skill, merged per file), structured outcomes
3. **Run skill tests** — mandatory, even if all merges were clean
4. If tests fail on a clean merge → escalate to Level 2 (Claude Code diagnoses the semantic conflict)

### Step 9: Clean Up

If tests pass, delete `.nanoclaw/backup/`. The operation is complete.

If tests fail and Level 2 can't resolve, restore from `.nanoclaw/backup/` and report the failure.

---

## 7. Shared Resolution Cache

### The Problem

`git rerere` is local by default. But NanoClaw has thousands of users applying the same skill combinations. Every user hitting the same conflict and waiting for Claude Code to resolve it is wasteful.

### The Solution

NanoClaw maintains a verified resolution cache in `.nanoclaw/resolutions/` that ships with the project. This is the shared artifact — **not** `.git/rr-cache/`, which stays local.

```
.nanoclaw/
  resolutions/
    whatsapp@1.2.0+telegram@1.0.0/
      src/
        server.ts.resolution
        server.ts.preimage
        config.ts.resolution
        config.ts.preimage
      meta.yaml
```

### Hash Enforcement

A cached resolution is **only applied if input hashes match exactly**:

```yaml
# meta.yaml
skills:
  - whatsapp@1.2.0
  - telegram@1.0.0
apply_order: [whatsapp, telegram]
core_version: 0.6.0
resolved_at: 2026-02-15T10:00:00Z
tested: true
test_passed: true
resolution_source: maintainer
input_hashes:
  base: "aaa..."
  current_after_whatsapp: "bbb..."
  telegram_modified: "ccc..."
output_hash: "ddd..."
```

If any input hash doesn't match, the cached resolution is skipped and the system proceeds to Level 2.

### Validated: rerere + merge-file Require an Index Adapter

`git rerere` does **not** natively recognize `git merge-file` output. This was validated in Phase 0 testing (`tests/phase0-merge-rerere.sh`, 33 tests).

The issue is not about conflict marker format — `merge-file` uses filenames as labels (`<<<<<<< current.ts`) while `git merge` uses branch names (`<<<<<<< HEAD`), but rerere strips all labels and hashes only the conflict body. The formats are compatible.

The actual issue: **rerere requires unmerged index entries** (stages 1/2/3) to detect that a merge conflict exists. A normal `git merge` creates these automatically. `git merge-file` operates on the filesystem only and does not touch the index.

#### The Adapter

After `git merge-file` produces a conflict, the system must create the index state that rerere expects:

```bash
# 1. Run the merge (produces conflict markers in the working tree)
git merge-file current.ts .nanoclaw/base/src/file.ts skills/add-whatsapp/modify/src/file.ts

# 2. If exit code > 0 (conflict), set up rerere adapter:

# Create blob objects for the three versions
base_hash=$(git hash-object -w .nanoclaw/base/src/file.ts)
ours_hash=$(git hash-object -w skills/previous-skill/modify/src/file.ts)  # or the pre-merge current
theirs_hash=$(git hash-object -w skills/add-whatsapp/modify/src/file.ts)

# Create unmerged index entries at stages 1 (base), 2 (ours), 3 (theirs)
printf '100644 %s 1\tsrc/file.ts\0' "$base_hash" | git update-index --index-info
printf '100644 %s 2\tsrc/file.ts\0' "$ours_hash" | git update-index --index-info
printf '100644 %s 3\tsrc/file.ts\0' "$theirs_hash" | git update-index --index-info

# Set merge state (rerere checks for MERGE_HEAD)
echo "$(git rev-parse HEAD)" > .git/MERGE_HEAD
echo "skill merge" > .git/MERGE_MSG

# 3. Now rerere can see the conflict
git rerere  # Records preimage, or auto-resolves from cache

# 4. After resolution (manual or auto):
git add src/file.ts
git rerere  # Records postimage (caches the resolution)

# 5. Clean up merge state
rm .git/MERGE_HEAD .git/MERGE_MSG
git reset HEAD
```

#### Key Properties Validated

- **Conflict body identity**: `merge-file` and `git merge` produce identical conflict bodies for the same inputs. Rerere hashes the body only, so resolutions learned from either source are interchangeable.
- **Hash determinism**: The same conflict always produces the same rerere hash. This is critical for the shared resolution cache.
- **Resolution portability**: Copying `preimage` and `postimage` files (plus the hash directory name) from one repo's `.git/rr-cache/` to another works. Rerere auto-resolves in the target repo.
- **Adjacent line sensitivity**: Changes within ~3 lines of each other are treated as a single conflict hunk by `merge-file`. Skills that modify the same area of a file will conflict even if they modify different lines. This is expected and handled by the resolution cache.

#### Implication: Git Repository Required

The adapter requires `git hash-object`, `git update-index`, and `.git/rr-cache/`. This means the project directory must be a git repository for rerere caching to work. Users who download a zip (no `.git/`) lose resolution caching but not functionality — conflicts escalate directly to Level 2 (Claude Code resolves). The system should detect this case and skip rerere operations gracefully.

### Maintainer Workflow

When releasing a core update or new skill version:

1. Fresh codebase at target core version
2. Apply each official skill individually — verify clean merge, run tests
3. Apply pairwise combinations **for skills that modify at least one common file or have overlapping structured operations**
4. Apply curated three-skill stacks based on popularity and high overlap
5. Resolve all conflicts (code and structured)
6. Record all resolutions with input hashes
7. Run full test suite for every combination
8. Ship verified resolutions with the release

The bar: **a user with any common combination of official skills should never encounter an unresolved conflict.**

---

## 8. State Tracking

`.nanoclaw/state.yaml` records everything about the installation:

```yaml
skills_system_version: "0.1.0"     # Schema version — tooling checks this before any operation
core_version: 0.1.0

applied_skills:
  - name: telegram
    version: 1.0.0
    applied_at: 2026-02-16T22:47:02.139Z
    file_hashes:
      src/channels/telegram.ts: "f627b9cf..."
      src/channels/telegram.test.ts: "400116769..."
      src/config.ts: "9ae28d1f..."
      src/index.ts: "46dbe495..."
      src/routing.test.ts: "5e1aede9..."
    structured_outcomes:
      npm_dependencies:
        grammy: "^1.39.3"
      env_additions:
        - TELEGRAM_BOT_TOKEN
        - TELEGRAM_ONLY
      test: "npx vitest run src/channels/telegram.test.ts"

  - name: discord
    version: 1.0.0
    applied_at: 2026-02-17T17:29:37.821Z
    file_hashes:
      src/channels/discord.ts: "5d669123..."
      src/channels/discord.test.ts: "19e1c6b9..."
      src/config.ts: "a0a32df4..."
      src/index.ts: "d61e3a9d..."
      src/routing.test.ts: "edbacb00..."
    structured_outcomes:
      npm_dependencies:
        discord.js: "^14.18.0"
      env_additions:
        - DISCORD_BOT_TOKEN
        - DISCORD_ONLY
      test: "npx vitest run src/channels/discord.test.ts"

custom_modifications:
  - description: "Added custom logging middleware"
    applied_at: 2026-02-15T12:00:00Z
    files_modified:
      - src/server.ts
    patch_file: .nanoclaw/custom/001-logging-middleware.patch
```

**v0.1 implementation notes:**
- `file_hashes` stores a single SHA-256 hash per file (the final merged result). Three-part hashes (base/skill_modified/merged) are planned for a future version to improve drift diagnosis.
- Applied skills use `name` as the key field (not `skill`), matching the TypeScript `AppliedSkill` interface.
- `structured_outcomes` stores the raw manifest values plus the `test` command. Resolved npm versions (actual installed versions vs semver ranges) are not yet tracked.
- Fields like `installed_at`, `last_updated`, `path_remap`, `rebased_at`, `core_version_at_apply`, `files_added`, and `files_modified` are planned for future versions.

---

## 9. Untracked Changes

If a user edits files directly, the system detects this via hash comparison.

### When Detection Happens

Before **any operation that modifies the codebase**: applying a skill, removing a skill, updating the core, replaying, or rebasing.

### What Happens

```
Detected untracked changes to src/server.ts.
[1] Record these as a custom modification (recommended)
[2] Continue anyway (changes preserved, but not tracked for future replay)
[3] Abort
```

The system never blocks or loses work. Option 1 generates a patch and records it, making changes reproducible. Option 2 preserves the changes but they won't survive replay.

### The Recovery Guarantee

No matter how much a user modifies their codebase outside the system, the three-level model can always bring them back:

1. **Git**: diff current files against base, identify what changed
2. **Claude Code**: read `state.yaml` to understand what skills were applied, compare against actual file state, identify discrepancies
3. **User**: Claude Code asks what they intended, what to keep, what to discard

There is no unrecoverable state.

---

## 10. Core Updates

Core updates must be as programmatic as possible. The NanoClaw team is responsible for ensuring updates apply cleanly to common skill combinations.

### Patches and Migrations

Most core changes — bug fixes, performance improvements, new functionality — propagate automatically through the three-way merge. No special handling needed.

**Breaking changes** — changed defaults, removed features, functionality moved to skills — require a **migration**. A migration is a skill that preserves the old behavior, authored against the new core. It's applied automatically during the update so the user's setup doesn't change.

The maintainer's responsibility when making a breaking change: make the change in core, author a migration skill that reverts it, add the entry to `migrations.yaml`, test it. That's the cost of breaking changes.

### `migrations.yaml`

An append-only file in the repo root. Each entry records a breaking change and the skill that preserves the old behavior:

```yaml
- since: 0.6.0
  skill: apple-containers@1.0.0
  description: "Preserves Apple Containers (default changed to Docker in 0.6)"

- since: 0.7.0
  skill: add-whatsapp@2.0.0
  description: "Preserves WhatsApp (moved from core to skill in 0.7)"

- since: 0.8.0
  skill: legacy-auth@1.0.0
  description: "Preserves legacy auth module (removed from core in 0.8)"
```

Migration skills are regular skills in the `skills/` directory. They have manifests, intent files, tests — everything. They're authored against the **new** core version: the modified file is the new core with the specific breaking change reverted, everything else (bug fixes, new features) identical to the new core.

### How Migrations Work During Updates

1. Three-way merge brings in everything from the new core — patches, breaking changes, all of it
2. Conflict resolution (normal)
3. Re-apply custom patches (normal)
4. **Update base to new core**
5. Filter `migrations.yaml` for entries where `since` > user's old `core_version`
6. **Apply each migration skill using the normal apply flow against the new base**
7. Record migration skills in `state.yaml` like any other skill
8. Run tests

Step 6 is just the same apply function used for any skill. The migration skill merges against the new base:

- **Base**: new core (e.g., v0.8 with Docker)
- **Current**: user's file after the update merge (new core + user's customizations preserved by the earlier merge)
- **Other**: migration skill's file (new core with Docker reverted to Apple, everything else identical)

Three-way merge correctly keeps user's customizations, reverts the breaking change, and preserves all bug fixes. If there's a conflict, normal resolution: cache → Claude → user.

For big version jumps (v0.5 → v0.8), all applicable migrations are applied in sequence. Migration skills are maintained against the latest core version, so they always compose correctly with the current codebase.

### What the User Sees

```
Core updated: 0.5.0 → 0.8.0
  ✓ All patches applied

  Preserving your current setup:
    + apple-containers@1.0.0
    + add-whatsapp@2.0.0
    + legacy-auth@1.0.0

  Skill updates:
    ✓ add-telegram 1.0.0 → 1.2.0

  To accept new defaults: /remove-skill <name>
  ✓ All tests passing
```

No prompts, no choices during the update. The user's setup doesn't change. If they later want to accept a new default, they remove the migration skill.

### What the Core Team Ships With an Update

```
updates/
  0.5.0-to-0.6.0/
    migration.md                  # What changed, why, and how it affects skills
    files/                        # The new core files
    file_ops:                     # Any renames, deletes, moves
    path_remap:                   # Compatibility map for old skill paths
    resolutions/                  # Pre-computed resolutions for official skills
```

Plus any new migration skills added to `skills/` and entries appended to `migrations.yaml`.

### The Maintainer's Process

1. **Make the core change**
2. **If it's a breaking change**: author a migration skill against the new core, add entry to `migrations.yaml`
3. **Write `migration.md`** — what changed, why, what skills might be affected
4. **Test every official skill individually** against the new core (including migration skills)
5. **Test pairwise combinations** for skills that share modified files or structured operations
6. **Test curated three-skill stacks** based on popularity and overlap
7. **Resolve all conflicts**
8. **Record all resolutions** with enforced input hashes
9. **Run full test suites**
10. **Ship everything** — migration guide, migration skills, file ops, path remap, resolutions

The bar: **patches apply silently. Breaking changes are auto-preserved via migration skills. A user should never be surprised by a change to their working setup.**

### Update Flow (Full)

#### Step 1: Pre-flight

- Check for untracked changes
- Read `state.yaml`
- Load shipped resolutions
- Parse `migrations.yaml`, filter for applicable migrations

#### Step 2: Preview

Before modifying anything, show the user what's coming. This uses only git commands — no files are opened or changed:

```bash
# Compute common base
BASE=$(git merge-base HEAD upstream/$BRANCH)

# Upstream commits since last sync
git log --oneline $BASE..upstream/$BRANCH

# Files changed upstream
git diff --name-only $BASE..upstream/$BRANCH
```

Present a summary grouped by impact:

```
Update available: 0.5.0 → 0.8.0 (12 commits)

  Source:  4 files modified (server.ts, config.ts, ...)
  Skills:  2 new skills added, 1 skill updated
  Config:  package.json, docker-compose.yml updated

  Migrations (auto-applied to preserve your setup):
    + apple-containers@1.0.0 (container default changed to Docker)
    + add-whatsapp@2.0.0 (WhatsApp moved from core to skill)

  Skill updates:
    add-telegram 1.0.0 → 1.2.0

  [1] Proceed with update
  [2] Abort
```

If the user aborts, stop here. Nothing was modified.

#### Step 3: Backup

Copy all files that will be modified to `.nanoclaw/backup/`.

#### Step 4: File Operations and Path Remap

Apply renames, deletes, moves. Record path remap in state.

#### Step 5: Three-Way Merge

For each core file that changed:

```bash
git merge-file src/server.ts .nanoclaw/base/src/server.ts updates/0.5.0-to-0.6.0/files/src/server.ts
```

#### Step 6: Conflict Resolution

1. Shipped resolutions (hash-verified) → automatic
2. `git rerere` local cache → automatic
3. Claude Code with `migration.md` + skill intents → resolves
4. User → only for genuine ambiguity

#### Step 7: Re-apply Custom Patches

```bash
git apply --3way .nanoclaw/custom/001-logging-middleware.patch
```

Using `--3way` allows git to fall back to three-way merge when line numbers have drifted. If `--3way` fails, escalate to Level 2.

#### Step 8: Update Base

`.nanoclaw/base/` replaced with new clean core. This is the **only time** the base changes.

#### Step 9: Apply Migration Skills

For each applicable migration (where `since` > old `core_version`), apply the migration skill using the normal apply flow against the new base. Record in `state.yaml`.

#### Step 10: Re-apply Updated Skills

Skills live in the repo and update alongside core files. After the update, compare the version in each skill's `manifest.yaml` on disk against the version recorded in `state.yaml`.

For each skill where the on-disk version is newer than the recorded version:

1. Re-apply the skill using the normal apply flow against the new base
2. The three-way merge brings in the skill's new changes while preserving user customizations
3. Re-apply any custom patches tied to the skill (`git apply --3way`)
4. Update the version in `state.yaml`

Skills whose version hasn't changed are skipped — no action needed.

If the user has a custom patch on a skill that changed significantly, the patch may conflict. Normal resolution: cache → Claude → user.

#### Step 11: Re-run Structured Operations

Recompute structured operations against the updated codebase to ensure consistency.

#### Step 12: Validate

- Run all skill tests — mandatory
- Compatibility report:

```
Core updated: 0.5.0 → 0.8.0
  ✓ All patches applied

  Migrations:
    + apple-containers@1.0.0 (preserves container runtime)
    + add-whatsapp@2.0.0 (WhatsApp moved to skill)

  Skill updates:
    ✓ add-telegram 1.0.0 → 1.2.0 (new features applied)
    ✓ custom/telegram-group-only — re-applied cleanly

  ✓ All tests passing
```

#### Step 13: Clean Up

Delete `.nanoclaw/backup/`.

### Progressive Core Slimming

Migrations enable a clean path for slimming down the core over time. Each release can move more functionality to skills:

- The breaking change removes the feature from core
- The migration skill preserves it for existing users
- New users start with a minimal core and add what they need
- Over time, `state.yaml` reflects exactly what each user is running

---

## 11. Skill Removal (Uninstall)

Removing a skill is not a reverse-patch operation. **Uninstall is a replay without the skill.**

### How It Works

1. Read `state.yaml` to get the full list of applied skills and custom modifications
2. Remove the target skill from the list
3. Backup the current codebase to `.nanoclaw/backup/`
4. **Replay from clean base** — apply each remaining skill in order, apply custom patches, using the resolution cache
5. Run all tests
6. If tests pass, delete backup and update `state.yaml`
7. If tests fail, restore from backup and report

### Custom Patches Tied to the Removed Skill

If the removed skill has a `custom_patch` in `state.yaml`, the user is warned:

```
Removing telegram will also discard custom patch: "Restrict bot responses to group chats only"
[1] Continue (discard custom patch)
[2] Abort
```

---

## 12. Rebase

Flatten accumulated layers into a clean starting point.

### What Rebase Does

1. Takes the user's current actual files as the new reality
2. Updates `.nanoclaw/base/` to the current core version's clean files
3. For each applied skill, regenerates the modified file diffs against the new base
4. Updates `state.yaml` with `rebased_at` timestamp
5. Clears old custom patches (now baked in)
6. Clears stale resolution cache entries

### When to Rebase

- After a major core update
- When accumulated patches become unwieldy
- Before a significant new skill application
- Periodically as maintenance

### Tradeoffs

**Lose**: individual skill patch history, ability to cleanly remove a single old skill, old custom patches as separate artifacts

**Gain**: clean base, simpler future merges, reduced cache size, fresh starting point

---

## 13. Replay

Given `state.yaml`, reproduce the exact installation on a fresh machine with no AI intervention (assuming all resolutions are cached).

### Replay Flow

```bash
# Fully programmatic — no Claude Code needed

# 1. Install core at specified version
nanoclaw-init --version 0.5.0

# 2. Load shared resolutions into local rerere cache
load-resolutions .nanoclaw/resolutions/

# 3. For each skill in applied_skills (in order):
for skill in state.applied_skills:
  # File operations
  apply_file_ops(skill)

  # Copy new files
  cp skills/${skill.name}/add/* .

  # Merge modified code files (with path remapping)
  for file in skill.files_modified:
    resolved_path = apply_remap(file, state.path_remap)
    git merge-file ${resolved_path} .nanoclaw/base/${resolved_path} skills/${skill.name}/modify/${file}
    # git rerere auto-resolves from shared cache if needed

  # Apply skill-specific custom patch if recorded
  if skill.custom_patch:
    git apply --3way ${skill.custom_patch}

# 4. Apply all structured operations (batched)
collect_all_structured_ops(state.applied_skills)
merge_npm_dependencies → write package.json once
npm install once
merge_env_additions → write .env.example once
merge_compose_services → write docker-compose.yml once

# 5. Apply standalone custom modifications
for custom in state.custom_modifications:
  git apply --3way ${custom.patch_file}

# 6. Run tests and verify hashes
run_tests && verify_hashes
```

---

## 14. Skill Tests

Each skill includes integration tests that validate the skill works correctly when applied.

### Structure

```
skills/
  add-whatsapp/
    tests/
      whatsapp.test.ts
```

### What Tests Validate

- **Single skill on fresh core**: apply to clean codebase → tests pass → integration works
- **Skill functionality**: the feature actually works
- **Post-apply state**: files in expected state, `state.yaml` correctly updated

### When Tests Run (Always)

- **After applying a skill** — even if all merges were clean
- **After core update** — even if all merges were clean
- **After uninstall replay** — confirms removal didn't break remaining skills
- **In CI** — tests all official skills individually and in common combinations
- **During replay** — validates replayed state

Clean merge ≠ working code. Tests are the only reliable signal.

### CI Test Matrix

Test coverage is **smart, not exhaustive**:

- Every official skill individually against each supported core version
- **Pairwise combinations for skills that modify at least one common file or have overlapping structured operations**
- Curated three-skill stacks based on popularity and high overlap
- Test matrix auto-generated from manifest `modifies` and `structured` fields

Each passing combination generates a verified resolution entry for the shared cache.

---

## 15. Project Configuration

### `.gitattributes`

Ship with NanoClaw to reduce noisy merge conflicts:

```
* text=auto
*.ts text eol=lf
*.json text eol=lf
*.yaml text eol=lf
*.md text eol=lf
```

---

## 16. Directory Structure

```
project/
  src/                              # The actual codebase
    server.ts
    config.ts
    channels/
      whatsapp.ts
      telegram.ts
  skills/                           # Skill packages (Claude Code slash commands)
    add-whatsapp/
      SKILL.md
      manifest.yaml
      tests/
        whatsapp.test.ts
      add/
        src/channels/whatsapp.ts
      modify/
        src/
          server.ts
          server.ts.intent.md
          config.ts
          config.ts.intent.md
    add-telegram/
      ...
    telegram-reactions/             # Layered skill
      ...
  .nanoclaw/
    base/                           # Clean core (shared base)
      src/
        server.ts
        config.ts
        ...
    state.yaml                      # Full installation state
    backup/                         # Temporary backup during operations
    custom/                         # Custom patches
      telegram-group-only.patch
      001-logging-middleware.patch
      001-logging-middleware.md
    resolutions/                    # Shared verified resolution cache
      whatsapp@1.2.0+telegram@1.0.0/
        src/
          server.ts.resolution
          server.ts.preimage
        meta.yaml
  .gitattributes
```

---

## 17. Design Principles

1. **Use git, don't reinvent it.** `git merge-file` for code merges, `git rerere` for caching resolutions, `git apply --3way` for custom patches.
2. **Three-level resolution: git → Claude → user.** Programmatic first, AI second, human third.
3. **Clean merges aren't enough.** Tests run after every operation. Semantic conflicts survive text merges.
4. **All operations are safe.** Backup before, restore on failure. No half-applied state.
5. **One shared base.** `.nanoclaw/base/` is the clean core before any skills or customizations. It's the stable common ancestor for all three-way merges. Only updated on core updates.
6. **Code merges vs. structured operations.** Source code is three-way merged. Dependencies, env vars, and configs are aggregated programmatically. Structured operations are implicit and batched.
7. **Resolutions are learned and shared.** Maintainers resolve conflicts and ship verified resolutions with hash enforcement. `.nanoclaw/resolutions/` is the shared artifact.
8. **One skill, one happy path.** No predefined configuration options. Customization is more patching.
9. **Skills layer and compose.** Core skills provide the foundation. Extension skills add capabilities.
10. **Intent is first-class and structured.** `SKILL.md`, `.intent.md` (What, Invariants, Must-keep), and `migration.md`.
11. **State is explicit and complete.** Skills, custom patches, per-file hashes, structured outcomes, path remaps. Replay is deterministic. Drift is instant to detect.
12. **Always recoverable.** The three-level model reconstructs coherent state from any starting point.
13. **Uninstall is replay.** Replay from clean base without the skill. Backup for safety.
14. **Core updates are the maintainers' responsibility.** Test, resolve, ship. Breaking changes require a migration skill that preserves the old behavior. The cost of a breaking change is authoring and testing the migration. Users should never be surprised by a change to their setup.
15. **File operations and path remapping are first-class.** Renames, deletes, moves in manifests. Skills are never mutated — paths resolve at apply time.
16. **Skills are tested.** Integration tests per skill. CI tests pairwise by overlap. Tests run always.
17. **Deterministic serialization.** Sorted keys, consistent formatting. No noisy diffs.
18. **Rebase when needed.** Flatten layers for a clean starting point.
19. **Progressive core slimming.** Breaking changes move functionality from core to migration skills. Existing users keep what they have automatically. New users start minimal and add what they need.