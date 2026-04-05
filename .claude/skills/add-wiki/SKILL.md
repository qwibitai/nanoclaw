---
name: add-wiki
description: Add a persistent wiki knowledge base to a NanoClaw group. The agent ingests sources (URLs, files, attachments), builds interlinked wiki pages, answers questions from accumulated knowledge, and runs periodic health checks. Based on the LLM Wiki pattern. Triggers on "add wiki", "wiki", "knowledge base", "llm wiki".
---

# Add Wiki

Adds a persistent wiki knowledge base to a NanoClaw group. The agent builds and maintains structured, interlinked markdown pages from sources you provide. Knowledge compounds over time rather than being re-derived on every question.

Based on the [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Phase 1: Pre-flight

Check if `container/skills/wiki/SKILL.md` exists. If it does, skip to Phase 3.

## Phase 2: Apply Code Changes

```bash
git fetch origin skill/wiki
git merge origin/skill/wiki
```

If merge conflicts, resolve them. Then:

```bash
npm run build
./container/build.sh
```

## Phase 3: Setup

### Choose target group

AskUserQuestion: "Which group should have the wiki?"

1. **Main group** — add wiki to your existing main chat
2. **Dedicated wiki group** — create a new group just for the wiki (recommended for focused research)
3. **Other** — pick an existing group

If dedicated: ask which channel and chat to use, then register with `npx tsx setup/index.ts --step register`.

### Wiki topic

Ask the user: "What's this wiki for?" (e.g. AI research, health tracking, competitive analysis, trip planning, book companion, general knowledge base)

This shapes the initial index categories and the CLAUDE.md additions.

### Create directory structure

In the target group folder:

```bash
mkdir -p groups/<folder>/wiki groups/<folder>/sources
```

Create initial `wiki/index.md`:

```markdown
# Index

_Last updated: <today>_

(Pages will appear here as sources are added.)
```

Create initial `wiki/log.md`:

```markdown
# Log

## [<today>] setup | Wiki initialized
Wiki created. Topic: <topic>.
```

### Update group CLAUDE.md

Add a wiki section to the group's CLAUDE.md. Keep it brief — the container skill has the full workflow:

```markdown
## Wiki

You maintain a persistent wiki on <topic>. When sources arrive (URLs, files, attachments), ingest them into the wiki — don't just answer and move on. The `/wiki` container skill has the full ingest/query/lint workflow.

- Wiki pages: `wiki/` (start with `wiki/index.md`)
- Raw sources: `sources/` (immutable — never modify)
```

### Optional: Schedule lint

AskUserQuestion: "Want periodic wiki health checks?"

1. **Weekly** — every Sunday at 10am
2. **Monthly** — first of each month
3. **Skip** — lint manually when needed

If yes, use `mcp__nanoclaw__schedule_task`:
- prompt: "Run a wiki lint. Check for contradictions, orphan pages, stale content, missing cross-references, and gaps. Report findings."
- schedule_type: "cron"
- schedule_value: `"0 10 * * 0"` (weekly) or `"0 10 1 * *"` (monthly)

### Optional: Obsidian

If the user uses Obsidian, mention they can point a vault at `groups/<folder>/` for graph view, backlinks, and visual browsing. The wiki is just markdown files on disk.

## Phase 4: Verify

Restart the service to pick up the new container skill:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

Tell the user to test: send a URL to the wiki group. The agent should ingest it, create wiki pages, and update the index.
