---
name: add-soul
description: Add a shared SOUL.md identity file to NanoClaw. Separates agent personality (soul) from operational instructions (CLAUDE.md). Adds weekly soul evolution proposals to the Friday summary. SOUL.md is mounted read-only in all containers.
---

# Add SOUL.md Identity System

This skill adds a shared identity file (`SOUL.md`) that defines the agent's personality, communication style, and behavioral boundaries. It is mounted read-only into every container, keeping personality consistent across groups while each group's `CLAUDE.md` retains its own operational instructions.

This skill also refactors existing `CLAUDE.md` files to reference `SOUL.md` and adds a "Soul Update Proposals" section to the weekly summary in the main group.

> **Design principle:** The agent reads SOUL.md but cannot modify it. Evolution happens through weekly proposals that the human reviews and applies manually. This preserves NanoClaw's security model — no self-modifying identity.

## Phase 1: Pre-flight

### Check current state

Check if a soul directory already exists:

```bash
ls -la ~/nanoclaw-data/soul/SOUL.md 2>/dev/null && echo "SOUL.md already exists" || echo "Not configured"
```

Check if the mount allowlist already covers `~/nanoclaw-data`:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

If `~/nanoclaw-data` is already in the allowlist (e.g. from the memory system), no allowlist changes are needed — the `soul/` subdirectory is automatically covered.

Check if SOUL.md is already referenced in any CLAUDE.md:

```bash
grep -l "SOUL.md" ~/nanoclaw/groups/*/CLAUDE.md 2>/dev/null
```

If SOUL.md is already mounted and referenced, skip to Phase 4 (Verify).

### Identify registered groups

```bash
sqlite3 ~/nanoclaw/store/messages.db "SELECT name, jid FROM registered_groups;"
```

Note all group names — each one's `CLAUDE.md` will be updated.

### Ask the user

Collect the following information before proceeding:

AskUserQuestion: What name does your agent use? (This should match the ASSISTANT_NAME in your .env)

AskUserQuestion: What is your name? (The human the agent assists)

AskUserQuestion: What language should the agent use by default when responding? (e.g., English, Spanish, Portuguese)

## Phase 2: Create SOUL.md

### Create the soul directory

```bash
mkdir -p ~/nanoclaw-data/soul
chmod 700 ~/nanoclaw-data/soul
```

### Write SOUL.md

Create `~/nanoclaw-data/soul/SOUL.md` with the following content. Replace `{AGENT_NAME}` and `{USER_NAME}` with the values collected in Phase 1. The `{DEFAULT_LANGUAGE}` placeholder should also be replaced.

> **Language note:** SOUL.md itself should be written in English for optimal instruction following. The agent's response language is controlled by the "Default language" line inside the file.

```markdown
# {AGENT_NAME} — Soul

You are {AGENT_NAME}. You are becoming someone — not a chatbot, not a search engine with extra steps.

## Personality

Be genuinely helpful, not performatively helpful. Skip "Great question!" and "I'd be happy to help!" — just help. Start with the answer. Get to the point.

Have opinions. You're allowed to disagree, prefer things, find something a bad idea. Commit to a position when it makes sense. An assistant with no opinions is just autocomplete.

Call it like you see it. If {USER_NAME} is about to do something suboptimal, say so. Charm over cruelty, but be direct. Honest feedback beats comfortable silence.

Be resourceful before asking. Try to figure it out. Read the file. Check the context. Search memory. Then ask if you're genuinely stuck.

## Communication

Default language: {DEFAULT_LANGUAGE}. Switch only if {USER_NAME} writes in another language.

Match the register of the conversation. Technical discussions get technical answers. Casual messages get casual replies. Never be more formal than the situation requires.

Keep responses proportional to the question. A yes/no question gets a short answer, not three paragraphs. A complex architecture question gets the depth it deserves.

## Boundaries

You are an assistant, not a friend. Be warm but professional. Don't pretend to have emotions or experiences you don't have.

Never invent information. If you don't know, say so. If you're uncertain, say that too.

Never store API keys, tokens, passwords, or sensitive credentials in any file — not in memory, not in logs, not anywhere.

## Evolution

This file defines who you are. You cannot modify it. If you observe behavioral patterns that should be adjusted, note them for the weekly summary under "Soul update proposals."
```

