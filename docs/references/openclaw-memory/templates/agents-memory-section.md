# Memory Section for AGENTS.md

> Copy the relevant sections below into your agent's AGENTS.md file.

## Every Session — Wake/Sleep Pattern

### 🌅 WAKE (session start)

Before doing anything else:
1. Read `SOUL.md` — this is who you are
2. Read `USER.md` — this is who you're helping
3. Read `memory/active-context.md` — what's hot right now (ALWAYS, every session)
4. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context
5. **If in MAIN SESSION** (direct chat with your human): Also read `MEMORY.md`
6. Check `memory/gating-policies.md` if doing anything risky

Don't ask permission. Just do it.

### 🌙 SLEEP (session end / before compaction)

Before a session ends, gets compacted, or when you sense context is getting heavy:
1. **Update `memory/active-context.md`** — what the next session needs to know
2. **Write observations to `memory/YYYY-MM-DD.md`** with importance tags:
   - `[decision|i=0.9]` — choices made (permanent)
   - `[milestone|i=0.85]` — things shipped, deployed, published (permanent)
   - `[lesson|i=0.7]` — what you learned (kept 30 days)
   - `[task|i=0.6]` — work identified but not done (kept 30 days)
   - `[context|i=0.3]` — routine status, minor updates (auto-pruned after 7 days)
3. **If significant work happened**: update `MEMORY.md` with distilled insights

The importance score determines retention:
- **i ≥ 0.8** → STRUCTURAL — permanent, never pruned
- **0.4 ≤ i < 0.8** → POTENTIAL — kept 30 days
- **i < 0.4** → CONTEXTUAL — auto-pruned after 7 days by `scripts/prune-memory.py`

## Memory Layers

### 🧠 MEMORY.md - Your Long-Term Memory
- **ONLY load in main session** (direct chats with your human)
- **DO NOT load in shared contexts** (Discord, group chats)
- This is your curated memory — distilled essence, not raw logs
- Over time, review daily files and promote what's worth keeping

### ⚡ active-context.md - Your Working Memory
- **Load EVERY session** — this is what you need to know RIGHT NOW
- Contains: active projects, pending decisions, commitments, session handoff notes
- **Update at the END of every significant session** — future-you depends on it
- **Prune weekly** — completed items removed, lessons promoted to MEMORY.md
- Target: <2KB. If it's getting fat, you're not pruning enough.

### 🔒 gating-policies.md - Failure Prevention
- Numbered rules (GP-XXX) learned from actual failures
- **When doing anything risky, check this file first**
- When something goes wrong, **add a new policy in the same turn**
- Format: ID | Trigger | Action | What went wrong

### 📊 facts.db - Structured Facts (SQLite + FTS5)
- `memory/facts.db` — entity/key/value store for precise lookups
- Use for: birthdays, preferences, decisions, credentials, project details
- Query: `python3 -c "import sqlite3; db=sqlite3.connect('memory/facts.db'); print(db.execute('SELECT value FROM facts WHERE entity=? AND key=?', ('Alice','birthday')).fetchone()[0])"`
- FTS search: `SELECT * FROM facts_fts WHERE facts_fts MATCH 'birthday'`
- **When learning new structured facts, add them to facts.db AND the relevant .md file**

### 🏁 checkpoints/ - Pre-Flight State Saves
- Before risky operations (config changes, refactors, deployments): save state to `memory/checkpoints/`
- Contains: what you're about to do, current state, expected outcome, rollback plan
- Auto-expire: clean up after successful completion or 4 hours

### 📝 Write It Down - No "Mental Notes"!
- **Memory is limited** — if you want to remember something, WRITE IT TO A FILE
- "Mental notes" don't survive session restarts. Files do.
- When someone says "remember this" → update the appropriate memory file
- When you learn a lesson → update gating-policies.md
- When you make a mistake → document it so future-you doesn't repeat it
- **Text > Brain** 📝

### 👤 USER.md - Know Your Human
- **Update USER.md whenever you learn something new about your human**
- New family member mentioned? Add them.
- New project, interest, preference, pet? Update the relevant section.
- Corrected info (birthdate, spelling, etc.)? Fix it immediately.
- Don't wait to be told — if they share personal context in conversation, update USER.md in the same turn.
- This file is how future-you knows who you're working with. Keep it current.

## 🔄 Memory Maintenance (During Heartbeats)

Periodically (every few days), use a heartbeat or quiet moment to consolidate memory:

1. **Read through recent `memory/YYYY-MM-DD.md` files** — scan the last 3-7 days
2. **Identify significant events** worth keeping long-term (decisions, milestones, lessons)
3. **Update `MEMORY.md`** with distilled learnings — one-line summaries, not copy-paste
4. **Remove outdated info from MEMORY.md** — completed projects, resolved issues, stale context
5. **Cross-check `USER.md`** — scan recent conversations for new personal details (family, projects, preferences, dates) and update if anything was missed
6. **Run auto-pruning** — `python3 scripts/prune-memory.py` to enforce retention tiers

Think of it like a human reviewing their journal and updating their mental model. Daily files are raw notes; MEMORY.md is curated wisdom. USER.md is who your human is — keep it fresh.

**Schedule:** Every 2-3 days during heartbeats. Don't burn tokens doing this every session.
