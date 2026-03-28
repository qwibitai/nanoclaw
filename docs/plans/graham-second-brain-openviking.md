# Second Brain OS: OpenViking + NanoClaw Integration

## Context

Morgan's second brain (`~/.SB_PERSONAL`) uses the PARA method. The goal is to add OpenViking — a context database for AI agents with semantic search, hierarchical retrieval, and memory lifecycle — so a dedicated agent can effectively search, retrieve, and manage the second brain over time.

**Key constraint**: NanoClaw spins up ephemeral agent containers per-message. OpenViking is a persistent server that needs to index files and maintain state. Solution: run OpenViking as a **persistent sidecar container**, not embedded in the agent image.

**Ownership model**: A dedicated `graham-second-brain` agent owns the second brain for search and retrieval. Any agent that needs to store information can write directly to the `~/.SB_PERSONAL` filesystem mount — they don't need OpenViking access. Only `graham-second-brain` has `ovcli` and can query the index. Other agents route through `graham-second-brain` via NanoClaw IPC when they need second brain lookups.

**Two-copy model**: The filesystem (`~/.SB_PERSONAL`) is the source of truth — git-synced, human-editable, permanent. OpenViking's workspace is a derived enriched index (L0/L1/L2 summaries, vector embeddings, relations) stored in a Docker named volume. It's a cache that can be rebuilt from the source at any time.

## Architecture

```
NanoClaw Host
    │
    ├─ sb-openviking container (always running, port 1933)
    │       │
    │       ├─ ov.conf ──▶ mounted from ~/.openviking/ov.conf (host machine)
    │       ├─ R/O mount ──▶ ~/.SB_PERSONAL at /workspace/sb
    │       │                  (watches for changes every 2 mins, incremental re-index)
    │       └─ named volume ──▶ openviking-data at /app/data
    │                            (AGFS workspace: L0/L1/L2 + vectors)
    │
    ├─ spawns per-message ──▶  graham-second-brain container
    │                              │
    │                              ├─ R/W mount ──▶ ~/.SB_PERSONAL
    │                              │                  (writes notes, creates folders)
    │                              │
    │                              ├─ ovcli (installed via uv sync from group pyproject.toml)
    │                              │   └─ configured via mounted ~/.openviking/ovcli.conf (host machine)
    │                              │       (points to sb-openviking server + API key)
    │                              │
    │                              └─ ovcli ──▶ sb-openviking (search + immediate index of own writes)
    │
    ├─ spawns per-message ──▶  nanoclaw-agent container (main / graham)
    │                              │
    │                              ├─ R/W mount ──▶ ~/.SB_PERSONAL
    │                              │                  (can write notes — auto-synced to OV in ≤2 mins)
    │                              │
    │                              └─ NO ovcli, NO OpenViking access
    │                                 (routes search queries via graham-second-brain IPC)
    │
    ├─ spawns per-message ──▶  nanoclaw-agent container (whatsapp_*)
    │                              │
    │                              ├─ R/W mount ──▶ ~/.SB_PERSONAL (can write, auto-synced)
    │                              └─ NO ovcli (routes search via IPC)
    │
    └─ spawns per-message ──▶  nanoclaw-agent container (gmail_*)
                                   │
                                   ├─ R/W mount ──▶ ~/.SB_PERSONAL (can write, auto-synced)
                                   └─ NO ovcli (routes search via IPC)
```

### Access model

| Agent | Filesystem mount | ovcli / OpenViking | Role |
|---|---|---|---|
| `graham-second-brain` | R/W | Yes | Writes notes AND searches. Indexes own writes immediately. |
| `graham` (main) | R/W | No | Can write notes. Auto-synced to OV in ≤2 mins. Routes search via IPC. |
| Other agents | R/W | No | Can write notes. Auto-synced to OV in ≤2 mins. Routes search via IPC. |

### Data flow: Writing a new note (any agent)

1. Agent receives information (from Morgan, WhatsApp, etc. via IPC)
2. Agent determines the right PARA location
3. Agent writes the file to the R/W mount at `/workspace/extra/.SB_PERSONAL/`
4. OpenViking's `watch_interval` (2 mins) detects the change and auto-indexes it

### Data flow: Writing a new note (second-brain agent)

