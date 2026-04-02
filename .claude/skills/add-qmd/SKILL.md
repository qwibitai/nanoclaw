---
name: add-qmd
description: Add QMD for semantic search across NanoClaw's markdown knowledge bases. Helps the agent find relevant past conversations and documentation.
---

# Add QMD Integration

This skill adds QMD (Query Markdown Documents) for semantic search across NanoClaw's groups. The agent can search past conversations, documentation, and notes using keyword, semantic, or hybrid queries.

Tools added:
- `mcp__qmd__query` — search with lex/vec/hyde queries
- `mcp__qmd__get` — retrieve document by path or docid
- `mcp__qmd__multi_get` — batch retrieve by glob pattern
- `mcp__qmd__status` — check index health

## Phase 1: Install QMD

### Check if already installed

```bash
~/.local/node_modules/@tobilu/qmd/qmd --version
```

If installed, skip to Phase 2.

### Install via bun

```bash
bun install -g @tobilu/qmd
```

This installs to `~/.local/node_modules/@tobilu/qmd/`. Verify:

```bash
~/.local/node_modules/@tobilu/qmd/qmd --version
```

## Phase 2: Create Collections

Index the groups directory for semantic search:

```bash
# Create a collection for each group
~/.local/node_modules/@tobilu/qmd/qmd collection add /path/to/nanoclaw/groups/<group_name> --name <group_name>

# Add context for better search results
~/.local/node_modules/@tobilu/qmd/qmd context add qmd://<group_name> "NanoClaw group: conversations, docs, and memory"
```

## Phase 3: Generate Embeddings

This downloads models (~2GB) and generates vectors. On CPU this takes several minutes:

```bash
~/.local/node_modules/@tobilu/qmd/qmd embed
```

Verify status:

```bash
~/.local/node_modules/@tobilu/qmd/qmd status
```

## Phase 4: Configure MCP for Containers

QMD runs as an MCP server on the host. Containers connect via HTTP.

### Create systemd service

Create `~/.config/systemd/user/qmd.service`:

```ini
[Unit]
Description=QMD MCP Server (internal)
After=network.target

[Service]
Type=simple
Environment=PATH=/home/ubuntu/.bun/bin:/usr/local/bin:/usr/bin
ExecStart=/home/ubuntu/.local/node_modules/@tobilu/qmd/qmd mcp --http --port 8182
Restart=always
RestartSec=5

PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
NoNewPrivileges=yes
ReadWritePaths=/home/ubuntu/.cache/qmd

[Install]
WantedBy=default.target
```

Start the service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now qmd
```

### Wire into agent-runner

The container agent needs to reach QMD's MCP server. Edit `container/agent-runner/src/index.ts` to add the MCP server config:

```typescript
mcpServers: {
  qmd: {
    type: 'http',
    url: 'http://host.docker.internal:8182/mcp',
  },
},
```

Also add `mcp__qmd__*` to the `allowedTools` array in the same file.

Rebuild and restart:

```bash
./container/build.sh
systemctl --user restart nanoclaw
```

## Phase 5: Set Up Daily Embedding Update

Create a cron job to keep the index fresh:

```bash
(crontab -l 2>/dev/null; echo "0 18 * * * export PATH=\"\$HOME/.bun/bin:\$PATH\" && ~/.local/node_modules/@tobilu/qmd/qmd embed > /dev/null 2>&1") | crontab -
```

Verify cron was added:

```bash
crontab -l | grep qmd
```

## Phase 6: Test

Send a message to the bot asking it to search for something from past conversations:

> "Search our conversations for anything about QMD"

The agent should use `mcp__qmd__query` to find relevant context.

## Usage Guide

Once installed, the agent can use these MCP tools:

### Query Types

| Type | Method | Best For |
|------|--------|----------|
| `lex` | BM25 | Keywords, exact terms, code |
| `vec` | Vector | Natural language questions |
| `hyde` | Vector | Hypothetical answer (50-100 words) |

### Example Query

```json
{
  "searches": [
    { "type": "lex", "query": "QMD setup" },
    { "type": "vec", "query": "how did we configure the search tool" }
  ],
  "collections": ["telegram_main"],
  "limit": 10
}
```

## Troubleshooting

### "qmd: command not found"

QMD is installed via bun to `~/.local/node_modules/@tobilu/qmd/`. Use the full path:

```bash
~/.local/node_modules/@tobilu/qmd/qmd --version
```

### Embeddings too slow

QMD runs on CPU by default. For faster embeddings:
- Use a machine with GPU
- Or accept the CPU speed (one-time cost for initial embed, incremental after)

### Container can't reach QMD

1. Verify QMD MCP server is running: `systemctl --user status qmd`
2. Verify port: `curl http://localhost:8182/status`
3. Check Docker can reach host: `docker run --rm curlimages/curl curl -s http://host.docker.internal:8182/status`

### Search returns no results

1. Check collections exist: `~/.local/node_modules/@tobilu/qmd/qmd status`
2. Verify embeddings generated: status should show "Vectors: X embedded"
3. Try a broader query or different type (lex vs vec)

## Removal

```bash
# Stop and disable service
systemctl --user stop qmd
systemctl --user disable qmd
rm ~/.config/systemd/user/qmd.service
systemctl --user daemon-reload

# Remove cron job
crontab -l | grep -v qmd | crontab -

# Uninstall
bun uninstall -g @tobilu/qmd

# Delete index and models (~2GB)
rm -rf ~/.cache/qmd/

# Remove from agent-runner config
# Edit container/agent-runner/src/index.ts: remove qmd from mcpServers and allowedTools
# Then rebuild: ./container/build.sh
```
