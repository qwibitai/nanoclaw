# NanoClaw Skills Architecture

## What Skills Are For

NanoClaw's core is intentionally minimal. Skills are how users extend it: adding channels, integrations, cross-platform support, or replacing internals entirely. Examples: add Telegram alongside WhatsApp, switch from Apple Container to Docker, add Gmail integration, add voice message transcription. Each skill modifies the actual codebase, adding channel handlers, updating the message router, changing container configuration, and adding dependencies, rather than working through a plugin API or runtime hooks.

## Why This Architecture

The problem: users need to combine multiple modifications to a shared codebase, keep those modifications working across core updates, and do all of this without becoming git experts or losing their custom changes. A plugin system would be simpler but constrains what skills can do. Giving skills full codebase access means they can change anything, but that creates merge conflicts, update breakage, and state tracking challenges.

This architecture solves that by making skill application fully programmatic using standard git mechanics, with AI as a fallback for conflicts git can't resolve, and a shared resolution cache so most users never hit those conflicts at all. The result: users compose exactly the features they want, customizations survive core updates automatically, and the system is always recoverable.

## Core Principle

Skills are self-contained, auditable packages applied via standard git merge mechanics. Claude Code orchestrates the process — running git commands, reading skill manifests, and stepping in only when git can't resolve a conflict. The system uses existing git features (`merge-file`, `rerere`, `apply`) rather than custom merge infrastructure.

## Three-Level Resolution Model

Every operation follows this escalation:

1. **Git** — deterministic. `git merge-file` merges, `git rerere` replays cached resolutions, structured operations apply without merging. No AI. Handles the vast majority of cases.
2. **Claude Code** — reads `SKILL.md`, `.intent.md`, and `state.yaml` to resolve conflicts git can't handle. Caches resolutions via `git rerere` so the same conflict never needs resolving twice.
3. **Claude Code + user input** — when Claude Code lacks sufficient context to determine intent (e.g., two features genuinely conflict at an application level), it asks the user for a decision, then uses that input to perform the resolution. Claude Code still does the work — the user provides direction, not code.

**Important**: A clean merge doesn't guarantee working code. Semantic conflicts can produce clean text merges that break at runtime. **Tests run after every operation.**

## Backup/Restore Safety

Before any operation, all affected files are copied to `.nanoclaw/backup/`. On success, backup is deleted. On failure, backup is restored. Works safely for users who don't use git.

## The Shared Base

`.nanoclaw/base/` holds a clean copy of the core codebase. This is the single common ancestor for all three-way merges, only updated during core updates.

## Two Types of Changes

### Code Files (Three-Way Merge)
Source code where skills weave in logic. Merged via `git merge-file` against the shared base. Skills carry full modified files.

### Structured Data (Deterministic Operations)
Files like `package.json`, `docker-compose.yml`, `.env.example`. Skills declare requirements in the manifest; the system applies them programmatically. Multiple skills' declarations are batched — dependencies merged, `package.json` written once, `npm install` run once.

```yaml
structured:
  npm_dependencies:
    whatsapp-web.js: "^2.1.0"
  env_additions:
    - WHATSAPP_TOKEN
  docker_compose_services:
    whatsapp-redis:
      image: redis:alpine
      ports: ["6380:6379"]
```

Structured conflicts (version incompatibilities, port collisions) follow the same three-level resolution model.

## Skill Package Structure