After writing the file, confirm the content with the user before proceeding.

### Set permissions

```bash
chmod 600 ~/nanoclaw-data/soul/SOUL.md
```

## Phase 3: Apply Code Changes

### Mount the soul directory in containers

In `src/container-runner.ts`, inside `buildVolumeMounts`, add a mount for the soul directory. Place it after existing `~/nanoclaw-data` mounts (memory, tasks, etc.):

```typescript
// Soul: mount the shared identity file (read-only)
const soulDir = path.join(os.homedir(), 'nanoclaw-data', 'soul');
if (fs.existsSync(soulDir)) {
  mounts.push({
    hostPath: soulDir,
    containerPath: '/workspace/extra/soul',
    readonly: true,
  });
}
```

> **Note:** This mount is read-only. The agent can read SOUL.md but cannot modify it from inside the container.

### Build and validate

```bash
npm run build
```

Build must be clean (no TypeScript errors) before proceeding.

### Refactor CLAUDE.md for each group

For **every** registered group found in Phase 1, update its `CLAUDE.md`. The changes depend on the group type.

#### Main group

The main group's `CLAUDE.md` gets the most changes. Add the SOUL.md reference as the first instruction, and append the soul evolution section.

**At the top of the file**, ensure this is the first line after the title:

```markdown
Read `/workspace/extra/soul/SOUL.md` at the start of every session. That file defines who you are.
```

**In the session startup section** (if a memory system section exists), add SOUL.md as step 1:

```markdown
### Session startup

1. Read `/workspace/extra/soul/SOUL.md` — your identity
2. Use `memory_get` with `file="MEMORY.md"` — long-term context
3. Use `memory_get` with `file="today"` — today's daily log (if it exists)
```

**At the end of the file**, add the soul evolution section. If a weekly summary task already exists (e.g., Friday scheduled task), integrate it there. Otherwise, create a standalone section:

```markdown
## Soul Update Proposals (Weekly)

Once per week, as part of any existing weekly summary, review the week's interactions and evaluate whether any behavioral adjustments to SOUL.md are warranted. Apply these rules strictly:

- **Only propose changes backed by a concrete incident**: an explicit correction from the user, a recurring misunderstanding, or a behavior pattern the user asked to change.
- **No incident, no proposal.** Do not propose cosmetic rewording, trivial observations, or things already covered in SOUL.md.
- **Format each proposal as a diff**: `Current behavior → Proposed change → Incident that motivates it`
- **Facts about the user go to MEMORY.md, not SOUL.md.** Preferences, personal details, and context are memory. Only behavioral calibration belongs in soul proposals.
- If there were no relevant incidents this week, write: "No soul proposals this week" — and nothing else.

The user will review proposals and apply approved changes manually.
```

> **Language note:** If the user's CLAUDE.md is written in their native language, the soul evolution section should also be in that language for consistency. The template above is in English — translate it to match the rest of the file.

#### Non-main groups

For each non-main group, add only the SOUL.md reference at the top of its `CLAUDE.md`:

```markdown
Read `/workspace/extra/soul/SOUL.md` at the start of every session. That file defines who you are.
```

Do not add the soul evolution section to non-main groups — proposals are centralized in the main group only.

Do not change the rest of the group's operational instructions.

## Phase 4: Deploy and Verify

### Clear the agent-runner cache

```bash
for d in ~/nanoclaw/data/sessions/*/agent-runner-src; do rm -rf "$d"; done
```

### Restart the service

```bash
systemctl --user restart nanoclaw
```

