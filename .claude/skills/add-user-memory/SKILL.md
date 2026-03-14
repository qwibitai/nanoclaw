---
name: add-user-memory
description: Add a structured USER.md file for persistent user identity, preferences, and context — shared across all agents with a character limit to prevent bloat.
---

# Add User Memory (USER.md)

This skill creates a `USER.md` file at the nanoclaw root and updates the global agent configuration to read and maintain it. Agents use `USER.md` as a lightweight, shared user profile: who the user is, how they prefer to communicate, and what context is currently relevant.

`USER.md` has a hard 2 000-character limit. Agents replace stale entries rather than appending, keeping the file compact and always useful.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f USER.md && echo "Already applied" || echo "Not applied"
```

If `USER.md` already exists, skip to Phase 3 (Verify).

## Phase 2: Apply

### Create USER.md

Create `USER.md` in the nanoclaw root with the following template.
Fill in the fields that are known; leave the rest as the placeholder comments:

```markdown
# USER.md
<!-- Hard limit: 2 000 characters. Agents: replace stale entries, do not append. -->

## Identity
- Name: <!-- e.g. Alex -->
- Timezone: <!-- e.g. America/New_York -->
- Language: <!-- e.g. English / 中英混用 -->

## Communication Preferences
- Tone: <!-- e.g. concise, encouraging, no sarcasm -->
- Response length: <!-- e.g. short unless detail is requested -->
- Formatting: <!-- e.g. plain text preferred / markdown ok -->

## Ongoing Context
<!-- 3–5 bullet points of what the user is currently working on.
     Agents update this section when significant project state changes. -->
-

## Recent Decisions
<!-- Last 5 decisions or preference changes, with dates.
     Remove oldest when adding new ones. -->
-
```

### Update global CLAUDE.md

Open `groups/global/CLAUDE.md` (or the equivalent global configuration file in your setup) and add the following block **before** the first agent-specific section:

```markdown
## User Memory

A shared `USER.md` file lives at the nanoclaw root. All agents MUST:

1. **Read `USER.md` at the start of each session** to load current user context.
2. **Update `USER.md`** when:
   - The user states a new preference or changes an existing one.
   - A significant project decision is made.
   - Ongoing context becomes stale.
3. **Keep it under 2 000 characters** — replace old entries, do not append.
4. **Never store sensitive data** (passwords, tokens, private keys) in `USER.md`.
```

### Verify character limit tooling (optional)

If you want an automated guard, add this one-liner to your pre-commit hook or CI:

```bash
awk 'END { if (NR > 80) { print "USER.md exceeds ~2000 chars (80 lines). Trim it."; exit 1 } }' USER.md
```

> Adjust the line count to match your average line length.

## Phase 3: Verify

### Confirm file exists

```bash
cat USER.md
```

The file should be present and follow the template structure.

### Confirm agents read it

Restart NanoClaw and open a new conversation with any agent.
Ask: *"What do you know about me?"*
The agent should surface the information from `USER.md` rather than asking again.

### Check size

```bash
wc -c USER.md
```

Output should be well under 2 000 characters on a fresh install.

## Troubleshooting

### Agents ignore USER.md

- Confirm the instruction block was added to `groups/global/CLAUDE.md` and that NanoClaw reloaded it.
- Some agents cache their system prompt at startup — restart the relevant container.

### File grows too large

- Review the **Ongoing Context** and **Recent Decisions** sections.
- Remove entries older than 30 days or no longer relevant.
- Run `wc -c USER.md` after trimming to confirm it is under 2 000 characters.

### Multiple agents overwrite each other

- Agents should use a read-modify-write pattern: read the full file, make the minimal change, write it back.
- Avoid concurrent writes from two agents in the same second; NanoClaw's single-threaded group queue makes this unlikely in normal use.

