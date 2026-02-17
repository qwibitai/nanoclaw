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

## Compaction & Session End Protocol

**CRITICAL**: Before your context is compacted or your session ends, you MUST preserve your work:

1. **Update `working.md`** — current task status, what you were doing, what's left
2. **Route to category files** — save each piece of information to the correct `memory/` file:

| Category | Where to save | Example |
|----------|--------------|---------|
| Task progress | `working.md` | "Task GOV-42: implemented auth middleware, tests passing, needs review" |
| Decisions | `memory/decisions.md` | "### 2026-02-17: Chose JWT — stateless scales better" |
| Lessons/gotchas | `memory/lessons.md` | "### 2026-02-17: Node spawn() doesn't set supplementary groups" |
| Blockers | `working.md` | "Blocked on: need OPENAI_API_KEY in .env" |
| Ideas for later | `memory/pending.md` | "Consider adding rate limiting to the broker" |
| People/contacts | `memory/people.md` | "### João: prefers WhatsApp, timezone BRT" |
| Projects | `memory/projects.md` | "### 2026-02-17: Voice Transcription — installed" |

3. **Update `memory.md` index** — update the Last Updated column for any category file you changed
4. **Call `store_memory()`** — for lessons and decisions, also store via MCP for cross-agent search. Always include `source_ref` with the task ID

### Memory tags convention

- `["pattern", "topic"]` — reusable solution
- `["gotcha", "topic"]` — unexpected behavior
- `["decision", "topic"]` — why one approach over another
- `["finding", "topic"]` — security or code quality finding

---

## Memory Organization

Memory is split into category files inside a `memory/` folder. **NEVER** let a single file grow past ~100 lines — split further if needed.

### Required structure

```
{your-workspace}/
  memory.md              ← index: links to category files, last updated date
  memory/
    projects.md          ← active + recently completed projects
    decisions.md         ← key decisions and rationale
    lessons.md           ← lessons learned, gotchas, platform quirks
    people.md            ← contacts, preferences, team info
    pending.md           ← pending items, ideas for later, follow-ups
    credentials.md       ← credentials, tokens, accounts (if applicable)
```

### Rules

1. **`memory.md` is an index only** — it lists category files and their last-updated dates. No content beyond links and a 1-line summary per category.
2. **One topic per category file** — don't mix projects with lessons. If a category grows too large, split it (e.g., `lessons-auth.md`, `lessons-platform.md`).
3. **Append, don't rewrite** — add new entries at the top of each file (newest first). Only remove entries when they're confirmed outdated.
4. **Date every entry** — `### 2026-02-17: Title` format. This helps identify stale entries.
5. **Keep it factual** — no speculation. Only record confirmed facts, tested solutions, and verified decisions.
6. **Compaction extracts go to category files** — when following the Compaction Protocol, route each piece of information to the correct category file, not to memory.md.

### At session start

Read `memory.md` (the index), then read the category files relevant to your current task. You don't need to read all categories every time — just the ones that matter.
