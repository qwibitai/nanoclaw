# Shared Rules (All Agents)

Read this file at session start. These rules apply to every agent in the system.

---

## Runtime Environment

You run on a **Linux VPS** (Ubuntu) as user `nanoclaw` (uid=999, gid=987). The service is managed by **systemd** (`systemctl restart nanoclaw`). There is NO Apple Container, NO Docker on the host, NO `launchctl`. This is process-runner mode.

**Key constraint**: Source files in `src/` are owned by root. You CANNOT edit them directly. When you need code changes, describe the exact changes needed (file, line, old text, new text) and the coordinator/admin will apply them. Do NOT create shell scripts with sed/python patches — they are fragile and error-prone.

### Workspace Paths

| Path | Purpose | Access |
|------|---------|--------|
| `/root/nanoclaw/groups/{your-folder}/` | Your workspace | read-write |
| `/root/nanoclaw/groups/global/` | Shared across agents | read-write |
| `/root/nanoclaw/data/ipc/{your-folder}/` | IPC files | read-write |
| `/root/nanoclaw/src/` | Source code | **read-only** (root-owned) |

---

## Quality Assurance Rules

Before delivering any code, scripts, patches, or review results:

1. **Test before delivering**: Run `bash -n script.sh` for shell scripts. Execute code in your sandbox before claiming it works. If you can't test it (e.g., needs root), say so explicitly.

2. **Verify platform**: You are on Linux VPS with systemd. Never reference macOS (`launchctl`, `open -a`), Apple Container (`container run/stop/rm`), or Docker unless explicitly asked.

3. **No fragile patches**: Do NOT create shell scripts that use `sed -i` or Python heredocs to patch source files. Instead, describe the exact change: file path, the old text to find, the new text to replace it with.

4. **Check your assumptions**: Before writing code that interacts with the system, read the relevant source files first. Don't assume APIs, paths, or command names.

5. **Declare limitations**: If you can't do something (e.g., edit root-owned files, restart services), say so clearly. Don't create workarounds that you haven't tested.

6. **Self-review checklist** before delivering:
   - [ ] Did I test this? If not, did I say so?
   - [ ] Does this match the actual platform (Linux VPS, systemd)?
   - [ ] Are file paths correct and verified?
   - [ ] Will this break if the source code has been updated since I last read it?

---

## Memory System

Memory flows through a pipeline. You write fast, the system curates later.

```
Conversation → Daily Note (fast dump) → Consolidation (every 15 days) → Topic Files (curated) → memory.md (index)
```

### Directory structure

```
{your-workspace}/
  memory.md                  ← index: links to topic files + last consolidated date
  memory/
    daily/
      2026-02-17.md          ← today's raw notes (append-only, unstructured)
      2026-02-16.md          ← yesterday's notes
      ...
    topics/
      projects.md            ← curated: active + completed projects
      decisions.md           ← curated: key decisions and rationale
      lessons.md             ← curated: lessons learned, gotchas
      people.md              ← curated: contacts, preferences, team info
      pending.md             ← curated: ideas for later, follow-ups
      credentials.md         ← curated: accounts, tokens (if applicable)
```

### Layer 1: Daily Notes (`memory/daily/YYYY-MM-DD.md`)

This is your **scratch pad**. During work and before compaction, dump everything here fast. No need to categorize — just write.

Format:
```markdown
# 2026-02-17

## Session 1
- Worked on GOV-42 auth middleware
- Decision: chose JWT over sessions (stateless scales better)
- Gotcha: Node spawn() with uid/gid doesn't set supplementary groups
- Blocker: need OPENAI_API_KEY in .env
- Met with João — prefers WhatsApp, timezone BRT
- Idea: add rate limiting to the broker

## Session 2
- Resolved blocker, key added to .env
- GOV-42 complete, moved to REVIEW
```

Rules:
- One file per day, named `YYYY-MM-DD.md`
- Append new sessions at the bottom
- No structure required — bullet points are fine
- **Speed over polish** — the consolidation process will curate later

### Layer 2: Topic Files (`memory/topics/*.md`)

