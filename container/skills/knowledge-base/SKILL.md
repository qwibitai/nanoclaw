---
name: knowledge-base
description: Personal knowledge base — capture, retrieve, review, and manage notes across categories. Use when the user wants to save information, search their notes, or run a review session. Also use proactively when conversation topics match existing KB entries.
---

# /knowledge-base — Personal Knowledge Base

Capture, retrieve, review, and manage the user's notes and knowledge.

## KB Location

- **Root:** `/workspace/group/kb/`
- **Category files:** `agents.md`, `reflections.md`, `connections.md`, `resources.md`, `todos.md`
- **Full entries:** `entries/` directory for detailed notes with YAML frontmatter
- **Review stats:** `review-stats.md`
- **New categories:** created on the fly as `{category}.md` when the user says "save this under {category}"

Ensure the directory structure exists before any write:

```bash
mkdir -p /workspace/group/kb/entries
```

## Quicknote Format

Quicknotes live inside category files (e.g., `agents.md`, `connections.md`). Each note is a section:

```markdown
## YYYY-MM-DD | #tag1 #tag2 | [score:0] [reviewed:never]
The note content goes here. One or two lines.
```

- `score` — incremented on "keep" during review or when surfaced and the user engages
- `reviewed` — date of last review, or `never`

## Full Entry Format

Full entries live as individual files in `entries/`. Use when a note needs more than ~3 lines of content.

Filename convention: `YYYY-MM-DD-slug.md` (e.g., `2026-03-20-john-acme-corp.md`).

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

Valid types: `contact`, `resource`, `idea`, `tip`, `todo`

## Capture — Natural Language

Detect KB-worthy information from conversation. Trigger phrases:

- "remember that...", "save this...", "note to self...", "idea:..." → capture
- "todo:...", "remind me to..." → capture as todo in `todos.md`

Steps:

1. **Pick the category.** If unclear from context, ask: "Which category — agents, reflections, connections, resources, or a new one?"
2. **Structure the note.** Normalize names, add context from the conversation, generate relevant tags.
3. **Ask "Why does this matter?"** Bake the answer into the note so it's useful months later.
4. **Check for duplicates:**
   ```bash
   rg -i "[key phrase]" /workspace/group/kb/
   ```
5. **If duplicate found,** ask: "I already have a note about X. Update it?"
6. **Write the note.** Append to the category file (quicknote) or create a file in `entries/` (full entry). Use full entry when content exceeds ~3 lines.
7. **Confirm:** "Saved to {category}.md: {one-line summary}"

## Capture — Explicit Commands

| Command | Action |
|---------|--------|
| `kb save [category]: [content]` | Write directly to category file as a quicknote |
| `kb list [category]` | Read and display the category file |
| `kb search [query]` | `rg -i "[query]" /workspace/group/kb/` |
| `kb categories` | `ls /workspace/group/kb/*.md` (exclude `review-stats.md`) |
| `kb review` | Start an on-demand review session (same as scheduled review) |

For `kb save`, follow the same duplicate-check and formatting steps as natural-language capture. For `kb list`, read the file and present notes using WhatsApp formatting.

## Retrieval

When the user asks "what do I know about X?" or "who do I know at Y?":

1. Search across all KB files:
   ```bash
   rg -i "[query]" /workspace/group/kb/ -l
   ```
2. Read matching sections from the found files.
3. For full entries, show title + first few lines.
4. Present results using WhatsApp formatting.

### Proactive Surfacing

Use judgment to surface relevant KB entries during conversation:

- Only when a conversation topic **strongly** matches existing KB entries
- Only when genuinely helpful — not during quick back-and-forth
- Format as a brief inline mention:
  `(You have a note that John at Acme is a K8s expert — saved Mar 2026)`
- If the user engages with the surfaced note, increment its `score`

## Gamified Review

### Triggering

- **Scheduled:** daily task sends 3 notes to review
- **On-demand:** user runs `kb review`

### Selecting Notes

1. Read all category files in `/workspace/group/kb/*.md` and all files in `entries/`
2. Parse `[reviewed:...]` metadata from quicknotes and `last_reviewed` frontmatter from full entries
3. Sort by review date ascending — `never`-reviewed notes have highest priority
4. Pick the 3 oldest

### Review Message Format

Send this using `mcp__nanoclaw__send_message` (or as direct output for on-demand reviews):

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

### Processing Responses

| Response | Action |
|----------|--------|
| 👍 / "keep" / "1" | Increment `score`, update `reviewed` date to today |
| 👎 / "trash" / "delete" | Remove the entry, increment `pruned` count in `review-stats.md` |
| ✏️ / "rewrite" | Ask what to change, update note, reset `score` to 1, update `reviewed` date |
| No response | Leave as-is, do not update `reviewed` date |

### Review Stats

After processing responses, update `/workspace/group/kb/review-stats.md`:

```markdown
## Review Stats
- total_reviewed: 42
- total_pruned: 5
- streak: 5
- last_review: 2026-03-21
```

- Increment `total_reviewed` by the number of notes acted on
- Increment `streak` if `last_review` is yesterday; otherwise reset to 1
- Update `last_review` to today
- Occasionally nudge: "5-day streak. KB is 60% reviewed."

To calculate "% reviewed": count notes where `reviewed` is not `never` (or `last_reviewed` is not `null`) divided by total notes.

If `review-stats.md` doesn't exist, create it with zeros.

## Promotion

When a quicknote has been referenced 3+ times (score >= 3) or the user adds significant context to it:

1. Suggest: "This note has grown — want me to promote it to a full entry?"
2. If yes, create a full entry file in `entries/` with YAML frontmatter
3. Remove the quicknote from the category file
4. Confirm: "Promoted to entries/{filename}.md"

## Message Formatting

All user-facing output must use WhatsApp/Telegram formatting:

- Single *asterisks* for bold (NEVER **double asterisks**)
- _underscores_ for italic
- • bullets (not - dashes)
- ```triple backticks``` for code blocks
- No ## headings in messages
- No [links](url) syntax
