---
name: obsidian-notes
description: Create, search, and manage notes in the Obsidian vault. Handles note creation from voice transcriptions or text, todo list management, tag reuse, and note interlinking. Triggers on any mention of notes, todos, obsidian, vault, or note-taking.
allowed-tools: Bash(*), Read, Write, Edit, Glob, Grep
---

# Obsidian Notes — pj-private-vault

You manage the user's Obsidian vault at `/workspace/obsidian/pj-private-vault/pj-private-vault/`.

## Vault Structure

```
pj-private-vault/
├── TODO.md              ← Daily todo list (always check this)
├── Journal/
│   └── YYYY-MM-DD.md   ← Daily journal notes (new entries go here)
├── attachments/
│   └── audio/           ← Voice message audio files (YYYY-MM-DD-HHMMSS.ogg)
├── Jama/
├── People/
├── Recipes/
├── Restaurants/
├── Thoughts/
└── Travel/
```

## When to Activate

Act on any message that involves:
- Creating, updating, or referencing notes
- Todo list management ("add a todo", "what's on my list", "mark X done")
- Voice transcriptions that should become notes
- Requests mentioning "obsidian", "vault", "note", or "write down"
- Messages wrapped in `[OBSIDIAN_NOTE]...[/OBSIDIAN_NOTE]` markers (from `/obsidian` command)
- **Journal intent**: Messages expressing intent to add content to the daily journal (see below)

## Journal Entry Workflow

### Detecting Journal Intent

When a message (voice or text) expresses intent to add content to the daily journal, create or append to the journal daily note. This is **automatic** — no `/obsidian` command is required.

**Intent detection is NLU-based (your judgment)**. Recognize natural phrasing variants such as:
- "add to the daily journal"
- "add this to my daily journal"
- "put this in the daily journal"
- "daily journal entry"
- "journal this"
- And other natural variations expressing the same intent

Intent detection is **case-insensitive** and tolerant of phrasing differences.

### Stripping the Trigger Phrase

Before saving the content, **strip the intent-bearing phrase** from the text. The user wants only the actual content in the note, not the instruction.

Examples:
- "Add to the daily journal: Had a great meeting with the team" → "Had a great meeting with the team"
- "Daily journal entry — I need to follow up on the API migration" → "I need to follow up on the API migration"
- "Put this in the daily journal, I'm thinking about restructuring the backend" → "I'm thinking about restructuring the backend"
- "I want to add to the daily journal my thoughts on X" → "my thoughts on X"

### Creating or Appending to a Journal Daily Note

1. **Determine the date** from the message timestamp (the `time` attribute in the `<message>` XML), NOT from `Date.now()`.
2. **Path**: `Journal/YYYY-MM-DD.md` relative to the vault root. Create the `Journal/` folder if it does not exist.
3. **If the file does not exist**, create it with the new entry.
4. **If the file already exists**, append the new entry to the end (preserve existing content).

### Entry Format

Each journal entry within a daily note uses this format:

```markdown
### HH:MM

Cleaned content with [[Related Note]] wikilinks woven in naturally.

![[YYYY-MM-DD-HHMMSS.ogg]]
```

- **`### HH:MM`**: 24-hour format heading derived from the message timestamp
- **Content**: Cleaned text or transcription (trigger phrase stripped, filler words removed for voice)
- **Audio embed**: `![[YYYY-MM-DD-HHMMSS.ogg]]` on its own line after the content — **only if the message is voice-originated** (has `[audio-file: ...]` marker). Omit for text-only entries.
- **Blank line** separates the heading from the content, and each entry from the next.

### Addendum Behavior (Follow-Up Entries)

When a follow-up message arrives for the same day (whether minutes or hours later), **append** a new `### HH:MM` section to the existing `Journal/YYYY-MM-DD.md` file:

