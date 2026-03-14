---
name: add-user-memory
description: Add a structured USER.md file inside groups/global/ for persistent user identity, preferences, and context — readable by all agent containers with a 2000-character limit to prevent bloat.
---

# Add User Memory (USER.md)

This skill creates `groups/global/USER.md` and updates `groups/global/CLAUDE.md` to instruct all agents to read and maintain it. Agents use `USER.md` as a shared, lightweight user profile: who the user is, how they like to communicate, and what context is currently relevant.

`groups/global/` is mounted read-write into every agent container, making this the correct location for shared state. `USER.md` has a hard 2 000-byte limit. Agents replace stale entries rather than appending, keeping the file compact.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f groups/global/USER.md && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply

### Create groups/global/USER.md

Create the file with the following template.
Fill in fields that are known; leave the rest as placeholder comments:

```markdown
# USER.md
<!-- Hard limit: 2000 bytes. Agents: replace stale entries, do not append. -->

## Identity
- Name: <!-- e.g. Alex -->
- Timezone: <!-- e.g. America/New_York -->
- Language: <!-- e.g. English / mixed English-Chinese -->

## Communication Preferences
- Tone: <!-- e.g. concise, encouraging, no sarcasm -->
- Response length: <!-- e.g. short unless detail is requested -->
- Formatting: <!-- e.g. plain text preferred / markdown ok -->

## Ongoing Context
<!-- 3–5 bullets of what the user is currently working on.
     Update when project state changes significantly. -->
-

## Recent Decisions
<!-- Last 5 preference changes or decisions, newest first, with dates.
     Remove oldest when list exceeds 5 entries. -->
-
```

### Update groups/global/CLAUDE.md

Open `groups/global/CLAUDE.md` and add the following block **before** any agent-specific sections:

```markdown
## User Memory

`groups/global/USER.md` contains a shared user profile. All agents MUST:

1. **Read `USER.md` at the start of each session** to load current user context.
2. **Update `USER.md`** when:
   - The user states a new preference or changes an existing one.
   - A significant project decision is made.
   - Ongoing context becomes stale.
3. **Keep it under 2 000 bytes** — replace old entries, do not append.
4. **Never store sensitive data** (passwords, tokens, private keys) in `USER.md`.
```

### Verify the size guard

Confirm the file is within the limit:

```bash
wc -c groups/global/USER.md
```

Output should be well under 2 000 bytes on a fresh install.
To enforce this automatically, add to your pre-commit hook or CI:

```bash
size=$(wc -c < groups/global/USER.md)
if [ "$size" -gt 2000 ]; then
  echo "USER.md exceeds 2000 bytes ($size). Trim it before committing." >&2
  exit 1
fi
```

## Phase 3: Verify

### Confirm file exists and is readable from a container

```bash
cat groups/global/USER.md
wc -c groups/global/USER.md
```

### Confirm agents read it

Restart NanoClaw and open a new conversation with any agent.
Ask: *"What do you know about me?"*
The agent should surface information from `USER.md` rather than asking again.

## Troubleshooting

### Agents ignore USER.md

- Confirm the instruction block was added to `groups/global/CLAUDE.md` and that NanoClaw reloaded the container image.
- Restart the relevant container if it cached an older system prompt.

### File grows too large

- Review **Ongoing Context** and **Recent Decisions** — remove entries older than 30 days or no longer relevant.
- Run `wc -c groups/global/USER.md` after trimming to confirm it is under 2 000 bytes.

### Multiple agents overwrite each other

- Agents should use a read-modify-write pattern: read the full file, make the minimal targeted change, write it back.
- NanoClaw's single-threaded group queue makes concurrent writes unlikely in normal use.

