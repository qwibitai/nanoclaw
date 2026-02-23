# /remember

Capture learnings from the current conversation into persistent memory.

## Modes

### 1. Explicit — `/remember "always check for duplicates"`

The user provides a specific fact or preference to remember.

1. Parse the quoted text into a prose-sentence title (e.g., "Always check for duplicates before inserting")
2. Determine if this is a **user preference/fact** (→ `memory/`) or an **operational learning** (→ `self/methodology.md`)
3. If memory note:
   - Create `groups/main/memory/<Prose sentence title>.md` with YAML frontmatter:
     ```yaml
     ---
     description: ~150 char summary
     topics: [topic1, topic2]
     created: YYYY-MM-DD
     ---

     # Prose sentence title

     Content with context from the conversation.

     ## Related Notes
     - [[any related existing notes]]

     ---
     *Topics: [[topic1]] · [[topic2]]*
     ```
   - Update `groups/main/memory/index.md`: add to the appropriate topic section and update "Recent Additions"
4. If operational learning:
   - Append to the appropriate section of `groups/main/self/methodology.md`
5. Confirm what was captured and where

### 2. Contextual — `/remember` (no argument)

Scan the recent conversation for important learnings.

1. Review the last ~20 messages for:
   - User corrections ("no, do it this way")
   - Stated preferences ("I prefer...", "always...", "never...")
   - Decisions made ("let's go with X")
   - Facts learned about the user's systems or workflows
2. Present discovered candidates to the user:
   ```
   Found 3 potential memories:
   1. "User prefers tab indentation over spaces"
   2. "The staging server requires VPN access"
   3. "Weekly reports should go to the #updates channel"

   Capture all, some, or none?
   ```
3. Create notes for confirmed items (same process as explicit mode)

### 3. Session — `/remember session`

Review the full session for learnings.

1. Scan the entire conversation history
2. Identify all significant:
   - User preferences and corrections
   - System/domain knowledge learned
   - Decisions and their rationale
   - Operational patterns discovered
3. Present full list to user for selection
4. Create notes for confirmed items

## Rules

- **Atomic notes**: One idea per note. If a learning has two parts, create two notes.
- **Prose-sentence titles**: The title should make a claim, not just name a topic.
  - Good: "User prefers brief responses with option to elaborate"
  - Bad: "Response preferences"
- **Check for duplicates**: Before creating, search `groups/main/memory/` for existing notes that cover the same topic. Update existing notes rather than creating duplicates.
- **Link related notes**: Check `groups/main/memory/index.md` for related topics and add wiki-links.
- **Update the index**: Always update `groups/main/memory/index.md` after creating a note.
