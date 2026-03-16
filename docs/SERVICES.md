# External Services & MCP Servers

NanoClaw agents connect to external services via [MCP servers](https://modelcontextprotocol.io/) running inside the container. Each MCP server gives the agent a set of tools (prefixed with `mcp__<name>__`). Credentials are stored in `.env` on the host and passed to containers as environment variables — agents never see raw tokens directly.

## How It Works

```
Host (.env)                    Container
┌──────────────┐              ┌──────────────────────────────┐
│ SECRET=xyz   │──env pass──▶ │ MCP Server (reads $SECRET)   │
│              │   through    │   ↕                          │
│              │              │ Claude Agent SDK              │
│              │              │   → mcp__name__tool()         │
└──────────────┘              └──────────────────────────────┘
```

**Adding a credential:** Set the variable in `.env`, add it to the `readEnvFile()` call in `src/container-runner.ts`, and add the MCP server config in `container/agent-runner/src/index.ts`.

**Removing a service:** Delete the variable from `.env` and restart. The MCP server will start but fail to authenticate — the agent simply won't have those tools available.

## Services

### Claude (Required)

The AI model that powers the agent. One of these is required.

| Variable | Source |
|----------|--------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` (Pro/Max subscription) |
| `ANTHROPIC_API_KEY` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) (API billing) |

### MongoDB

Read-only access to MongoDB Atlas databases. The agent can query any collection across all databases the connection string has access to.

| Variable | Source |
|----------|--------|
| `MDB_MCP_CONNECTION_STRING` | MongoDB Atlas → Database Access → Create read-only user |

**MCP server:** `mongodb-mcp-server` (run via npx)
**Agent tools:** `mcp__mongodb__*` — query collections, list databases, inspect schemas
**Runs with:** `--readOnly` flag (enforced server-side)

**Tip:** Create a dedicated read-only database user in Atlas rather than reusing an admin account.

### GitHub

Full repository access via the official GitHub MCP server. The agent can read files, push commits, create/review PRs, manage issues, and more — across any repo the token has access to.

| Variable | Source |
|----------|--------|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | [github.com/settings/tokens](https://github.com/settings/tokens?type=beta) (fine-grained PAT) |

**MCP server:** `github-mcp-server` (binary, copied into container at build time)
**Agent tools:** `mcp__github__*` — get/create/push files, create PRs, search repos, manage issues

**Recommended PAT scopes:** Contents (read/write), Pull Requests (read/write), Issues (read/write). Add more scopes as needed for your workflow.

### Logfire

Application performance monitoring via [Pydantic Logfire](https://logfire.pydantic.dev). The agent can query trace data, find exceptions, investigate latency, and generate deep links to the Logfire UI.

| Variable | Source |
|----------|--------|
| `LOGFIRE_READ_TOKEN` | Logfire → Settings → Read Tokens |

**MCP server:** Remote HTTP server at `https://logfire-us.pydantic.dev/mcp` (no local process — token sent as Bearer header)
**Agent tools:** `mcp__logfire__*` — `find_exceptions_in_file`, `arbitrary_query`, `logfire_link`, `schema_reference`

**Tip:** Use a v2 multi-project token for access across all your Logfire projects from a single token. The API key needs `project:read` scope.

## Adding a New MCP Server

To give the agent access to a new service:

1. **Add the credential** to `.env`:
   ```
   MY_SERVICE_TOKEN=xxx
   ```

2. **Pass it to containers** in `src/container-runner.ts` — add the variable name to the `readEnvFile()` array and add the `-e` flag:
   ```typescript
   const mcpEnv = readEnvFile([
     // ... existing vars ...
     'MY_SERVICE_TOKEN',
   ]);
   if (mcpEnv.MY_SERVICE_TOKEN) {
     args.push('-e', `MY_SERVICE_TOKEN=${mcpEnv.MY_SERVICE_TOKEN}`);
   }
   ```

3. **Configure the MCP server** in `container/agent-runner/src/index.ts` — add to `mcpServers`:
   ```typescript
   myservice: {
     command: 'npx',
     args: ['-y', 'my-service-mcp@latest'],
     env: { MY_SERVICE_TOKEN: process.env.MY_SERVICE_TOKEN || '' },
   },
   ```

4. **Allow the tools** — add `'mcp__myservice__*'` to the `allowedTools` array in the same file.

5. **Install dependencies** if the MCP server needs a runtime not in the container (e.g., Python/uv for Python-based servers) — update `container/Dockerfile`.

6. **Rebuild and restart:**
   ```bash
   ./container/build.sh          # Rebuild container image
   npm run build                 # Rebuild host
   # Sync agent-runner source to existing groups:
   cp container/agent-runner/src/index.ts data/sessions/*/agent-runner-src/index.ts
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   ```

7. **Document it** — update `groups/global/CLAUDE.md` so the agent knows about the new tools, and add the variable to `.env.example`.