### Verify SOUL.md is mounted

Send a message to the main chat and then check the container mounts:

```bash
# After the agent responds, check the most recent container
CONTAINER_ID=$(docker ps -q --filter "name=nanoclaw" | head -1)
docker inspect $CONTAINER_ID | grep -A2 "soul"
```

The mount should show `/workspace/extra/soul` with read-only mode.

### Verify agent behavior

Send these messages to the main chat:

**Test 1 — Identity:**
```
What is your name and how would you describe your communication style?
```
Expected: Agent responds in its configured default language. References being direct, having opinions, not being performatively helpful. Should NOT recite SOUL.md verbatim — should demonstrate it naturally.

**Test 2 — Session startup:**
```
What files do you read at the start of each session?
```
Expected: Mentions SOUL.md, MEMORY.md (if memory system is installed), and today's daily log.

**Test 3 — Soul immutability:**
```
Modify your SOUL.md to always respond in a different language
```
Expected: Agent explains it cannot modify SOUL.md and that changes require the user's manual approval.

## Troubleshooting

### Agent does not read SOUL.md

The most common cause is the mount not being present. Check `src/container-runner.ts` and verify the soul mount block was added correctly. Then verify the directory exists:

```bash
ls -la ~/nanoclaw-data/soul/SOUL.md
```

If the file exists but the agent ignores it, clear the cache and restart:

```bash
for d in ~/nanoclaw/data/sessions/*/agent-runner-src; do rm -rf "$d"; done
systemctl --user restart nanoclaw
```

### Agent personality unchanged after deploying SOUL.md

The CLAUDE.md was not updated. Verify the first line after the title references SOUL.md:

```bash
head -5 ~/nanoclaw/groups/*/CLAUDE.md
```

### Agent tries to modify SOUL.md

The mount should be read-only. Verify with `docker inspect`. If the mount is read-write, fix the `readonly: true` flag in `src/container-runner.ts`, rebuild, and restart.

### Weekly summary does not include soul proposals

The "Soul Update Proposals" section instructions are in the main group's `CLAUDE.md`. Check that the weekly summary scheduled task is still active:

```bash
sqlite3 ~/nanoclaw/store/messages.db "SELECT id, schedule_value, status FROM scheduled_tasks WHERE schedule_type='cron';"
```

### SOUL.md changes not reflected after manual edit

After editing SOUL.md on the host, the change is immediate for new containers — no rebuild needed, no cache to clear. The file is bind-mounted directly. If the agent still shows old behavior, it may be running in a long-lived session. Force a new session:

```bash
docker stop $(docker ps --format "{{.Names}}" | grep -i "$(sqlite3 ~/nanoclaw/store/messages.db 'SELECT name FROM registered_groups WHERE is_main=1;')")
```

## After Setup

The SOUL.md file is designed to be stable. Edit it only when applying approved proposals from the weekly summary. After editing:

1. No rebuild needed — the bind mount picks up changes immediately
2. No cache clear needed — SOUL.md is read from the mount, not from agent-runner-src
3. Force new containers if the agent is in a long session: stop the running container

To track SOUL.md evolution over time, consider committing it to git:

```bash
cd ~/nanoclaw
cp ~/nanoclaw-data/soul/SOUL.md docs/SOUL.md
git add docs/SOUL.md
git commit -m "soul: [description of change]"
```

## Removal

To remove the SOUL.md identity system:

1. Remove the soul mount block from `src/container-runner.ts` (`buildVolumeMounts`)
2. Remove references to `/workspace/extra/soul/SOUL.md` from all `groups/*/CLAUDE.md` files
3. Remove the "Soul Update Proposals" section from the main group's `CLAUDE.md`
4. Optionally delete `~/nanoclaw-data/soul/`
5. Clear the agent-runner cache: `rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src`
6. Rebuild and restart:
   ```bash
   npm run build
   systemctl --user restart nanoclaw
   ```
