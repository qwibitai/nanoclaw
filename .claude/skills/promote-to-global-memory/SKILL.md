---
name: promote-to-global-memory
description: Promote local agent mnemon memories to the global shared store, then clear the promoted entries from the local DB. Skips entries that conflict with existing global memories and flags them for review.
---

# Promote Local Memories to Global

Promotes memories from a group's local mnemon DB to the shared global mnemon store, then clears the promoted entries locally (since local agents already have read-only access to global). Conflicts are flagged but never overwritten.

## When to Use

- A fact learned in one group (e.g. a family member's birthday) is universally true and should be available to all agents
- A group's local DB has grown and you want to consolidate important memories globally
- You want to deduplicate — remove local memories that are redundant once in global

## Invocation

```
/promote-to-global [group]
```

- `[group]` — folder name of the group to promote from (e.g. `whatsapp_dad-mark-dave`). If omitted, promote from all registered groups.

## What Gets Promoted

Only memories in these categories are promoted (universally applicable):
- `fact` — objective facts about people, places, events
- `preference` — user preferences that apply everywhere

Skipped categories (group-specific, not globally meaningful):
- `context` — situational state
- `decision` — group-specific decisions
- `insight` — derived reasoning, may be context-dependent
- `general` — catch-all, too ambiguous

Minimum importance threshold: **4** (important or critical). Memories with importance ≤ 3 are not promoted.

## Steps

### 1. Identify groups to process

```bash
# Get all registered groups from the DB
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db', {readonly: true});
const rows = db.prepare('SELECT jid, name, folder FROM registered_groups').all();
console.log(JSON.stringify(rows, null, 2));
"
```

If a specific group was given, filter to just that one.

### 2. Read local memories (promotable only)

For each group, query the local DB directly (mnemon recall doesn't support category+importance filters well):

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/sessions/FOLDER/.mnemon/data/default/mnemon.db', {readonly: true});
const rows = db.prepare(\`
  SELECT id, content, category, importance, tags, entities, source
  FROM insights
  WHERE deleted_at IS NULL
    AND category IN ('fact', 'preference')
    AND importance >= 4
  ORDER BY importance DESC, created_at ASC
\`).all();
console.log(JSON.stringify(rows, null, 2));
"
```

### 3. Read global memories for conflict detection

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('groups/global/.mnemon/data/default/mnemon.db', {readonly: true});
const rows = db.prepare('SELECT id, content, category, importance FROM insights WHERE deleted_at IS NULL').all();
console.log(JSON.stringify(rows, null, 2));
"
```

### 4. Classify each local memory

For each local memory, compare against global entries. Use semantic judgment to determine if:

- **No match** → promote (write to global, then forget locally)
- **Identical or near-identical** → skip promotion (already in global), forget locally (it's redundant)
- **Conflict** (global says X, local says Y on the same fact) → skip promotion, flag for review, do NOT forget locally

A conflict means the content is about the same entity/fact but disagrees. Example:
- Global: "Mark has two children"
- Local: "Mark has three children: Erin, Ethan, Matthew"
→ Conflict — flag it, don't touch either

### 5. Write promoted memories to global

For each memory classified as "promote":

```bash
mnemon remember "CONTENT" \
  --data-dir groups/global/.mnemon \
  --cat CATEGORY \
  --imp IMPORTANCE \
  --tags "TAG1,TAG2" \
  --source agent
```

### 6. Forget promoted memories locally

After successfully writing to global, soft-delete the local copy:

```bash
mnemon forget ID --data-dir data/sessions/FOLDER/.mnemon
```

For near-identical duplicates (already in global): forget locally without writing to global.

### 7. Report results

Print a summary:

```
Group: whatsapp_dad-mark-dave
  Promoted: 3 memories
  Skipped (already in global): 1
  Conflicts flagged: 1

Conflicts requiring review:
  [whatsapp_dad-mark-dave] "Mark has three children: Erin, Ethan, Matthew"
  ↔ Global says: "Mark has two children"
  → To resolve: mnemon remember "corrected fact" --data-dir groups/global/.mnemon --imp 5
    then: mnemon forget GLOBAL_ID --data-dir groups/global/.mnemon
```

## Notes

- Global mnemon is at `groups/global/.mnemon/`
- Local mnemon is at `data/sessions/FOLDER/.mnemon/`
- The global DB is mounted read-only inside containers — only the host (Claude Code) can write to it
- `mnemon forget` is a soft-delete; the record stays in the DB with `deleted_at` set, excluded from all queries
- Do not promote memories about internal tooling, debugging, or nanoclaw-specific facts — those are not universally useful