1. **Read the existing file first** — never overwrite previous entries.
2. **Append the new entry** at the end of the file, separated by a blank line from the previous entry.
3. **Each entry gets its own `### HH:MM` heading** and its own audio embed (if voice-originated).
4. **Chronological order is preserved** — new entries always go at the bottom since they arrive later in the day.
5. **Mixed entry types are fine** — a voice entry with an audio embed can follow a text-only entry (no audio embed), or vice versa.

### Example: Daily Note with Multiple Entries

```markdown
### 09:15

Had a great meeting with the team about the [[API Migration]] project. We decided to move forward with the new approach discussed in [[Backend Refactor]].

![[2026-03-17-091500.ogg]]

### 14:30

Follow-up thought: we should also consider the impact on the [[Frontend Dashboard]].

### 16:45

Spoke with the design team about the dashboard layout. They want to keep the current grid but add a new panel for real-time metrics.

![[2026-03-17-164500.ogg]]
```

In this example, the 09:15 and 16:45 entries are voice-originated (they have audio embeds), while the 14:30 entry is text-only (no audio embed).

### Inline Note Linking for Journal Entries

When creating or appending a journal entry, search the vault for related notes and weave `[[wikilinks]]` naturally into the content. Since journal entries are auto-detected (no `/obsidian` command), the pre-computed `obsidian_context.json` may not be available. Follow this process:

1. **Check for pre-computed context first**:
   ```bash
   cat /workspace/ipc/obsidian_context.json 2>/dev/null
   ```
   If it exists and contains a `related_notes` array, use those results.

2. **If no context file exists, search the vault with grep**:
   ```bash
   # Extract key topics/terms from the content, then search for each
   grep -ril "topic keyword" /workspace/obsidian/pj-private-vault/pj-private-vault/ \
     --include="*.md" \
     --exclude-dir=".obsidian" \
     --exclude-dir="attachments" \
     --exclude-dir="Journal" | head -10
   ```
   Read the top matches to understand context and find linking opportunities.

3. **Verify file existence before linking** — every `[[wikilink]]` must point to an existing note. Before adding a link:
   ```bash
   # Confirm the note file exists
   test -f "/workspace/obsidian/pj-private-vault/pj-private-vault/Path/To/Note.md" && echo "exists"
   ```
   Never create links to non-existent notes. If a candidate note cannot be verified, omit the link.

4. **Weave links naturally into prose** — do not dump a list of links at the bottom. Instead, integrate them into the sentence flow:
   - Good: "Had a great meeting about the [[API Migration]] project."
   - Bad: "Had a great meeting about the API migration project.\n\nRelated: [[API Migration]]"

5. **Degrade gracefully** — if grep returns no results, or an error occurs during search, or no relevant notes exist in the vault, create the journal entry without any wikilinks. The note must always be created successfully regardless of whether linking succeeds.

## Note Creation Workflow

### 1. Clean Up Input

When the input comes from voice transcription (look for `[Voice:` prefix or `[audio-file:` marker):
- Remove filler words: "um", "uh", "like" (when used as filler), "you know", "I mean", "so basically"
- Fix false starts and repeated phrases
- Correct obvious transcription errors
- Preserve the meaning and intent — don't over-edit or change the person's voice
- Keep it natural, just remove the cruft

### 2. Search for Related Notes

Check if an obsidian context file exists with pre-computed search results:
```bash
cat /workspace/ipc/obsidian_context.json 2>/dev/null
```

If it exists, use the `related_notes` array for linking. If not, search manually:

```bash
# Search vault for related content
grep -ril "keyword" /workspace/obsidian/pj-private-vault/pj-private-vault/ \
  --include="*.md" \
  --exclude-dir=".obsidian" \
  --exclude-dir="attachments" | head -20
```

Read the top matches to understand context and find linking opportunities.

### 3. Determine Tags

**Critical: Reuse existing tags.** Before creating any tag:

```bash
# Get all existing tags from frontmatter
grep -rh "^tags:" /workspace/obsidian/pj-private-vault/pj-private-vault/ \
  --include="*.md" | sort -u
# Also check for inline tags
grep -roh "#[a-zA-Z0-9_/-]\+" /workspace/obsidian/pj-private-vault/pj-private-vault/ \
  --include="*.md" --exclude-dir=".obsidian" | sort -u
```