1–3. Same as above
4. Agent also indexes immediately via `ovcli`: `ov add-resource <file-path> --target viking://resources/<PARA-path>/ --reason "<context>" --instruction "<ingestion instruction>"`
5. OpenViking parses the file, generates L0/L1/L2 summaries via VLM, and updates the vector index

### Data flow: Searching / retrieving (progressive L0→L2)

1. Agent receives a query (from Morgan or another agent via IPC)
2. Agent invokes the `sb-search` skill which:
   a. Checks `viking://user/memories/` for retrieval hints relevant to the query
   b. Searches resources via `ov find "<query>" --uri viking://resources/` (optionally scoped to PARA category)
   c. Loads L0 abstracts (`/api/v1/content/abstract`) for top results — cheap relevance filtering
   d. For relevant hits, loads L2 full content (`/api/v1/content/read`) — only for what's needed
   e. Uses L1 overviews (`/api/v1/content/overview`) when the user wants summaries rather than full content
3. Agent formats and returns the response
4. Optionally, agent proposes a Viking memory if something non-obvious was learned (waits for Morgan's confirmation before writing)

### Data flow: Auto-sync (all changes)

The initial bulk ingest sets `watch_interval: 2` (minutes) on the root resource. OpenViking periodically re-scans the mounted `~/.SB_PERSONAL` directory and performs incremental updates — unchanged files reuse existing L0 summaries and skip vectorization. This is the universal sync mechanism that catches:
- Writes from any agent (main, WhatsApp, Gmail, etc.)
- Git syncs (pulls from other devices)
- Manual edits
- Any other external changes

When no files have changed, the cycle costs nothing — just a local filesystem walk. When files change, only the changed files trigger VLM summarization and re-embedding (fractions of a cent per file via `gpt-4o-mini` + `text-embedding-3-large`).

The `graham-second-brain` agent additionally indexes its own writes immediately via `ovcli` so its search results are up-to-date within the same conversation.

## Part 1: OpenViking Sidecar Setup

### 1a. Server configuration (ov.conf)

**New file**: `~/.openviking/ov.conf` (host machine, outside any synced repo)

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 1933,
    "root_api_key": "<generate-a-secret>"
  },
  "storage": {
    "workspace": "/app/data"
  },
  "embedding": {
    "dense": {
      "provider": "openai",
      "api_key": "<openai-api-key>",
      "model": "text-embedding-3-large",
      "dimension": 3072
    }
  },
  "vlm": {
    "provider": "openai",
    "api_key": "<openai-api-key>",
    "model": "gpt-4o-mini",
    "temperature": 0.1
  }
}
```

Notes:
- `text-embedding-3-large` (3072 dimensions) for semantic search during ingestion.
- `gpt-4o-mini` for VLM — generates L0/L1 summaries at ingestion time. Cheap and fast; only runs on ingest, not retrieval.
- `root_api_key` enforces auth between the agent and OpenViking. Other agents can't call it even if they discover the port.
- `workspace` must be the container-internal path (`/app/data`), not the host path.

### 1b. Docker Compose

**New file**: `~/.SB_PERSONAL/docker-compose.yml`

```yaml
services:
  openviking:
    image: ghcr.io/volcengine/openviking:main
    container_name: sb-openviking
    restart: unless-stopped
    ports:
      - "127.0.0.1:1933:1933"
    volumes:
      - ~/.openviking/ov.conf:/app/ov.conf:ro
      - openviking-data:/app/data
      - ~/.SB_PERSONAL:/workspace/sb:ro
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:1933/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  openviking-data:
```

Notes:
- `ov.conf` mounted from `~/.openviking/` on the host machine (not from the synced repo) — credentials stay on the machine.
- `openviking-data` named volume at `/app/data` — persists AGFS workspace (L0/L1/L2 summaries, vector index, relations) across restarts. This is derived data, rebuildable from source.
- `~/.SB_PERSONAL` mounted read-only at `/workspace/sb` — OpenViking watches this every 2 minutes for changes. This is the auto-sync mechanism for all agent writes, git syncs, and manual edits.
- Port bound to `127.0.0.1` only — not exposed externally.

### 1c. Client configuration (ovcli.conf)

**New file**: `~/.openviking/ovcli.conf` (host machine, same directory as ov.conf)

```json
{
  "url": "http://host.docker.internal:1933",
  "api_key": "<must-match-root_api_key-in-ov.conf>"
}
```

This file is mounted into the `graham-second-brain` agent container so `ovcli` can communicate with the OpenViking server. The `api_key` must match `root_api_key` exactly. It lives on the host machine at `~/.openviking/`, not in the synced repo.

### 1d. No `.gitignore` changes needed for config

Since `ov.conf` and `ovcli.conf` now live at `~/.openviking/` on the host machine (not inside `~/.SB_PERSONAL`), no gitignore changes are needed for credentials. The `docker-compose.yml` in `~/.SB_PERSONAL` is safe to commit — it references the host paths via `~/.openviking/`.

### 1e. Initial bulk ingest

After `docker compose up -d` and healthcheck passes:

```bash
# From inside the OpenViking container (which has the R/O mount):
docker exec sb-openviking ov add-resource /workspace/sb/ \
  --target viking://resources/ \
  --reason "Initial PARA second brain ingest" \
  --instruction "This is a personal knowledge base using the PARA method (Projects, Areas, Resources, Archives). Preserve the category context in summaries. Emphasize actionable information, deadlines, relationships between topics, and personal opinions/decisions." \
  --watch-interval 2 \
  --wait
