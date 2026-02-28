---
name: add-brave-search
description: Add Brave Search as an optional web search MCP tool. Keeps NanoClaw core minimal by applying changes through a skill instead of committing feature code to base runtime.
---

# Add Brave Search Tool

Add Brave Search support as a local customization.

This skill is intentionally "skills over features": it guides code changes in a fork instead of adding permanent feature code to upstream NanoClaw.

## What This Skill Adds

- `mcp__nanoclaw__web_search` tool in the container MCP server
- `BRAVE_API_KEY` wiring in the host -> container secret path
- Optional memory/docs update so the assistant knows when to use the tool

## Prerequisites

1. NanoClaw is already running
2. User has a Brave Search API key (https://brave.com/search/api)

## Implementation Workflow

Run these steps directly. Ask the user only when a value is required.

### 1) Collect API Key

Ask:

> Please share your Brave Search API key (or confirm it is already in `.env` as `BRAVE_API_KEY`).

If key is provided, ensure `.env` contains:

```bash
BRAVE_API_KEY=...
```

### 2) Wire Secret Propagation (Version-Aware)

NanoClaw has two secret wiring patterns depending on version.

1. Read `src/container-runner.ts`.
2. If file uses `readSecrets()` with explicit allowlist, include `BRAVE_API_KEY` there.
3. If file uses `allowedVars` for mounted env filtering, include `BRAVE_API_KEY` in that list.

Do not add duplicate entries.

### 3) Find Active MCP File

1. Read `container/agent-runner/src/index.ts`.
2. Locate which MCP file is imported/used:
   - `ipc-mcp-stdio.ts` (newer layout), or
   - `ipc-mcp.ts` (older layout).
3. Apply tool changes only to the active file.

### 4) Add `web_search` Tool

In the active MCP file:

- Add Brave fetch helper with:
  - query trim + empty-query handling
  - max query length guard (512 chars)
  - timeout via `AbortController` (~10s)
  - rate-limit (429) friendly error
  - response truncation for readability
- Add MCP tool:
  - name: `web_search`
  - args: `query` (string), `count` (number, 1..20, default 5)
  - output: title/url/description/age formatted for chat

Security and UX constraints:

- Return safe user-facing errors (no stack traces)
- Do not leak secrets or request headers in error text
- Keep behavior deterministic and bounded

### 5) Update Agent Memory (Optional but Recommended)

Update `groups/main/CLAUDE.md` (and `groups/global/CLAUDE.md` if present) to mention:

- Web search is available via `mcp__nanoclaw__web_search`
- Results are summaries and important facts should be verified from URLs

### 6) Rebuild and Verify

Run:

```bash
./container/build.sh
npm run build
```

Then restart service and sanity-check logs.

### 7) Functional Test

Ask the user to send in WhatsApp:

```text
@Andy search the web for the latest TypeScript release
```

Expected:

- Assistant uses `mcp__nanoclaw__web_search`
- Returns multiple results with title, URL, and short description
- No "Web search is not configured" error when key is present

## Rollback

To remove Brave integration from a fork:

1. Remove `web_search` tool/helper from active MCP file
2. Remove `BRAVE_API_KEY` from secret allowlist logic
3. Remove related CLAUDE.md guidance
4. Rebuild container and app
