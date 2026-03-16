# NanoClaw Search — Implementation Plan
*Inspired by QMD (github.com/tobi/qmd) — Skill-based, Deterministically Isolated*

---

## 1. Problem & Motivation

When users ask the bot about past conversations — "what did we say about that Japanese architecture office?" — the bot fails. It has no access to message history because:

- Agent containers cannot access `messages.db` (it is shadowed to `/dev/null` for all non-main containers)
- There is no search index of any kind
- Memory is only as good as what the agent explicitly saved to files in the session

The solution must satisfy three hard constraints Bruno defined:

1. **No MCP tools** — use the skill/CLI pattern already established by `agent-browser` and `fal-image`
2. **Deterministic isolation** — a group must be physically incapable of reading another group's messages. Not enforced by code logic (which can have bugs), but by the data simply not existing in the filesystem of the wrong container
3. **QMD-style collections** — each group can create named document collections (markdown, PDFs, text files) that become searchable alongside message history

---

## 2. Design Philosophy — Why This Approach

### Why not a centralized search service?

A central HTTP service (the first approach considered) would hold all groups' data in one place and enforce isolation via code (`WHERE chat_jid = ?`). This is a *soft* barrier — a bug, a missing WHERE clause, or a future code change could leak data. Bruno explicitly rejected this.

### Why not MCP?