```

This indexes the entire PARA tree under `viking://resources/`, mirroring the directory structure:
- `viking://resources/1. Projects/`
- `viking://resources/2. Areas/`
- `viking://resources/3. Resources/`
- `viking://resources/4. Archives/`

The `watch_interval: 2` means OpenViking re-scans the source every 2 minutes, picking up all changes (agent writes, git syncs, manual edits) via incremental differential updates (unchanged files are skipped). When nothing has changed, the cycle costs nothing — just a local filesystem walk.

## Part 2: NanoClaw Integration

### 2a. Group-local skills support (container-runner change)

**Update file**: `src/container-runner.ts`

After the existing shared skills sync (from `container/skills/`), add a second sync step that copies skills from `groups/{name}/.claude/skills/` into the container's `.claude/skills/` directory. This allows any group to ship its own skills without modifying shared infrastructure.

```typescript
// Sync group-local skills from groups/{name}/.claude/skills/
// This allows groups to ship domain-specific skills alongside their CLAUDE.md
// See docs/decisions/group-local-skills.md for rationale
const groupSkillsSrc = path.join(groupDir, '.claude', 'skills');
if (fs.existsSync(groupSkillsSrc)) {
  for (const skillDir of fs.readdirSync(groupSkillsSrc)) {
    const srcDir = path.join(groupSkillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(skillsDst, skillDir);
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }
}
```

**New file**: `docs/decisions/group-local-skills.md` — ADR documenting this pattern.

### 2b. Create the `sb-search` skill

**New directory**: `groups/graham-second-brain/.claude/skills/sb-search/`

The skill handles all OpenViking interactions:

**Search mode** (progressive L0→L2 retrieval):
1. Bootstrap: `cd /workspace/group && uv sync` (ensures `ovcli` is installed)
2. Check `viking://user/memories/` for retrieval hints relevant to the query
3. Search with PARA-scoped URIs: `ov find "<query>" --uri viking://resources/<scope>/`
4. Load L0 abstracts for top results (cheap relevance filtering, ~100 tokens each)
5. Load L2 full content only for relevant hits
6. Use L1 overviews when user wants summaries

**Ingest mode** (after writing a note):
1. Index via `ovcli` with PARA-to-URI mapping and the standard ingestion instruction
2. The ingestion instruction: "This is a personal knowledge base using the PARA method (Projects, Areas, Resources, Archives). Preserve the category context in summaries. Emphasize actionable information, deadlines, relationships between topics, and personal opinions/decisions."

**Memory mode** (learning from interactions):
1. After completing a task, if the agent discovers something non-obvious (cross-references, retrieval patterns, structural insights), it proposes a Viking memory
2. Agent always asks Morgan for confirmation before writing to `viking://user/memories/`
3. Once memory frequency is validated, instructions can be updated to allow autonomous writes

### 2c. Update group containerConfig

Register or update the `graham-second-brain` group with:

```json
{
  "containerConfig": {
    "additionalMounts": [
      {
        "hostPath": "~/.SB_PERSONAL",
        "containerPath": ".SB_PERSONAL",
        "readonly": false
      },
      {
        "hostPath": "~/.openviking",
        "containerPath": ".openviking",
        "readonly": true
      }
    ]
  }
}
```

- First mount: second brain at `/workspace/extra/.SB_PERSONAL/` with read-write access (agent writes notes here).
- Second mount: `~/.openviking/` from the host machine (where `ovcli.conf` lives) mounted read-only. The agent can use the CLI but can't modify credentials. This mount is specific to `graham-second-brain`; no other agent can see it — stronger isolation than storing credentials in the synced repo.

For other agents that need R/W filesystem access but NOT search:

```json
{
  "containerConfig": {
    "additionalMounts": [
      {
        "hostPath": "~/.SB_PERSONAL",
        "containerPath": ".SB_PERSONAL",
        "readonly": false
      }
    ]
  }
}
```

No `~/.openviking` mount — they can write files but have no way to query or interact with the OpenViking server.

### 2d. Add paths to mount allowlist

**Update file**: `~/.config/nanoclaw/mount-allowlist.json`

Add `~/.SB_PERSONAL` under `allowedRoots` with `allowReadWrite: true`.
Add `~/.openviking` under `allowedRoots` with `allowReadWrite: false`.

### 2e. Agent dependencies

**New file**: `groups/graham-second-brain/pyproject.toml`

```toml
[project]
name = "graham-second-brain"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "openviking",
]
```

**Update file**: `groups/graham-second-brain/.gitignore`

```
.venv/
```

The agent runs `uv sync` (from `/workspace/group`) to install `ovcli`. The `.venv` is created inside the mounted group directory but gitignored.

### 2f. Update `graham-second-brain` CLAUDE.md

Update the existing CLAUDE.md to include:
- **Always search before answering** — never rely on memory or assumptions about what's in the second brain. Use the `sb-search` skill for all retrieval.
- **After every file write**, use the `sb-search` skill's ingest mode to index the new/updated file.
- **When to propose memories** — after discovering non-obvious patterns, cross-references, or retrieval insights. Always ask Morgan before writing.
- Do NOT document the mechanical details of how to call OpenViking — that's in the skill.

## Verification

1. `docker compose up -d` in `~/.SB_PERSONAL` — OpenViking starts, healthcheck passes
2. `curl -H "x-api-key: <key>" http://localhost:1933/health` — returns OK
3. Run initial bulk ingest (1e) — indexes entire PARA tree
4. Test search: `docker exec sb-openviking ov find "PARA methodology" --uri viking://resources/`
5. In nanoclaw: `npm run typecheck && npm test` — types + tests pass (after container-runner change)
6. Send a message to `graham-second-brain` asking about something in the second brain — verify it uses the `sb-search` skill with progressive L0→L2 retrieval
7. Send a message to `graham-second-brain` with new information — verify it writes the file AND indexes it via `ovcli`
8. Verify the agent proposes a Viking memory after a non-trivial interaction — confirm it waits for approval
9. Send a message to a non-`graham-second-brain` agent — verify it routes through `graham-second-brain` via IPC for second brain queries

## Files Summary

| File | Location | Action |
|------|----------|--------|
| `ov.conf` | `~/.openviking/` (host machine) | New — server config with embedding + VLM + API key |
| `ovcli.conf` | `~/.openviking/` (host machine) | New — client config with server URL + API key |
| `docker-compose.yml` | `~/.SB_PERSONAL` | New — OpenViking sidecar (safe to commit — references host paths for credentials) |
| `src/container-runner.ts` | nanoclaw | Update — sync group-local `.claude/skills/` |
| `docs/decisions/group-local-skills.md` | nanoclaw | New — ADR for group-local skills pattern |
| `.claude/skills/sb-search/` | `groups/graham-second-brain` | New — search/ingest/memory skill |
| `pyproject.toml` | `groups/graham-second-brain` | New — declares `openviking` dependency |
| `.gitignore` | `groups/graham-second-brain` | Update — exclude `.venv/` |
| `CLAUDE.md` | `groups/graham-second-brain` | Update — always search, use skill, memory guidance |
| `mount-allowlist.json` | `~/.config/nanoclaw` | Update — allow `~/.SB_PERSONAL` R/W, `~/.openviking` R/O |