These are **curated** reference files that agents read at session start. They are **ONLY updated during consolidation**, never during regular work.

Rules:
- Each file stays under ~100 lines. If it grows too large, split (e.g., `lessons-auth.md`, `lessons-platform.md`)
- Newest entries at the top
- Date every entry: `### 2026-02-17: Title`
- Only confirmed facts — no speculation
- Remove outdated entries during consolidation

### Layer 3: memory.md (Index)

Lists topic files and their last-updated dates. No content — just links.

---

## Compaction & Session End Protocol

**CRITICAL**: Before your context is compacted or your session ends:

1. **Update `working.md`** — current task status, what you were doing, what's left, blockers
2. **Append to today's daily note** (`memory/daily/YYYY-MM-DD.md`) — dump everything important:
   - What you worked on
   - Decisions made and why
   - Problems encountered and solutions
   - Gotchas or surprises
   - People you interacted with
   - Ideas for later
   - Use the session format shown above
3. **Call `store_memory()`** — for critical lessons and decisions, also store via MCP for cross-agent search. Always include `source_ref` with the task ID

That's it. **Do NOT update topic files during compaction** — the consolidation process handles that.

### Memory tags convention (for `store_memory()`)

- `["pattern", "topic"]` — reusable solution
- `["gotcha", "topic"]` — unexpected behavior
- `["decision", "topic"]` — why one approach over another
- `["finding", "topic"]` — security or code quality finding

---

## Consolidation (Every 15 Days)

The coordinator (Flux) triggers consolidation for each agent. The consolidation process:

1. Read all daily notes since last consolidation
2. Extract and categorize information into topic files:

| From daily notes | Route to |
|-----------------|----------|
| Project progress, completions | `topics/projects.md` |
| Decisions and rationale | `topics/decisions.md` |
| Lessons, gotchas, surprises | `topics/lessons.md` |
| People, contacts, preferences | `topics/people.md` |
| Ideas, follow-ups, pending | `topics/pending.md` |
| Credentials, accounts | `topics/credentials.md` |

3. Remove outdated entries from topic files (completed projects, resolved items)
4. Archive processed daily notes (move to `memory/daily/archive/` or delete if >30 days old)
5. Update `memory.md` index with new dates

### At session start

1. Read `memory.md` (the index)
2. Read topic files relevant to your current task (not all of them)
3. Optionally read recent daily notes for fresh context

---

## Credentials & Secrets

Secrets are stored in two tiers based on risk level. **NEVER store passwords or tokens in plain text files.**

### Tier 1: `pass` (agent-accessible)

Low-risk credentials that agents can access directly. Stored in GPG-encrypted vault via `pass` (available to the `nanoclaw` user).

```bash
pass show flux/email-password    # retrieve a secret
pass ls                          # list all stored secrets
echo 'value' | pass insert -e path/to/secret   # store a new secret
```

Use for: agent email accounts, test credentials, low-risk service logins.

### Tier 2: External Access Broker (agent never sees)

High-risk credentials handled by the broker. Agent calls `ext_call()`, broker injects the real token on the host side.

Use for: `GITHUB_TOKEN`, `OPENAI_API_KEY`, production databases, financial APIs, OAuth admin tokens.

### Classification rules

| If the credential... | Tier | Why |
|----------------------|------|-----|
| Was created specifically for an agent | T1 | Compromise is contained, easy to rotate |
| Can spend money (API billing) | T2 | Financial risk |
| Grants access to private repos/data | T2 | Data breach risk |
| Is a test/staging credential | T1 | Low blast radius |
| Is a production deploy key | T2 | Production risk |
| Is someone's personal password | T2 | Identity risk |

### Rules

1. **Never store T2 secrets in `pass`** — they go in `.env` or root-only files, accessed via broker
2. **Never store ANY secret in memory files** (daily notes, topic files, conversations)
3. **If you receive a credential in chat**, immediately store it in `pass` (T1) and delete the plain text reference
4. **Rotate if exposed** — if a credential appears in a log or plain text file, rotate it immediately
