# Knowledge Base Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use the-controller-executing-plans to implement this plan task-by-task.

**Goal:** Add a personal knowledge base skill to NanoClaw that lets the agent capture, retrieve, and gamify-review notes through chat.

**Architecture:** Pure container skill — a SKILL.md file with instructions, plus seed directory structure. No TypeScript code changes. The agent uses its existing tools (Read, Write, Edit, Bash+ripgrep) to manage markdown files.

**Tech Stack:** Markdown files with YAML frontmatter, ripgrep for search, NanoClaw scheduled tasks for daily reviews.

**Design doc:** `docs/plans/2026-03-20-knowledge-base-design.md`

**Key constraint:** The `groups/global/` directory is mounted read-only for all agents (including main). The KB lives in the main group's workspace at `/workspace/group/kb/` (host path: `groups/main/kb/`), which is read-write. If multi-group access is needed later, add a writable mount for the KB directory.

---

### Task 1: Create KB directory structure with seed files

**Files:**
- Create: `groups/main/kb/entries/` (empty directory, will hold full entries)
- Create: `groups/main/kb/agents.md`
- Create: `groups/main/kb/reflections.md`
- Create: `groups/main/kb/connections.md`
- Create: `groups/main/kb/resources.md`
- Create: `groups/main/kb/todos.md`
- Create: `groups/main/kb/review-stats.md`

**Step 1: Create the directory structure**

```bash
mkdir -p groups/main/kb/entries
```

**Step 2: Create seed category files**

Each category file starts with a header comment explaining its format. This serves as in-file documentation for the agent.

`groups/main/kb/agents.md`:
```markdown
# Agents

<!-- KB category: AI agent tips, patterns, and ideas -->
<!-- Format: ## YYYY-MM-DD | #tag1 #tag2 | [score:0] [reviewed:never] -->
```

`groups/main/kb/reflections.md`:
```markdown
# Reflections

<!-- KB category: Personal reflections and observations -->
<!-- Format: ## YYYY-MM-DD | #tag1 #tag2 | [score:0] [reviewed:never] -->
```

`groups/main/kb/connections.md`:
```markdown
# Connections

<!-- KB category: People and contacts -->
<!-- Format: ## YYYY-MM-DD | #tag1 #tag2 | [score:0] [reviewed:never] -->
```

`groups/main/kb/resources.md`:
```markdown
# Resources

<!-- KB category: Links, articles, tools, repos -->
<!-- Format: ## YYYY-MM-DD | #tag1 #tag2 | [score:0] [reviewed:never] -->
```

`groups/main/kb/todos.md`:
```markdown
# Todos

<!-- KB category: Things to do -->
<!-- Format: ## YYYY-MM-DD | #tag1 #tag2 | [score:0] [reviewed:never] [status:todo] -->
<!-- Status: todo | doing | done | someday -->
```

`groups/main/kb/review-stats.md`:
```markdown
# Review Stats

- Total entries: 0
- Total reviewed: 0
- Total pruned: 0
- Current streak: 0
- Last review date: never
```

**Step 3: Verify structure**

Run: `find groups/main/kb -type f | sort`

Expected:
```
groups/main/kb/agents.md
groups/main/kb/connections.md
groups/main/kb/reflections.md
groups/main/kb/resources.md
groups/main/kb/review-stats.md
groups/main/kb/todos.md
```

**Step 4: Commit**

```bash
git add groups/main/kb/
git commit -m "feat: create KB directory structure with seed category files"
```

---

### Task 2: Write the knowledge-base SKILL.md

This is the core deliverable. The SKILL.md contains all instructions the container agent needs to manage the KB.

**Files:**
- Create: `container/skills/knowledge-base/SKILL.md`

**Step 1: Write the skill file**

Create `container/skills/knowledge-base/SKILL.md` with these sections. Read the existing skills at `container/skills/capabilities/SKILL.md` and `container/skills/status/SKILL.md` for format reference — follow the same frontmatter pattern.

The SKILL.md must cover:

**Frontmatter:**
```yaml
---
name: knowledge-base
description: Personal knowledge base — capture, retrieve, review, and manage notes across categories. Use when the user wants to save information, search their notes, or run a review session. Also use proactively when conversation topics match existing KB entries.
---
```

**Section: KB Location**
- Path: `/workspace/group/kb/`
- Category files: `agents.md`, `reflections.md`, `connections.md`, `resources.md`, `todos.md`
- Full entries: `entries/` directory for detailed notes with YAML frontmatter
- Review stats: `review-stats.md`
- New categories: created on the fly as `{category}.md` when user says "save this under {category}"

