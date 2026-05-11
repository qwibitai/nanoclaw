---
name: add-hindsight
description: Wire NanoClaw v2 agents to a separately-running Hindsight MCP instance. Per-group long-term memory bank with semantic recall, retain, and reflect tools. Bring-your-own Hindsight stack — this skill only wires NanoClaw to it.
---

# Add Hindsight Memory

Connects NanoClaw v2 agent groups to a **separately-deployed** `hindsight-mcp`
stdio server (which itself proxies to a [Vectorize.io Hindsight](https://github.com/vectorize-io/hindsight)
engine). Adds three MCP tools to wired groups:

- `mcp__hindsight__memory_recall` — semantic search across past memories
- `mcp__hindsight__memory_retain` — persist a durable fact
- `mcp__hindsight__memory_reflect` — synthesise an answer from memories with evidence

Each group gets its own bank, addressed by `group=<group-folder>` under a
configurable bank prefix (default `nanoclaw`).

## Prerequisites — out of scope for this skill

This skill **does not deploy Hindsight**. It assumes you already have:

1. A running **Hindsight engine** (the Vectorize.io HTTP service) reachable
   from the NanoClaw host. Hindsight's own docs cover deployment.
2. A built **`hindsight-mcp` stdio binary** at some host path, e.g.
   `/home/hindsight-mcp/app/dist/server-stdio.js`. The binary is a small
   stdio MCP wrapper that translates between the MCP protocol and
   Hindsight's HTTP API. (Upstream source: `vectorize-io/hindsight-mcp`
   or similar; ask your operator.)
3. ACLs that let NanoClaw's container uid (1001 = `node`) **read** the
   binary path (typically `setfacl -R -m u:1001:rX <path>`).

If any of those are missing, set them up first — they're independent of
NanoClaw.

## Phase 1: Pre-flight

Define your environment variables (substitute your actual values):

```bash
# Path on the host where the hindsight-mcp stdio binary lives:
HINDSIGHT_BIN_PATH=/path/to/hindsight-mcp/app

# Hindsight engine HTTP endpoint (reachable from the NanoClaw host):
HINDSIGHT_ENGINE_URL=http://hindsight.example.local:3850

# Bank prefix — banks will be named "<prefix>:<group-folder>". Pick once,
# don't change later or you'll lose existing memories.
HINDSIGHT_BANK_PREFIX=nanoclaw
```

Verify reachability + permissions:

```bash
# Engine reachable?
curl -fsS "$HINDSIGHT_ENGINE_URL/health"
# Expected: {"status":"ok",...}

# Binary readable by container uid?
ls -la "$HINDSIGHT_BIN_PATH/dist/server-stdio.js"

# Binary speaks MCP correctly? (initialize + tools/list smoke test)
HINDSIGHT_URL="$HINDSIGHT_ENGINE_URL" HINDSIGHT_BANK_PREFIX="$HINDSIGHT_BANK_PREFIX" \
  bash -c '(printf "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"s\",\"version\":\"0.1\"}}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n"; sleep 3) | timeout 5 node '"$HINDSIGHT_BIN_PATH"'/dist/server-stdio.js 2>&1 | head -5'
# Should print three JSON-RPC responses including a `tools/list` with
# memory_recall, memory_retain, memory_reflect.
```

If any check fails, fix it before continuing — the agent will get
`ENOENT` or `connection refused` otherwise.

## Phase 2: Mount-allowlist

Add `$HINDSIGHT_BIN_PATH` to NanoClaw's mount allowlist
(`~/.config/nanoclaw/mount-allowlist.json`). Run `/manage-mounts` and
add an entry like:

```json
{
  "path": "/path/to/hindsight-mcp/app",
  "allowReadWrite": false,
  "description": "Hindsight MCP stdio binary + node_modules (read-only)"
}
```

Restart the NanoClaw service so the allowlist reloads
(`systemctl --user restart nanoclaw-v2-<id>.service`).

## Phase 3: Wire each group that should have memory

For each agent group, run the `ncl` commands below. Substitute
`<group-id>` from `ncl groups list`.

```bash
GID=<group-id>

# Add the hindsight MCP server. The instructions string tells the agent
# which group to use for its bank and pins the discipline-skill hint.
ncl groups config add-mcp-server \
  --id "$GID" \
  --name hindsight \
  --command node \
  --args '["/workspace/extra/hindsight-mcp/dist/server-stdio.js"]' \
  --env "$(jq -nc --arg url "$HINDSIGHT_ENGINE_URL" --arg pfx "$HINDSIGHT_BANK_PREFIX" \
    '{HINDSIGHT_URL: $url, HINDSIGHT_BANK_PREFIX: $pfx}')"
```

The mount itself (`additional_mounts`) is not yet exposed via `ncl groups
config` as of NanoClaw v2.0.56 — until that lands, add it via direct DB
update:

```bash
sqlite3 data/v2.db <<SQL
UPDATE container_configs
SET additional_mounts = json_insert(
  COALESCE(additional_mounts, '[]'),
  '\$[#]',
  json_object(
    'hostPath', '$HINDSIGHT_BIN_PATH',
    'containerPath', 'hindsight-mcp',
    'readonly', json('true')
  )
)
WHERE agent_group_id = '$GID';
SQL
```

Then restart the group's containers so the new config takes effect:

```bash
ncl groups restart --id "$GID"
```

## Phase 4: Verify

Send the group's agent a message that should trigger recall, e.g. ask
about something you discussed in a prior turn. The agent should call
`mcp__hindsight__memory_recall` before answering. Check logs:

```bash
tail -100 logs/nanoclaw.log | grep -iE 'hindsight|mcp'
```

The first call may take 1-2s while the stdio MCP server starts.

## Phase 5: Discipline

The wired agent automatically loads `container/skills/hindsight/SKILL.md`
on first turn — that file contains the *discipline* (when to recall,
when to retain, what NOT to retain, common anti-patterns). Without it,
agents tend to over-retain or never retain. **Don't skip it** — see
`container/skills/hindsight/SKILL.md` for the why.

## Removal

```bash
GID=<group-id>
ncl groups config remove-mcp-server --id "$GID" --name hindsight
sqlite3 data/v2.db "UPDATE container_configs SET additional_mounts = (
  SELECT json_group_array(value) FROM json_each(additional_mounts)
  WHERE json_extract(value, '$.containerPath') != 'hindsight-mcp'
) WHERE agent_group_id = '$GID';"
ncl groups restart --id "$GID"
```

(Optional) Remove the mount-allowlist entry via `/manage-mounts` if no
other tooling needs it.

## Credits & references

- **Hindsight engine**: [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)
  (Apache 2.0). Graph-extracting memory with semantic search.
- **hindsight-mcp stdio binary**: ships independently; this skill is
  protocol-only — it doesn't care which implementation as long as it
  exposes `memory_recall` / `memory_retain` / `memory_reflect` via MCP.
- **Related skills**: `/add-mnemon` (graph-based memory, different
  backend) is a sibling memory option. Pick one — running both is
  redundant.
