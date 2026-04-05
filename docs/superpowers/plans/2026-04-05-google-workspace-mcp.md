# Google Workspace MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-hosted Google Workspace MCP server (Gmail, Calendar, Tasks, Drive, Docs, Sheets) and make `.mcp.json` servers available to all container agents.

**Architecture:** Add the `taylorwilsdon/google_workspace_mcp` MCP server to `.mcp.json`. Add a `readMcpJson()` helper in `container-runner.ts` that reads `.mcp.json` at container startup and merges its servers as defaults under per-group overrides. This makes `.mcp.json` the single source of truth for globally available MCP servers.

**Tech Stack:** Node.js, TypeScript, Vitest, Python/uvx (MCP server runtime)

**Spec:** `docs/superpowers/specs/2026-04-05-mcp-migration-design.md` (PR 2 section)

---

### Task 1: Create branch and update config files

**Files:**
- Modify: `.mcp.json`
- Modify: `.env`
- Modify: `.env.example`

- [ ] **Step 1: Create feature branch**

```bash
git checkout main
git checkout -b feat/google-workspace-mcp
```

- [ ] **Step 2: Add Google Workspace MCP server to `.mcp.json`**

Replace the entire file:

```json
{
  "mcpServers": {
    "perplexity": {
      "command": "npx",
      "args": ["-y", "@perplexity-ai/mcp-server"],
      "env": {
        "PERPLEXITY_API_KEY": "${PERPLEXITY_API_KEY}"
      }
    },
    "google-workspace": {
      "command": "uvx",
      "args": ["workspace-mcp", "--tool-tier", "core"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID}",
        "GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET}"
      }
    }
  }
}
```

- [ ] **Step 3: Add Google OAuth credentials to `.env`**

Add at the end of `.env`:

```
# Google Workspace MCP (Gmail, Calendar, Tasks, Drive, Docs, Sheets)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

- [ ] **Step 4: Add to `.env.example`**

Add at the end:

```
# Google Workspace MCP (Gmail, Calendar, Tasks, Drive, Docs, Sheets)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

- [ ] **Step 5: Commit**

```bash
git add .mcp.json .env .env.example
git commit -m "config: add Google Workspace MCP server and credentials"
```

---

### Task 2: Write failing test for `.mcp.json` merge into container runs

**Files:**
- Modify: `src/container-runner.test.ts`

- [ ] **Step 1: Write failing test**

Add a new describe block to `src/container-runner.test.ts` after the existing `describe` blocks. This test verifies that servers from `.mcp.json` are merged into the container input.

First, update the `fs` mock to support reading `.mcp.json`. Modify the existing `readFileSync` mock to return MCP config when the path matches:

```typescript
describe('container-runner .mcp.json merge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();

    // Make readFileSync return .mcp.json content when requested
    const fsMod = vi.mocked(await import('fs')).default;
    fsMod.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (typeof p === 'string' && p.endsWith('.mcp.json')) {
        return JSON.stringify({
          mcpServers: {
            'global-server': {
              command: 'npx',
              args: ['-y', 'some-mcp-server'],
              env: { SOME_KEY: 'some-value' },
            },
          },
        });
      }
      return '';
    });
    fsMod.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges .mcp.json servers into container input', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // Check that stdin received input with mcpServers from .mcp.json
    const stdinData = fakeProc.stdin.read()?.toString();
    const input = JSON.parse(stdinData);
    expect(input.mcpServers).toBeDefined();
    expect(input.mcpServers['global-server']).toBeDefined();
    expect(input.mcpServers['global-server'].command).toBe('npx');
  });

  it('per-group servers override global servers with same name', async () => {
    const groupWithMcp: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        mcpServers: {
          'global-server': {
            command: 'custom-cmd',
            args: ['--custom'],
          },
        },
      },
    };

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      groupWithMcp,
      { ...testInput },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const stdinData = fakeProc.stdin.read()?.toString();
    const input = JSON.parse(stdinData);
    expect(input.mcpServers['global-server'].command).toBe('custom-cmd');
  });
});
```