**Section: Quicknote Format**
```markdown
## YYYY-MM-DD | #tag1 #tag2 | [score:0] [reviewed:never]
The note content goes here. One or two lines.
```
- `score` — incremented on "keep" during review or when surfaced and user engages
- `reviewed` — date of last review, or `never`

**Section: Full Entry Format** (for `entries/` directory)
```yaml
---
type: contact
title: John from Acme Corp
tags: [kubernetes, devops]
related: []
created: 2026-03-20
source: direct
score: 0
last_reviewed: null
---

Content here.
```
- Use full entries when a note needs more than ~3 lines of content
- Types: contact, resource, idea, tip, todo

**Section: Capture — Natural Language**
- Detect KB-worthy information from conversation:
  - "remember that...", "save this...", "note to self...", "idea:..." → capture
  - "todo:...", "remind me to..." → capture as todo
- Steps:
  1. Pick the category (ask if unclear)
  2. Structure the note (normalize names, add context, add tags)
  3. Ask: "Why does this matter?" — bake the answer into the note
  4. Check for duplicates: `rg -i "[key phrase]" /workspace/group/kb/`
  5. If duplicate found, ask: "I already have a note about X. Update it?"
  6. Write the note
  7. Confirm: "Saved to {category}.md: {one-line summary}"
- Decide quicknote vs full entry based on content length (>3 lines → full entry)

**Section: Capture — Explicit Commands**
- `kb save [category]: [content]` — write directly to category file
- `kb list [category]` — read and display the category file
- `kb search [query]` — `rg -i "[query]" /workspace/group/kb/`
- `kb categories` — `ls /workspace/group/kb/*.md` (exclude review-stats.md)
- `kb review` — start an on-demand review session (same as scheduled review)

**Section: Retrieval**
- When user asks "what do I know about X?" or "who do I know at Y?":
  1. Run `rg -i "[query]" /workspace/group/kb/ -l` to find matching files
  2. Read matching sections and present them
  3. For full entries, show title + first few lines
- Proactive surfacing (judgment-based):
  - When a conversation topic strongly matches existing KB entries
  - Only when genuinely helpful — not during quick back-and-forth
  - Format: brief inline mention: "(You have a note that John at Acme is a K8s expert — saved Mar 2026)"
  - After surfacing, if user engages with the note, increment its score

**Section: Gamified Review**
- Daily scheduled task sends 3 notes to review
- Selection: oldest `reviewed` date first (`never` = highest priority)
- How to select notes:
  1. Read all category files and entries/
  2. Parse `[reviewed:...]` tags and frontmatter `last_reviewed` fields
  3. Sort by review date ascending (never-reviewed first)
  4. Pick the 3 oldest
- Format each note as:

```
*KB Review* (3 notes today)

*1.* (agents.md, Mar 20)
Chain-of-thought works better at the end of a prompt.

👍 Keep · 👎 Trash · ✏️ Rewrite

*2.* (connections.md, Mar 19)
John Smith at Acme Corp — K8s expert, met at KubeCon.

👍 Keep · 👎 Trash · ✏️ Rewrite

*3.* (resources.md, Mar 18)
https://example.com/prompt-engineering — comprehensive guide to prompting.

👍 Keep · 👎 Trash · ✏️ Rewrite
```

- Processing responses:
  - 👍 / "keep" / "1" → increment score, update reviewed date
  - 👎 / "trash" / "delete" → remove the entry, increment pruned count
  - ✏️ / "rewrite" → ask what to change, update note, reset score to 1
  - No response → leave as-is, don't update reviewed date
- After processing, update `review-stats.md`:
  - Increment total reviewed
  - Increment streak (reset if last review > 1 day ago)
  - Update last review date
  - Occasional nudge: "5-day streak. KB is 60% reviewed."

**Section: Promotion**
- When a quicknote is referenced 3+ times or user adds significant context, suggest promoting to a full entry in `entries/`
- Agent creates the full entry file and removes the quicknote from the category file

**Section: Message Formatting**
- Use WhatsApp/Telegram formatting (single *asterisks* for bold, _underscores_ for italic, • bullets)
- Never use markdown headings in messages to the user

**Step 2: Review the skill file**

Read back `container/skills/knowledge-base/SKILL.md` and verify:
- Frontmatter has name and description
- All sections are present and clear
- File paths reference `/workspace/group/kb/` (not `/workspace/global/kb/`)
- Formatting instructions match the channel formatting rules from `groups/global/CLAUDE.md`