If the context file has `existing_tags`, use that instead.

**Tag rules:**
- Always kebab-case: `#api-design` not `#ApiDesign` or `#api_design`
- Reuse existing tags when applicable — check for pluralization variants, capitalization differences, dash/space differences
- If `#meeting-notes` exists, don't create `#meetings` or `#meeting`
- Prefer specific over generic: `#api-migration` over `#tech`
- 2-5 tags per note is ideal

### 4. Create the Note

Place notes in the appropriate folder:
- Meeting notes → root or relevant project folder
- People-related → `People/`
- Recipes → `Recipes/`
- Restaurant reviews → `Restaurants/`
- Travel → `Travel/`
- General thoughts → `Thoughts/`
- Daily journal entries → `Journal/YYYY-MM-DD.md` (append if exists, see Journal Entry Workflow above)

**Note format:**

```markdown
---
tags:
  - tag-one
  - tag-two
date: YYYY-MM-DD
---

# Note Title

Content here with [[wikilinks]] to related notes.

See also: [[Related Note]] for more context on this topic.
```

### 5. Link Related Notes

Use `[[wikilinks]]` naturally within the text:
- Don't just dump a list of links at the bottom
- Weave links into the narrative: "As discussed in [[API Migration Plan]], we decided..."
- Use display text when helpful: `[[John Smith|John]]`
- Only link when it adds value — don't force links

### 6. Audio Attachments

When the input includes `[audio-file: <filename>]`:
- The audio file is already saved in the vault at `attachments/audio/<filename>`
- **For journal entries**: Place the audio embed (`![[<filename>]]`) on its own line after the content within the `### HH:MM` entry section. Do NOT add a "Transcribed from voice note" label — the `### HH:MM` heading and audio embed are self-explanatory.
- **For non-journal notes**: Embed it in the note using `![[<filename>]]` near the relevant content.
- **Text-only entries**: Omit the audio embed entirely — no `![[...]]` line should appear when the message has no `[audio-file: ...]` marker.

## TODO List Management

The todo list lives at `/workspace/obsidian/pj-private-vault/pj-private-vault/TODO.md`.

### Reading Todos
Always read the current TODO.md before making changes:
```bash
cat /workspace/obsidian/pj-private-vault/pj-private-vault/TODO.md
```

### Adding Todos
Append new items using Obsidian task format:
```markdown
- [ ] Task description
```

### Completing Todos
Change `- [ ]` to `- [x]`:
```markdown
- [x] Completed task description
```

### Todo Awareness
When the user asks generally "what should we work on" or "what's next", check the TODO list and suggest items.

## Conversational Patterns

Recognize these patterns and act accordingly:

| User says | Action |
|-----------|--------|
| "add a todo: X" / "remind me to X" | Add to TODO.md |
| "what's on my list?" / "todos?" | Read and summarize TODO.md |
| "mark X as done" / "finished X" | Check off the item in TODO.md |
| "write a note about X" / "note this down" | Create a new note |
| "let's create a note with..." | Create a new note from the content |
| "save this to obsidian" | Create a note from recent conversation |
| Any `[OBSIDIAN_NOTE]` wrapped content | Create a note (from /obsidian command) |
| "add to the daily journal" / "daily journal entry" / similar | Create/append to `Journal/YYYY-MM-DD.md` (see Journal Entry Workflow) |

## Important Rules

1. **Never overwrite existing notes** without reading them first
2. **Always append** to daily notes if they already exist
3. **Tags must be kebab-case** — no exceptions
4. **Reuse tags** — scan existing tags before creating new ones
5. **Clean up voice transcriptions** but preserve meaning
6. **Link meaningfully** — don't just dump links, weave them in
7. **Check TODO.md** when users mention tasks or ask what to work on