The existing MCP tools in `ipc-mcp-stdio.ts` are powerful but tightly coupled to the NanoClaw runtime. Skills are more portable, more auditable (they're just SKILL.md docs + CLI scripts), and already used for the most capable tools (`agent-browser`). A skill is the right abstraction for a capability the agent invokes on demand.

### Why `search.db` per group folder?

Each group's container has exactly one read-write mount: `/workspace/group` → `groups/{folder}/`. The container-runner hardcodes this. By placing the search index inside the group folder, we guarantee:

- The container can access it (it's in its own folder)
- The container CANNOT access any other group's index (those folders are not mounted)
- No allowlist configuration required
- No security code to maintain or audit

This is the same principle as filesystem permissions — we use the OS/container boundary as the security primitive, not application logic.

### Why QMD's hybrid approach (BM25 + vectors)?

- **BM25 alone** handles exact/near-exact keyword matches well, but fails on semantic queries ("discussão sobre minimalismo" won't find "clean lines and negative space")
- **Vectors alone** can miss exact matches and require model loading
- **Hybrid + RRF** gives the best of both worlds: instant BM25 results + semantic ranking

For v1 we ship BM25 only (zero new dependencies, works immediately). Vectors are a v2 upgrade path built into the schema from day one.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  HOST PROCESS (NanoClaw main)                           │
│                                                         │
│  src/search-exporter.ts                                 │
│  ├── On startup: create search.db for every group       │
│  ├── On new message: immediately export to group's db   │
│  └── Background loop (30s): sync any missed messages    │
│                                                         │
│  groups/whatsapp_zibot/search.db  ← ZiBot messages only │
│  groups/whatsapp_delbot/search.db ← DelBot messages only│
│  groups/whatsapp_main/search.db   ← Main messages only  │
└─────────────────────────────────────────────────────────┘
              │ physical filesystem boundary │
┌─────────────────────────────────────────────────────────┐
│  CONTAINER (e.g. ZiBot)                                 │
│  /workspace/group/ ← ONLY groups/whatsapp_zibot/        │
│                                                         │
│  Bash: qsearch "Japanese architecture"                  │
│    → reads /workspace/group/search.db                   │
│    → FTS5 BM25 query → ranked results                   │
│    → prints to stdout → agent reads and uses            │
│                                                         │
│  Bash: qsearch index --collection=brief ./collections/  │
│    → indexes local markdown files into search.db        │
│    → future: qsearch --collection=brief "topic"         │
└─────────────────────────────────────────────────────────┘
```

---

## 4. search.db Schema

Each group folder gets a `search.db` with this schema:

```sql
-- Metadata / sync cursor
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- key: 'last_exported_timestamp' — tracks incremental sync

-- Messages exported from the main messages.db
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  sender_name TEXT NOT NULL,
  content     TEXT NOT NULL,
  timestamp   TEXT NOT NULL,   -- ISO 8601
  is_from_me  INTEGER NOT NULL DEFAULT 0
);

-- FTS5 index for BM25 keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  sender_name,
  content='messages',       -- content table (no data duplication)
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, sender_name)
  VALUES (new.rowid, new.content, new.sender_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
  VALUES ('delete', old.rowid, old.content, old.sender_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
  VALUES ('delete', old.rowid, old.content, old.sender_name);
  INSERT INTO messages_fts(rowid, content, sender_name)
  VALUES (new.rowid, new.content, new.sender_name);
END;

-- Collections: named sets of documents the group indexes
CREATE TABLE IF NOT EXISTS collections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,     -- collection name, e.g. "brief", "notes"
  source_path TEXT NOT NULL,     -- original file path
  title       TEXT NOT NULL,     -- filename or first heading
  content     TEXT NOT NULL,     -- full text content
  updated_at  TEXT NOT NULL,     -- ISO 8601
  UNIQUE(name, source_path)      -- Prevent duplicate indexing
);
CREATE VIRTUAL TABLE IF NOT EXISTS collections_fts USING fts5(
  title,
  content,
  content='collections',
  content_rowid='rowid'
);
-- (same ai/ad/au triggers for collections_fts)

-- v2: vector embeddings table (schema ready, not populated in v1)
-- CREATE VIRTUAL TABLE IF NOT EXISTS message_vectors USING vec0(
--   message_rowid INTEGER PRIMARY KEY,
--   embedding FLOAT[384]
-- );
```

---

## 5. Host-Side: `src/search-exporter.ts`

### Responsibilities
- Create and maintain `search.db` for every registered group
- Export messages from the main `messages.db` into each group's `search.db`
- Keep indexes up to date in near-real-time

### Key functions

```typescript
// Called once in main() after DB init
export function startSearchExporter(db: Database): void

// Called from onMessage hook for real-time indexing
export function exportMessage(groupFolder: string, msg: StoredMessage): void

// Internal: run full sync for one group (used at startup + 30s loop)
function syncGroup(groupFolder: string, chatJid: string): void
```

### Sync logic

```typescript
function syncGroup(groupFolder: string, chatJid: string): void {
  const searchDbPath = path.join(GROUPS_DIR, groupFolder, 'search.db');
  const searchDb = openSearchDb(searchDbPath); // opens or creates

  const lastTs = searchDb
    .prepare("SELECT value FROM meta WHERE key = 'last_exported_timestamp'")
    .get()?.value ?? '';

  // Read from main messages.db (read-only connection)
  const rows = mainDb.prepare(`
    SELECT id, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ?
      AND timestamp > ?
      AND is_bot_message = 0
      AND content != ''
      AND length(content) > 2
    ORDER BY timestamp ASC
    LIMIT 500
  `).all(chatJid, lastTs);

  const insert = searchDb.prepare(`
    INSERT OR IGNORE INTO messages (id, sender_name, content, timestamp)
    VALUES (@id, @sender_name, @content, @timestamp)
  `);

  const upsertMeta = searchDb.prepare(`
    INSERT OR REPLACE INTO meta (key, value) VALUES ('last_exported_timestamp', ?)
  `);

  const insertMany = searchDb.transaction((rows) => {
    for (const row of rows) insert.run(row);
    if (rows.length > 0) {
      upsertMeta.run(rows[rows.length - 1].timestamp);
    }
  });

  insertMany(rows);

  // If 500 rows returned, there may be more — schedule another pass
  if (rows.length === 500) {
    setImmediate(() => syncGroup(groupFolder, chatJid));
  }
}
```

The 30-second background loop simply calls `syncGroup` for all registered groups. Real-time hook calls `exportMessage` which is a thin wrapper that inserts a single message immediately.

---

## 6. Container-Side: `qsearch` CLI

### Location & distribution
- Source: `container/skills/search/qsearch` (Node.js script, shebang `#!/usr/bin/env node`)
- Container path: `/usr/local/bin/qsearch` (installed in Dockerfile)
- Skill doc: `container/skills/search/SKILL.md`

### CLI interface

```
qsearch [options] <query>
qsearch collections
qsearch index --collection=<name> <path>
qsearch rm --collection=<name> [path]
```

**Options:**
- `--top=N` — max results (default: 10, max: 50)
- `--offset=N` — pagination offset (default: 0)
- `--collection=<name>` — search a named collection instead of messages

**Search command:**
```bash
qsearch "Japanese architecture office"
qsearch --top=20 "orçamento da Gávea"
```

**List collections:**
```bash
qsearch collections
# Output:
# Available collections:
# • brief (42 documents)
# • meeting-notes (8 documents)
```

**Index a collection:**
```bash
qsearch index --collection=brief /workspace/group/collections/brief/
# Output:
# Indexed 42 files into collection 'brief'
# • gavea_architecture_brief.md (4,201 chars)
# • client_feedback.pdf (6,302 chars)
# ...
```

### Supported Formats
As a quick win for v1, the indexer supports:
- `.md`, `.txt`, `.csv` (raw text)
- `.pdf` (via `pdf-parse`, pure JS, no native deps)
- `.docx` (via `mammoth`, pure JS, no native deps)

### Search implementation (qsearch script internals)

```javascript
#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = '/workspace/group/search.db';

function search(query, collection, topN) {
  if (!fs.existsSync(DB_PATH)) {
    console.error('Search index not available yet. Try again in a moment.');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });

  // Sanitize query for FTS5 (escape special chars)
  const ftsQuery = query.replace(/[^\w\s\u00C0-\u024F]/g, ' ').trim();

  let rows;
  if (collection) {
    rows = db.prepare(`
      SELECT c.title, c.content, c.source_path, bm25(collections_fts) AS score
      FROM collections_fts
      JOIN collections c ON c.rowid = collections_fts.rowid
      WHERE collections_fts MATCH ? AND c.name = ?
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, collection, topN);

    if (rows.length === 0) {
      console.log(`No results in collection '${collection}' for: "${query}"`);
      return;
    }
    console.log(`Found ${rows.length} result(s) in '${collection}' for "${query}":\n`);
    for (const row of rows) {
      const snippet = row.content.slice(0, 300).replace(/\n+/g, ' ');
      console.log(`[${row.title}]\n${snippet}...\n`);
    }
  } else {
    rows = db.prepare(`
      SELECT m.sender_name, m.content, m.timestamp, bm25(messages_fts) AS score
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, topN);

    if (rows.length === 0) {
      console.log(`No results found for: "${query}"`);
      return;
    }
    console.log(`Found ${rows.length} result(s) for "${query}":\n`);
    for (const row of rows) {
      const date = new Date(row.timestamp).toLocaleString('en-CA', {
        timeZone: process.env.TZ || 'UTC',
        dateStyle: 'short', timeStyle: 'short'
      });
      console.log(`[${date}] ${row.sender_name}:\n${row.content}\n`);
    }
  }
}

// ... (index and collections commands similarly straightforward)
```

### Dependency note
`better-sqlite3` is already used in the main process but is NOT currently installed in the container. Two options:
1. Add `better-sqlite3` to `container/package.json` (preferred — consistent with host)
2. Bundle a compiled native binary in the skills folder

Option 1 requires adding it to the Dockerfile's npm install step.

---

## 7. `container/skills/search/SKILL.md`

```markdown
---
name: search
description: Search past conversation history and named document collections using keyword search (BM25).
allowed-tools: Bash(qsearch:*)
---

# Search Skill

Search past messages and document collections with the `qsearch` CLI.

## Searching messages

qsearch "Japanese architecture office"
qsearch --top=20 "orçamento Gávea"

Results show [date] sender: content for each match.

## Searching a collection

qsearch --collection=brief "minimalist design"

## Listing collections

qsearch collections

## Indexing a collection

1. First, create the physical files using standard Bash commands (e.g., `mkdir -p /workspace/group/collections/brief && cat << 'EOF' > ...`)
2. Then, run the indexer:
qsearch index --collection=brief /workspace/group/collections/brief/

Indexes all supported files (.md, .txt, .pdf, .docx) in the folder. Existing matching files in the index are updated, preserving data without duplicating.

## Removing from a collection

qsearch rm --collection=brief /workspace/group/collections/brief/old_notes.md
Removes specific files or entire collections from the index.

## When to use

Use this proactively:
- When a user shares important project details, create a file and index it immediately without asking.
- When a user asks about something from a past conversation.
- You want to search documents the group has shared.

Always try search before saying you don't remember something or asking the user to repeat information.
```

---

## 8. Changes to Existing Files

### `src/index.ts`
```typescript
// After DB init in main():
import { startSearchExporter, exportMessage } from './search-exporter.js';
startSearchExporter(db);

// In onMessage callback, after storeMessage(msg):
const group = getRegisteredGroup(msg.chatJid);
if (group) exportMessage(group.folder, msg);
```

### `src/config.ts`
No changes needed — search-exporter uses `GROUPS_DIR` already available.

### `container/Dockerfile`
```dockerfile
# Add better-sqlite3 and simple doc parsers to container deps
RUN npm install better-sqlite3 pdf-parse mammoth

# Install qsearch CLI
COPY container/skills/search/qsearch /usr/local/bin/qsearch
RUN chmod +x /usr/local/bin/qsearch
```

### `groups/global/CLAUDE.md` — append section:
```
## Searching Conversation History

Use the search skill to find past messages or document collections.

ALWAYS use this before saying you don't remember something. Be proactive: if a user shares important reference material, save it to a local markdown file and index it without asking for permission.

Commands:
• qsearch "topic" — search message history
• qsearch --top=20 --offset=20 "topic" — paginate results
• qsearch --collection=name "topic" — search a collection
• qsearch collections — list available collections
• qsearch index --collection=name /workspace/group/collections/name/ — index docs
• qsearch rm --collection=name [path] — unindex docs

Results include sender, date, and content.
```

---

## 9. New Files Summary

| File | Type | Purpose |
|------|------|---------|
| `src/search-exporter.ts` | TypeScript module | Host-side message export to per-group search.db |
| `container/skills/search/SKILL.md` | Skill doc | Declares qsearch tool for agent SDK |
| `container/skills/search/qsearch` | Node.js script | BM25 search + collection indexing CLI |
| `scripts/backfill-search.ts` | One-shot script | Populate search.db for all existing groups from `store/messages.db` |

---

## 10. Implementation Order & Dependencies

```
Step 1: src/search-exporter.ts
   └── No other code changes needed yet; can test independently

Step 2: src/index.ts (wire up exporter)
   └── Depends on Step 1

Step 3: npm run build + restart service
   └── search.db files begin appearing in group folders

Step 4: scripts/backfill-search.ts
   └── Needs to read ALL existing messages from `store/messages.db`
   └── Iterates through every group, loads all their past messages, and writes them to their respective `search.db`.
   └── This only needs to be run ONCE manually via `npx tsx scripts/backfill-search.ts`.

Step 5: container/skills/search/qsearch + SKILL.md
   └── Depends on Dockerfile change

Step 6: container/Dockerfile
   └── Add better-sqlite3, install qsearch

Step 7: groups/global/CLAUDE.md
   └── Document the skill

Step 8: npm run build + restart (picks up Dockerfile and global CLAUDE.md changes)
```

Steps 1-4 can go live before the container side is done — they just build the indexes silently.

---

## 11. v2 Upgrade Path (vectors)

The schema already has the `message_vectors` table commented out. When ready:

1. Add `sqlite-vec` to host `package.json` and load it in `search-exporter.ts`
2. Add `@xenova/transformers` with `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (quantized, ~120MB, Portuguese + English, CPU-only)
3. In `search-exporter.ts`: after FTS insert, generate embedding and insert into `message_vectors`
4. In `qsearch`: add vector search path + RRF merge with BM25 results
5. No schema migration needed — vec table already defined

RRF merge (15 lines):
```javascript
function rrf(bm25Rows, vecRows, k = 60) {
  const scores = new Map();
  const add = (id, rank) =>
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
  bm25Rows.forEach((r, i) => add(r.id, i));
  vecRows.forEach((r, i) => add(r.id, i));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
```

---

## 12. Security Summary

| Threat | Mitigation |
|--------|-----------|
| Group A reads Group B's messages | Group B's search.db is not mounted in Group A's container |
| Attacker modifies qsearch to path-traverse | qsearch hardcodes DB_PATH = '/workspace/group/search.db' |
| Container writes to wrong group | /workspace/group is always and only the container's own group |
| Future code change accidentally opens all data | No central data store exists — distributed by design |

The security is architectural, not code-enforced.
