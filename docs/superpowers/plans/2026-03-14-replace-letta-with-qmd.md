# Replace Letta with QMD Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unused Letta memory integration and replace it with QMD local semantic search over markdown files.

**Architecture:** QMD runs as an HTTP daemon on the host (port 8181), indexing the Obsidian vault, group memory files, conversations, and research notes. Container agents connect to it via the host gateway using MCP HTTP transport. Letta is fully removed from all 6 touchpoints.

**Tech Stack:** QMD (`@tobilu/qmd`), node-llama-cpp (GGUF models), MCP HTTP transport, launchd

---

## Chunk 1: Remove Letta

### Task 1: Remove Letta env vars

**Files:**
- Modify: `.env:5-6`

- [ ] **Step 1: Remove Letta env vars from .env**

Delete lines 5-6:
```
LETTA_BASE_URL=https://api.letta.com
LETTA_PASSWORD=sk-let-...
```

The file should end after line 4 (TELEGRAM_BOT_POOL).

- [ ] **Step 2: Verify .env**

Run: `grep -c LETTA .env`
Expected: `0`

---

### Task 2: Remove Letta from container-runner

**Files:**
- Modify: `src/container-runner.ts:237-244`

- [ ] **Step 1: Remove Letta credential passthrough**

Delete lines 237-244 in `src/container-runner.ts`:
```typescript
  // Pass Letta credentials if configured (agent-runner uses these for the Letta MCP server)
  const lettaSecrets = readEnvFile(['LETTA_BASE_URL', 'LETTA_PASSWORD']);
  if (lettaSecrets.LETTA_BASE_URL) {
    args.push('-e', `LETTA_BASE_URL=${lettaSecrets.LETTA_BASE_URL}`);
  }
  if (lettaSecrets.LETTA_PASSWORD) {
    args.push('-e', `LETTA_PASSWORD=${lettaSecrets.LETTA_PASSWORD}`);
  }
```

- [ ] **Step 2: Check if readEnvFile is still used elsewhere**

Run: `grep -n 'readEnvFile' src/container-runner.ts`

If no other callers, also remove the import. If other callers exist, leave the import.

---

### Task 3: Remove Letta from agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts:411,427-436`

- [ ] **Step 1: Remove `mcp__letta__*` from allowedTools**

In `container/agent-runner/src/index.ts`, remove line 411:
```typescript
        'mcp__letta__*'
```

The allowedTools array should end with `'mcp__nanoclaw__*'` (add a trailing comma-safe line).

- [ ] **Step 2: Remove Letta MCP server config**

Delete lines 427-436:
```typescript
        ...(process.env.LETTA_BASE_URL ? {
          letta: {
            command: 'letta-mcp-server',
            args: [],
            env: {
              LETTA_BASE_URL: process.env.LETTA_BASE_URL,
              LETTA_PASSWORD: process.env.LETTA_PASSWORD || '',
            },
          },
        } : {}),
```

The `mcpServers` object should only contain `nanoclaw`.

---

### Task 4: Remove letta-mcp-server from Dockerfile

**Files:**
- Modify: `container/Dockerfile:33`

- [ ] **Step 1: Remove letta-mcp-server from npm install**

Change line 33 from:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code letta-mcp-server
```
To:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code
```

---

### Task 5: Remove Letta from global CLAUDE.md

**Files:**
- Modify: `groups/global/CLAUDE.md:43-60`

- [ ] **Step 1: Remove Letta memory section**

Delete lines 43-60 (the entire "### Letta (structured long-term memory)" section through the end of its instructions). Keep the "## Memory" heading and the "### File-based memory" section that follows.

Replace with a brief note about QMD (will be filled in Task 10).

---

### Task 6: Remove Letta debug permissions

**Files:**
- Modify: `.claude/settings.local.json:32-34`

- [ ] **Step 1: Remove 3 Letta permission lines**

Delete lines 32-34 from `.claude/settings.local.json`:
```json
      "Bash(npx letta-mcp-server:*)",
      "Bash(LETTA_BASE_URL=https://api.letta.com LETTA_PASSWORD=test npx letta-mcp-server --help 2>&1 | head -20 || echo \"no help flag\")",
      "Bash(curl -s -X GET \"https://api.letta.com/v1/agents\" \\\\\n  -H \"Authorization: Bearer sk-let-...\" \\\\\n  -H \"Content-Type: application/json\" 2>&1 | head -20)"
```