A skill contains only the files it adds or modifies. Modified code files carry the **full file** (clean core + skill's changes), making `git merge-file` straightforward and auditable.

```
skills/add-whatsapp/
  SKILL.md                    # What this skill does and why
  manifest.yaml               # Metadata, dependencies, structured ops
  tests/whatsapp.test.ts      # Integration tests
  add/src/channels/whatsapp.ts          # New files
  modify/src/server.ts                  # Full modified file for merge
  modify/src/server.ts.intent.md        # Structured intent for conflict resolution
```

### Intent Files
Each modified file has a `.intent.md` with structured headings: **What this skill adds**, **Key sections**, **Invariants**, and **Must-keep sections**. These give Claude Code specific guidance during conflict resolution.

### Manifest
Declares: skill metadata, core version compatibility, files added/modified, file operations, structured operations, skill relationships (conflicts, depends, tested_with), post-apply commands, and test command.

## Customization and Layering

**One skill, one happy path** — a skill implements the reasonable default for 80% of users.

**Customization is more patching.** Apply the skill, then modify via tracked patches, direct editing, or additional layered skills. Custom modifications are recorded in `state.yaml` and replayable.

**Skills layer via `depends`.** Extension skills build on base skills (e.g., `telegram-reactions` depends on `add-telegram`).

## File Operations

Renames, deletes, and moves are declared in the manifest and run **before** code merges. When core renames a file, a **path remap** resolves skill references at apply time — skill packages are never mutated.

## The Apply Flow

1. Pre-flight checks (compatibility, dependencies, untracked changes)
2. Backup
3. File operations + path remapping
4. Copy new files
5. Merge modified code files (`git merge-file`)
6. Conflict resolution (shared cache → `git rerere` → Claude Code → Claude Code + user input)
7. Apply structured operations (batched)
8. Post-apply commands, update `state.yaml`
9. **Run tests** (mandatory, even if all merges were clean)
10. Clean up (delete backup on success, restore on failure)

## Shared Resolution Cache

`.nanoclaw/resolutions/` ships pre-computed, verified conflict resolutions with **hash enforcement** — a cached resolution only applies if base, current, and skill input hashes match exactly. This means most users never encounter unresolved conflicts for common skill combinations.

### rerere Adapter
`git rerere` requires unmerged index entries that `git merge-file` doesn't create. An adapter sets up the required index state after `merge-file` produces a conflict, enabling rerere caching. This requires the project to be a git repository; users without `.git/` lose caching but not functionality.

## State Tracking

`.nanoclaw/state.yaml` records: core version, all applied skills (with per-file hashes for base/skill/merged), structured operation outcomes, custom patches, and path remaps. This makes drift detection instant and replay deterministic.

## Untracked Changes

Direct edits are detected via hash comparison before any operation. Users can record them as tracked patches, continue untracked, or abort. The three-level model can always recover coherent state from any starting point.

## Core Updates

Most changes propagate automatically through three-way merge. **Breaking changes** require a **migration skill** — a regular skill that preserves the old behavior, authored against the new core. Migrations are declared in `migrations.yaml` and applied automatically during updates.

### Update Flow
1. Preview changes (git-only, no files modified)
2. Backup → file operations → three-way merge → conflict resolution
3. Re-apply custom patches (`git apply --3way`)
4. **Update base** to new core
5. Apply migration skills (preserves user's setup automatically)
6. Re-apply updated skills (version-changed skills only)
7. Re-run structured operations → run all tests → clean up

The user sees no prompts during updates. To accept a new default later, they remove the migration skill.

## Skill Removal

Uninstall is **replay without the skill**: read `state.yaml`, remove the target skill, replay all remaining skills from clean base using the resolution cache. Backup for safety.

## Rebase

Flatten accumulated layers into a clean starting point. Updates base, regenerates diffs, clears old patches and stale cache entries. Trades individual skill history for simpler future merges.

## Replay

Given `state.yaml`, reproduce the exact installation on a fresh machine with no AI (assuming cached resolutions). Apply skills in order, merge, apply custom patches, batch structured operations, run tests.

## Skill Tests

Each skill includes integration tests. Tests run **always** — after apply, after update, after uninstall, during replay, in CI. CI tests all official skills individually and pairwise combinations for skills sharing modified files or structured operations.

## Design Principles

1. **Use git, don't reinvent it.**
2. **Three-level resolution: git → Claude Code → Claude Code + user input.**
3. **Clean merges aren't enough.** Tests run after every operation.
4. **All operations are safe.** Backup/restore, no half-applied state.
5. **One shared base**, only updated on core updates.
6. **Code merges vs. structured operations.** Source code is merged; configs are aggregated.
7. **Resolutions are learned and shared** with hash enforcement.
8. **One skill, one happy path.** Customization is more patching.
9. **Skills layer and compose.**
10. **Intent is first-class and structured.**
11. **State is explicit and complete.** Replay is deterministic.
12. **Always recoverable.**
13. **Uninstall is replay.**
14. **Core updates are the maintainers' responsibility.** Breaking changes require migration skills.
15. **File operations and path remapping are first-class.**
16. **Skills are tested.** CI tests pairwise by overlap.
17. **Deterministic serialization.** No noisy diffs.
18. **Rebase when needed.**
19. **Progressive core slimming** via migration skills.