Note: The exact mock setup may need adjustment based on how the existing mocks interact. The key assertions are: (1) `.mcp.json` servers appear in `input.mcpServers`, (2) per-group servers override globals.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/container-runner.test.ts
```

Expected: New tests FAIL because `runContainerAgent` doesn't read `.mcp.json` yet.

- [ ] **Step 3: Commit**

```bash
git add src/container-runner.test.ts
git commit -m "test: add failing tests for .mcp.json merge into container runs"
```

---

### Task 3: Implement `.mcp.json` merge in container-runner.ts

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Add `readMcpJson` helper**

Add this function near the top of the file, after the imports and before `buildVolumeMounts`:

```typescript
/**
 * Read .mcp.json from the project root and return its mcpServers.
 * Returns empty object if file doesn't exist or is malformed.
 */
function readMcpJson(): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');
  try {
    if (!fs.existsSync(mcpJsonPath)) return {};
    const raw = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    return raw.mcpServers || {};
  } catch (err) {
    logger.warn({ err }, 'Failed to read .mcp.json — skipping global MCP servers');
    return {};
  }
}
```

- [ ] **Step 2: Merge global servers into `runContainerAgent`**

In `runContainerAgent`, find the MCP server resolution block (currently starts around the line `const mcpServers = group.containerConfig?.mcpServers;`). Replace it with:

```typescript
  // Merge global MCP servers from .mcp.json with per-group overrides.
  // Per-group servers win when names collide.
  const globalMcpServers = readMcpJson();
  const groupMcpServers = group.containerConfig?.mcpServers || {};
  const mergedMcpServers = { ...globalMcpServers, ...groupMcpServers };

  let mcpEnvVars: Record<string, string> | undefined;
  const hasMcpServers = Object.keys(mergedMcpServers).length > 0;
  if (hasMcpServers) {
    // Collect all env var names we need to resolve
    const envKeys = new Set<string>();
    for (const server of Object.values(mergedMcpServers)) {
      if (!server.env) continue;
      for (const [key, val] of Object.entries(server.env)) {
        envKeys.add(key);
        const match = val.match(/^\$\{(\w+)\}$/);
        if (match) envKeys.add(match[1]);
      }
    }

    const resolved = envKeys.size > 0 ? readEnvFile([...envKeys]) : {};
    mcpEnvVars = {};

    // Build resolved MCP server configs and collect container env vars
    const resolvedServers: typeof mergedMcpServers = {};
    for (const [name, server] of Object.entries(mergedMcpServers)) {
      const resolvedEnv: Record<string, string> = {};
      if (server.env) {
        for (const [key, val] of Object.entries(server.env)) {
          const match = val.match(/^\$\{(\w+)\}$/);
          const resolvedVal = match ? resolved[match[1]] || '' : val;
          resolvedEnv[key] = resolvedVal;
          // Also inject into container process env so MCP server inherits it
          if (resolvedVal) mcpEnvVars![key] = resolvedVal;
        }
      }
      resolvedServers[name] = { ...server, env: resolvedEnv };
    }

    // Forward resolved MCP server config to the container via ContainerInput
    input.mcpServers = resolvedServers;
  }
```

This replaces the old block that only read from `group.containerConfig?.mcpServers`. The resolution logic is identical — only the source of servers changes.

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/container-runner.test.ts
```

Expected: All tests pass, including the new `.mcp.json` merge tests.

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: merge .mcp.json servers as global defaults for all containers

Reads .mcp.json from project root and merges its servers with per-group
containerConfig.mcpServers. Per-group overrides win on name collisions.
This makes .mcp.json the single source of truth for globally available
MCP servers without requiring database updates per group."
```

---

### Task 4: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Clean build.

- [ ] **Step 3: Verify .mcp.json is read correctly**

```bash
node -e "
const fs = require('fs');
const mcp = JSON.parse(fs.readFileSync('.mcp.json', 'utf-8'));
console.log('MCP servers:', Object.keys(mcp.mcpServers));
"
```

Expected: `MCP servers: [ 'perplexity', 'google-workspace' ]`

- [ ] **Step 4: Note for operator**

After merge, the operator must:
1. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`
2. Run the Google OAuth first-time consent flow (headless: use SSH port forwarding `ssh -L 3000:localhost:3000 server`)
3. Verify token cache at `~/.workspace-mcp/credentials/`