---

### Task 7: Build and test Letta removal

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All 271 tests pass.

- [ ] **Step 3: Rebuild container**

Run: `./container/build.sh`
Expected: Successful build without letta-mcp-server.

- [ ] **Step 4: Delete cached agent-runner source**

Run: `rm -rf data/sessions/main/agent-runner-src/`

This forces the next container run to pick up the updated agent-runner.

- [ ] **Step 5: Commit**

```bash
git add .env src/container-runner.ts container/agent-runner/src/index.ts \
  container/Dockerfile groups/global/CLAUDE.md .claude/settings.local.json
git commit -m "refactor: remove Letta memory integration

Letta was configured but never used by the agent. Memory blocks
contained only seed data from initial setup. Removing to reduce
container startup overhead and simplify the MCP server stack.

Touchpoints removed:
- .env credentials
- container-runner credential passthrough
- agent-runner MCP server config + allowedTools
- Dockerfile global npm install
- global CLAUDE.md instructions
- debug permissions"
```

---

## Chunk 2: Install and Configure QMD

### Task 8: Install QMD on host

- [ ] **Step 1: Install QMD globally**

Run: `npm install -g @tobilu/qmd`

- [ ] **Step 2: Verify installation**

Run: `qmd --version`
Expected: Version output (2.x)

---

### Task 9: Create QMD collections and index

- [ ] **Step 1: Create vault collection**

Run: `qmd collection add /Volumes/sandisk4TB/marvin-vault --name vault`

- [ ] **Step 2: Create group-memory collection**

Run: `qmd collection add /Users/mgandal/Agents/nanoclaw/groups --name group-memory --mask "*/CLAUDE.md"`

- [ ] **Step 3: Create conversations collection**

Run: `qmd collection add /Users/mgandal/Agents/nanoclaw/groups --name conversations --mask "*/conversations/**/*.md"`

- [ ] **Step 4: Create research collection**

Run: `qmd collection add /Users/mgandal/Agents/nanoclaw/groups/main --name research --mask "{research,integrations}/**/*.md"`

- [ ] **Step 5: Add context descriptions**

```bash
qmd context add qmd://vault "Personal knowledge base — Obsidian vault with notes, projects, research, and resources"
qmd context add qmd://group-memory "NanoClaw group instructions and memory — CLAUDE.md files for each group"
qmd context add qmd://conversations "Archived conversation transcripts from NanoClaw agent sessions"
qmd context add qmd://research "Lab research notes, hypotheses, and team member profiles"
```

- [ ] **Step 6: Generate embeddings**

Run: `qmd embed`

This downloads ~2GB of GGUF models on first run, then indexes all collections. May take several minutes for the 461-file vault.

- [ ] **Step 7: Verify search works**

Run: `qmd query "grant deadlines" -n 3`
Expected: Relevant results from vault or research files.

---

### Task 10: Start QMD daemon and create launchd plist

- [ ] **Step 1: Test daemon manually**

Run: `qmd mcp --http --daemon`
Expected: Daemon starts on port 8181.

- [ ] **Step 2: Verify health endpoint**

Run: `curl -s http://localhost:8181/health`
Expected: 200 response.

- [ ] **Step 3: Stop test daemon**

Run: `qmd mcp stop`

- [ ] **Step 4: Create launchd plist**

Write `~/Library/LaunchAgents/com.qmd.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.qmd</string>
    <key>ProgramArguments</key>
    <array>
        <string>QMD_BIN_PATH</string>
        <string>mcp</string>
        <string>--http</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/mgandal</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/Users/mgandal/.local/bin</string>
        <key>HOME</key>
        <string>/Users/mgandal</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/mgandal/Agents/nanoclaw/logs/qmd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/mgandal/Agents/nanoclaw/logs/qmd.error.log</string>
</dict>
</plist>
```

**NOTE:** Replace `QMD_BIN_PATH` with the actual path from `which qmd`.