**Step 3: Commit**

```bash
git add container/skills/knowledge-base/SKILL.md
git commit -m "feat: add knowledge-base container skill"
```

---

### Task 3: Update main group CLAUDE.md with KB reference

Add a short section to `groups/main/CLAUDE.md` so the agent knows the KB exists even without the skill being invoked.

**Files:**
- Modify: `groups/main/CLAUDE.md` (append after the "Global Memory" section, before "Scheduling for Other Groups")

**Step 1: Add KB section**

Append this section to `groups/main/CLAUDE.md`:

```markdown
## Knowledge Base

You have a personal knowledge base at `/workspace/group/kb/`. See the `/knowledge-base` skill for full instructions.

Quick reference:
- Category files: `kb/agents.md`, `kb/reflections.md`, `kb/connections.md`, `kb/resources.md`, `kb/todos.md`
- Full entries: `kb/entries/`
- Search: `rg -i "query" /workspace/group/kb/`
- When conversation topics match KB entries, briefly mention them if helpful.
```

**Step 2: Verify the edit**

Read `groups/main/CLAUDE.md` and confirm the new section is correctly placed and doesn't break existing content.

**Step 3: Commit**

```bash
git add groups/main/CLAUDE.md
git commit -m "feat: add KB reference to main group CLAUDE.md"
```

---

### Task 4: Test capture flow

Verify the agent can create KB entries by running it manually.

**Step 1: Build and start NanoClaw**

```bash
npm run build
```

**Step 2: Test via the main group chat**

Send these messages to the main group and verify the agent handles them correctly:

1. "remember that Sarah from CloudCo is great at distributed systems" → should write to `connections.md`, should ask why this matters
2. "idea: what if KB entries could link to each other automatically" → should write to `agents.md` or create a new category
3. "kb save resources: https://example.com/prompt-guide — comprehensive prompting tutorial" → should write to `resources.md`
4. "kb list connections" → should show Sarah's entry
5. "kb search Sarah" → should find the connections entry

**Step 3: Verify files on disk**

```bash
cat groups/main/kb/connections.md
cat groups/main/kb/resources.md
```

Confirm entries were written in the correct quicknote format with date, tags, score, and reviewed fields.

**Step 4: Commit any agent-created content if test entries should persist**

If test entries should be cleaned up:
```bash
git checkout -- groups/main/kb/
```

---

### Task 5: Set up daily review scheduled task

The review cron is set up by the agent itself, not by code. Instruct the agent to create it.

**Step 1: Send the scheduling message**

From the main group chat, tell the agent:

"Set up a daily KB review. Every day at 9 AM, send me 3 notes to review from my knowledge base."

The agent should use `mcp__nanoclaw__schedule_task` with:
- `prompt`: "Run a KB review session. Read all entries in /workspace/group/kb/, find the 3 with the oldest reviewed date (or never reviewed), and present them for review using the format from the /knowledge-base skill."
- `schedule_type`: "cron"
- `schedule_value`: "0 9 * * *" (9 AM daily)

**Step 2: Verify the task was created**

```bash
sqlite3 store/messages.db "SELECT id, prompt, schedule_type, schedule_value, status FROM scheduled_tasks WHERE prompt LIKE '%KB review%' OR prompt LIKE '%knowledge base%';"
```

Expected: one active cron task.

**Step 3: Test the review manually**

Tell the agent: "kb review" — it should present notes for review even before the cron fires.

---

### Task 6: Verify end-to-end with a real review cycle

**Step 1: Seed a few test entries**

Send to the agent:
1. "remember: always test with real data, not mocks"
2. "idea: gamify code reviews with emoji reactions"
3. "todo: set up weekly planning ritual"

**Step 2: Trigger a review**

Send: "kb review"

Expected: agent presents 3 notes with 👍/👎/✏️ options.

**Step 3: Respond to review**

- Reply "👍" to note 1
- Reply "👎" to note 2
- Reply "✏️" to note 3, then provide rewrite text

**Step 4: Verify state changes**

```bash
cat groups/main/kb/reflections.md   # note 1 should have updated score and reviewed date
cat groups/main/kb/agents.md        # note 2 should be removed
cat groups/main/kb/review-stats.md  # should show updated stats
```

**Step 5: Commit working state**

```bash
git add groups/main/kb/ container/skills/knowledge-base/
git commit -m "feat: knowledge base skill complete with review system"
```
