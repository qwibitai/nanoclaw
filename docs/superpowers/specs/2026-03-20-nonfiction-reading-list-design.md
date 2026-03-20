# Non-Fiction Reading List — Design Spec

**Date:** 2026-03-20

---

## Problem

The researcher has a non-fiction reading list in `literature/queue.md` that is an unstructured, static list with no prioritization, no connection to active projects, and no integration with reference management tooling. The literature monitor discovers papers weekly but they accumulate without being triaged against research needs.

## Solution

Two new components — a `zotero-cli` tool and a `reading-list` skill — that together make Zotero the source of truth for the non-fiction reading queue, prioritize it against active research, and surface a ranked view in the vault and via WhatsApp.

---

## Component 1: `zotero-cli`

**Location:** `container/tools/zotero-cli/`

A Python CLI tool built on pyzotero, installed in the agent container image. Provides the agent with full read/write access to the researcher's Zotero library via the Web API.

### Commands

| Command | Purpose |
|---------|---------|
| `zotero-cli search <query> [--limit N]` | Search library, return results as JSON |
| `zotero-cli add --title "..." --authors "..." [--doi "..."] [--url "..."] [--note "..."] --collection "To Read"` | Add an item to a collection |
| `zotero-cli list <collection-name> [--limit N]` | List items in a collection |
| `zotero-cli add-to <item-key> <collection-name>` | Add item to a collection (items can belong to multiple collections) |
| `zotero-cli remove <item-key> <collection-name>` | Remove item from a collection |
| `zotero-cli collections` | List all collections |

### Configuration

- Reads `ZOTERO_API_KEY` and `ZOTERO_LIBRARY_ID` from environment variables
- Injected by the container runner: requires adding these keys to `buildContainerArgs()` in `src/container-runner.ts`, following the same `readEnvFile()` + `-e` flag pattern used for `OPENAI_API_KEY` and `POSTGRES_PASSWORD`

### Output

- Default: JSON to stdout (parseable by agent)
- `--format text` flag for human-readable output

### Notes on `--note` flag

The `--note` value is stored in Zotero's "Extra" field on the item itself (not as a child note attachment). This is appropriate for short relevance explanations like "Supports community-sorting project — uses same ABM approach."

### Installation

- Container Dockerfile must add `python3` and `python3-pip` (the base `node:22-slim` image does not include Python)
- Then `pip install pyzotero`
- CLI script copied to container and made executable on PATH
- No desktop Zotero installation required — Web API only

---

## Component 2: `reading-list` skill

**Location:** `container/skills/reading-list/SKILL.md`

A scheduled skill that runs twice weekly. It gathers context from the researcher's active work, incorporates literature monitor findings, manages the Zotero "To Read" collection, and produces a prioritized reading list.

### Schedule

| Entry | Cron | Timezone | Notes |
|-------|------|----------|-------|
| `reading-list-mon` | `0 8 * * 1` | Europe/Zurich | Monday, 1 hour after literature monitor |
| `reading-list-thu` | `0 8 * * 4` | Europe/Zurich | Thursday |

### Inputs

1. **Researcher context:** `_meta/researcher-profile.md`, `_meta/top-of-mind.md` (via MCP-Vault)
2. **Active projects:** all `projects/<project>/PROJECT.md` files — reads `## Status` sections for current research needs
3. **Recent literature:** `literature/weekly-*.md` notes from the literature monitor
4. **Current Zotero queue:** `zotero-cli list "To Read"`

### Process

1. **Gather context** — read researcher profile, active project statuses, recent literature monitor output
2. **Suggest additions** — identify papers/books from literature monitor findings and project needs not already in Zotero. Check for duplicates via `zotero-cli search` before adding. Add via `zotero-cli add --collection "To Read"` with a `--note` explaining relevance (which project, why timely)
3. **Prioritize the queue** — rank everything in "To Read" by:
   - **Project relevance** — directly supports active work (highest weight)
   - **Urgency** — time-sensitive topics, fast-moving fields
   - **Researcher signals** — mentioned in conversation, flagged in top-of-mind
4. **Write vault note** — regenerate `literature/reading-list.md`:
   - Frontmatter: `generated`, `total_items`, `new_additions`
   - **Read Next** (3-5 items) — highest priority, with a sentence on why each matters now
   - **On Deck** (5-10 items) — important but not urgent
   - **Backlog** (remainder) — worth reading eventually
5. **Send WhatsApp summary** — via `mcp__nanoclaw__send_message`: top 3 items, any new additions since last run, items sitting in queue for a long time

### Vault note format

```yaml
---
generated: 'YYYY-MM-DD'
total_items: <N>
new_additions: <N>
---
```

Body:
- `# Reading List — YYYY-MM-DD`
- `## Read Next` — 3-5 items with relevance notes
- `## On Deck` — 5-10 items
- `## Backlog` — remainder

---

## Component 3: Literature monitor integration

A small addition to the existing `container/skills/literature-monitoring/SKILL.md`.

**New step 6, inserted after the existing queue.md update (step 5). The existing "Report back" step becomes step 7.**

6. **Add must-read papers to Zotero** — for each Must-Read paper:
   - Check if already in Zotero via `zotero-cli search` (avoid duplicates)
   - If not present, call `zotero-cli add --collection "To Read"` with title, authors, DOI/URL, and a `--note` with the relevance explanation from the weekly report

This bridges the two skills: literature monitor discovers, reading list skill prioritizes.

---

## Component 4: Container setup

### Dockerfile changes

- Add `python3` and `python3-pip` to `apt-get install` (base image is `node:22-slim`, no Python included)
- `pip install pyzotero`
- Copy `container/tools/zotero-cli/` to container, add to PATH

### Container runner changes

- Add `ZOTERO_API_KEY` and `ZOTERO_LIBRARY_ID` to `buildContainerArgs()` in `src/container-runner.ts` (add to `readEnvFile()` call and `-e` flags, same pattern as existing API keys)
- Add values to `.env`

### Zotero account setup (one-time)

- Create Zotero account if needed
- Generate API key at zotero.org/settings/keys (with read/write library access)
- Create "To Read" collection in the library
- Store API key and library ID in NanoClaw's environment configuration

---

## Error handling

If `zotero-cli` fails during a scheduled run (API key expired, rate limiting, network timeout, Zotero outage):
- The reading-list skill should still produce the vault note from whatever data it can gather (e.g. from cached/previous Zotero data or vault-only sources), noting that Zotero was unreachable
- The literature monitor should complete its existing steps (weekly note, queue.md) and skip the Zotero addition step, logging the failure
- Neither skill should abort entirely due to Zotero unavailability

---

## Migration

- The existing `literature/queue.md` content should be imported into Zotero's "To Read" collection as a one-time migration step via a script that parses the markdown entries and calls `zotero-cli add` for each. Entries lacking structured metadata (DOI, authors) should be added with whatever is available (title at minimum) and flagged for manual enrichment
- After migration, `literature/queue.md` is superseded by `literature/reading-list.md` (the prioritized view) and the Zotero collection (the source of truth)
- The literature monitor skill continues to append to `queue.md` for backwards compatibility until the reading-list skill is confirmed working, then the queue.md append step can be removed

---

## Out of scope

- Fiction reading list (future Storygraph integration)
- Zotero MCP server (may promote `zotero-cli` to MCP later)
- Reading progress tracking (read/unread status)
- Full Zotero library management (this is just the "To Read" workflow)
- Zotero tagging for priority tiers (future consideration: tagging items as "read-next", "on-deck" in Zotero itself)
- Content registry integration (the content registry and Zotero are independent paths for now; may unify later)