- [ ] **Step 5: Load the plist**

Run: `launchctl load ~/Library/LaunchAgents/com.qmd.plist`

- [ ] **Step 6: Verify daemon is running**

Run: `curl -s http://localhost:8181/health`
Expected: 200 response.

---

## Chunk 3: Wire QMD into NanoClaw Agent

### Task 11: Add QMD MCP server to agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Add `mcp__qmd__*` to allowedTools**

In the `allowedTools` array, add after `'mcp__nanoclaw__*'`:
```typescript
        'mcp__qmd__*'
```

- [ ] **Step 2: Add QMD MCP server config**

In the `mcpServers` object, add after the `nanoclaw` entry:

```typescript
        ...(process.env.QMD_URL ? {
          qmd: {
            type: 'http' as const,
            url: process.env.QMD_URL,
          },
        } : {}),
```

---

### Task 12: Pass QMD_URL to containers

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Add QMD_URL env var to container args**

In `buildContainerArgs()`, after the auth mode section (after line 235), add:

```typescript
  // Pass QMD search endpoint URL if daemon is running
  const qmdUrl = `http://${CONTAINER_HOST_GATEWAY}:8181/mcp`;
  args.push('-e', `QMD_URL=${qmdUrl}`);
```

This uses the same host gateway mechanism as the credential proxy.

---

### Task 13: Update global CLAUDE.md with QMD instructions

**Files:**
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: Replace Letta section with QMD section**

Where the Letta section was (after "## Memory", before "### File-based memory"), add:

```markdown
### QMD (semantic search over your knowledge base)

You have access to QMD via `mcp__qmd__*` tools. QMD indexes your Obsidian vault, group memory files, conversation archives, and research notes.

Use QMD when you need to find information but don't know which file it's in:
- `mcp__qmd__query` — hybrid semantic + keyword search (best quality)
- `mcp__qmd__get` — retrieve a specific document by path or #docid
- `mcp__qmd__multi_get` — batch retrieve by glob pattern
- `mcp__qmd__status` — check index health and collection stats

For simple lookups where you know the file, use Read/Grep directly — they're faster.
```

---

### Task 14: Build, test, and rebuild container

- [ ] **Step 1: Build host code**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Rebuild container image**

Run: `./container/build.sh`
Expected: Successful build.

- [ ] **Step 4: Delete cached agent-runner source**

Run: `rm -rf data/sessions/main/agent-runner-src/`

- [ ] **Step 5: Restart NanoClaw service**

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts container/agent-runner/src/index.ts \
  groups/global/CLAUDE.md
git commit -m "feat: add QMD semantic search integration

QMD runs as an HTTP daemon on the host (port 8181), indexing:
- Obsidian vault (461 files)
- Group CLAUDE.md memory files
- Conversation archives
- Research notes

Container agents connect via MCP HTTP transport through
the host gateway. Tools: query, get, multi_get, status."
```

---

### Task 15: Update memory file

**Files:**
- Modify: `/Users/mgandal/.claude/projects/-Users-mgandal-Agents-nanoclaw/memory/MEMORY.md`

- [ ] **Step 1: Remove Letta section from MEMORY.md**

Remove the "## Letta Integration" section entirely.

- [ ] **Step 2: Add QMD section to MEMORY.md**

Add:
```markdown
## QMD (semantic search)
- HTTP daemon on host, port 8181
- Launchd: `com.qmd` (~/Library/LaunchAgents/com.qmd.plist)
- Collections: vault, group-memory, conversations, research
- Models cached at ~/.cache/qmd/models/ (~2GB)
- Index at ~/.cache/qmd/index.sqlite
- Re-index: `qmd update && qmd embed`
- Container access via MCP HTTP transport (QMD_URL env var)
```

- [ ] **Step 3: Update MCP Servers section**

Change the MCP Servers list to replace letta with qmd:
```markdown
- nanoclaw (IPC bridge)
- gmail (@gongrzhe/server-gmail-autoauth-mcp)
- obsidian (conditional on /workspace/extra/claire-vault existing)
- qmd (HTTP transport, conditional on QMD_URL env var)
```
