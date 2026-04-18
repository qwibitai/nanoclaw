# LLM Provider Layer — Deferred Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the four deferred items from the LLM Provider Layer plan: MCP tool bridging for the Vercel runner, trust gateway pending-approval polling, `switch_model` IPC command, and session message structure preservation.

**Architecture:** Each item is independent — they can be implemented in any order. MCP tool bridging connects stdio-based MCP servers (nanoclaw, Gmail, Notion, SuperPilot) to the Vercel AI SDK path via `createMCPClient` + `StdioClientTransport`. Trust gateway integration adds a poll loop for pending approvals so the agent pauses until the user approves/denies. `switch_model` adds a new IPC message type that lets agents change their LLM mid-conversation. Session preservation stops flattening `CoreMessage[]` content to strings.

**Tech Stack:** `ai` (Vercel AI SDK v6), `@modelcontextprotocol/sdk` (StdioClientTransport), `zod`, vitest

**Reference files:**
- Design spec: `docs/superpowers/specs/2026-04-15-llm-provider-layer-design.md`
- Vercel runner: `container/agent-runner/src/vercel-runner.ts`
- Tool bridge: `container/agent-runner/src/tool-bridge.ts`
- Session store: `container/agent-runner/src/session-store.ts`
- Trust gateway: `src/trust-gateway.ts`
- IPC watcher: `src/ipc.ts`
- Agent runner entry: `container/agent-runner/src/index.ts`
- Container runner (host): `src/container-runner.ts`
- Types: `src/types.ts`

---

## Task 1: Session Message Structure Preservation

The Vercel runner currently flattens all message `content` to strings when saving sessions (`vercel-runner.ts:192-203`). This corrupts tool_use/tool_result content parts — when the session is reloaded, the LLM sees stringified JSON instead of proper structured messages, breaking multi-turn tool conversations.

**Files:**
- Modify: `container/agent-runner/src/session-store.ts`
- Modify: `container/agent-runner/src/vercel-runner.ts:160-205`
- Create: `src/llm/session-store.test.ts` (tests run in host vitest suite)

- [ ] **Step 1: Write the failing test for structured message preservation**

Add this test file. It verifies that tool call/result messages survive a save/load round-trip without flattening.

```typescript
// src/llm/session-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('session-store structured messages', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves tool_use content parts through save/load', async () => {
    const { saveSession, loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );

    const messages = [
      { role: 'user', content: 'search for cats' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_123',
            toolName: 'search',
            args: { query: 'cats' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_123',
            toolName: 'search',
            result: { items: ['cat1', 'cat2'] },
          },
        ],
      },
      { role: 'assistant', content: 'I found 2 cats.' },
    ];

    const sessionId = saveSession(tempDir, null, messages);
    const loaded = loadSession(tempDir, sessionId);

    expect(loaded).toHaveLength(4);
    // Assistant message with tool call should NOT be a flat string
    expect(loaded[1].content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_123',
        toolName: 'search',
        args: { query: 'cats' },
      },
    ]);
    // Tool result should preserve structure
    expect(loaded[2].content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call_123',
        toolName: 'search',
        result: { items: ['cat1', 'cat2'] },
      },
    ]);
    // Plain string content stays as string
    expect(loaded[3].content).toBe('I found 2 cats.');
  });

  it('handles mixed string and structured content', async () => {
    const { saveSession, loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );

    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];

    const sessionId = saveSession(tempDir, null, messages);
    const loaded = loadSession(tempDir, sessionId);

    expect(loaded[0].content).toBe('hello');
    expect(loaded[1].content).toBe('hi there');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/session-store.test.ts`
Expected: FAIL — the current `SessionMessage` interface has `content: string` which cannot hold structured content.

- [ ] **Step 3: Update session-store to preserve full message structure**

Change the `SessionMessage` interface and remove the `content: string` constraint. The store should save/load messages as-is without transforming content.

In `container/agent-runner/src/session-store.ts`, replace the entire file:

```typescript
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface SessionMessage {
  role: string;
  content: string | unknown[];
  [key: string]: unknown;
}

const MAX_SESSION_MESSAGES = 100;

export function loadSession(
  sessionDir: string,
  sessionId: string | null | undefined,
): SessionMessage[] {
  if (!sessionId) return [];
  const filePath = path.join(sessionDir, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveSession(
  sessionDir: string,
  sessionId: string | null | undefined,
  messages: SessionMessage[],
): string {
  fs.mkdirSync(sessionDir, { recursive: true });
  const id = sessionId ?? crypto.randomUUID();
  const filePath = path.join(sessionDir, `${id}.json`);
  const trimmed = messages.slice(-MAX_SESSION_MESSAGES);
  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2));
  return id;
}
```

- [ ] **Step 4: Update vercel-runner.ts to stop flattening message content**

In `container/agent-runner/src/vercel-runner.ts`, replace the session save block and the session load mapping. The key change: stop calling `String(m.content)` and `JSON.stringify(m.content)` — pass messages through as-is.

Replace lines 160-204 (the messages construction through session save) with:

```typescript
    const sessionDir = '/workspace/group/sessions/vercel';
    const sessionMessages = loadSession(sessionDir, input.sessionId);

    const messages: CoreMessage[] = [
      ...sessionMessages as CoreMessage[],
      { role: 'user' as const, content: prompt },
    ];

    const systemPrompt = buildSystemPrompt(input);

    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      maxSteps: 50,
      onStepFinish: ({ toolCalls }) => {
        for (const tc of toolCalls ?? []) {
          const label = formatToolLabel(tc.toolName);
          writeOutput({
            status: 'success',
            result: null,
            progressLabel: label,
          });
        }
      },
    });

    // Preserve full message structure including tool_use/tool_result parts
    const allMessages = [
      ...messages,
      ...result.response.messages,
    ];
    const newSessionId = saveSession(sessionDir, input.sessionId, allMessages);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/llm/session-store.test.ts`
Expected: PASS — all tests pass, structured content survives round-trip.

- [ ] **Step 6: Verify the container builds**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/session-store.ts container/agent-runner/src/vercel-runner.ts src/llm/session-store.test.ts
git commit -m "fix(vercel): preserve CoreMessage structure in session store

Stop flattening tool_use/tool_result content parts to strings when
saving Vercel AI SDK sessions. Messages are now stored as-is,
preserving the full CoreMessage[] structure for proper multi-turn
tool conversations on reload."
```

---

## Task 2: MCP Tool Bridging for Vercel Path

The Claude SDK path auto-discovers MCP servers (nanoclaw, Gmail, Notion, SuperPilot) via its `mcpServers` config. The Vercel path currently only has the 4 IPC tools. This task bridges MCP servers into the Vercel runner using `createMCPClient` from the AI SDK with `StdioClientTransport` from `@modelcontextprotocol/sdk`.

**Files:**
- Create: `container/agent-runner/src/mcp-bridge.ts`
- Modify: `container/agent-runner/src/vercel-runner.ts`
- Modify: `container/agent-runner/src/index.ts` (pass MCP config to Vercel path)
- Create: `src/llm/mcp-bridge.test.ts`

### Step Group A: MCP Bridge Module

- [ ] **Step 1: Write the failing test for MCP bridge**

The MCP bridge takes a server config map (same format as `mcpServers` in the Claude SDK config) and returns AI SDK tool objects. We test the config parsing and server spawning logic.

```typescript
// src/llm/mcp-bridge.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('mcp-bridge', () => {
  it('buildMcpServerConfigs parses container MCP config correctly', async () => {
    const { buildMcpServerConfigs } = await import(
      '../../container/agent-runner/src/mcp-bridge.js'
    );

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: true,
    });

    // Should always include the nanoclaw server
    expect(configs).toHaveProperty('nanoclaw');
    expect(configs.nanoclaw.command).toBe('node');
    expect(configs.nanoclaw.env).toHaveProperty('NANOCLAW_CHAT_JID', 'test@chat');
    expect(configs.nanoclaw.env).toHaveProperty('NANOCLAW_GROUP_FOLDER', 'test-group');
    expect(configs.nanoclaw.env).toHaveProperty('NANOCLAW_IS_MAIN', '1');
  });

  it('buildMcpServerConfigs detects Gmail accounts from mounted credentials', async () => {
    const { buildMcpServerConfigs } = await import(
      '../../container/agent-runner/src/mcp-bridge.js'
    );

    // Mock fs.existsSync for Gmail credential detection
    const fs = await import('fs');
    const originalExists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr === '/home/node/.gmail-mcp/credentials.json') return true;
      return originalExists(pathStr);
    });

    const configs = buildMcpServerConfigs({
      chatJid: 'test@chat',
      groupFolder: 'test-group',
      isMain: false,
    });

    expect(configs).toHaveProperty('gmail-personal');

    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/mcp-bridge.test.ts`
Expected: FAIL — `mcp-bridge.js` does not exist.

- [ ] **Step 3: Implement the MCP bridge module**

This module has two responsibilities: (1) build the MCP server config map using the same logic as the Claude SDK path in `index.ts`, and (2) connect to those servers and return AI SDK tools.

```typescript
// container/agent-runner/src/mcp-bridge.ts
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMCPClient, type MCPClient } from 'ai';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(message: string): void {
  console.error(`[mcp-bridge] ${message}`);
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpBridgeInput {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

/**
 * Build the MCP server config map — same servers the Claude SDK path uses.
 * Mirrors the logic in index.ts mcpServers block.
 */
export function buildMcpServerConfigs(
  input: McpBridgeInput,
): Record<string, McpServerConfig> {
  const mcpServerPath = path.join(__dirname, 'nanoclaw-mcp.js');
  const servers: Record<string, McpServerConfig> = {};

  // Nanoclaw IPC MCP server (always registered)
  if (fs.existsSync(mcpServerPath)) {
    servers['nanoclaw'] = {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: input.chatJid,
        NANOCLAW_GROUP_FOLDER: input.groupFolder,
        NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
      },
    };
  }

  // Gmail MCP servers — one per account with mounted credentials
  const gmailAccounts = [
    { name: 'gmail-personal', dir: '.gmail-mcp' },
    { name: 'gmail-whoisxml', dir: '.gmail-mcp-jonathan' },
    { name: 'gmail-attaxion', dir: '.gmail-mcp-attaxion' },
    { name: 'gmail-dev', dir: '.gmail-mcp-dev' },
  ];
  for (const acct of gmailAccounts) {
    const credsPath = `/home/node/${acct.dir}/credentials.json`;
    const oauthPath = `/home/node/${acct.dir}/gcp-oauth.keys.json`;
    if (fs.existsSync(credsPath)) {
      servers[acct.name] = {
        command: 'npx',
        args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
        env: {
          GMAIL_OAUTH_PATH: oauthPath,
          GMAIL_CREDENTIALS_PATH: credsPath,
        },
      };
      log(`Gmail account ${acct.name} registered`);
    }
  }
  // Backwards compat: also register as plain "gmail" pointing to personal
  if (servers['gmail-personal']) {
    servers['gmail'] = servers['gmail-personal'];
  }

  // Notion MCP server
  const notionToken = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
  if (notionToken) {
    servers['notion'] = {
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${notionToken}`,
          'Notion-Version': '2022-06-28',
        }),
      },
    };
    log('Notion MCP server registered');
  }

  // SuperPilot MCP server
  const superpilotApiUrl = process.env.SUPERPILOT_API_URL;
  const serviceToken = process.env.NANOCLAW_SERVICE_TOKEN;
  if (superpilotApiUrl && serviceToken) {
    const superpilotMcpPath = path.join(__dirname, 'superpilot-mcp.js');
    if (fs.existsSync(superpilotMcpPath)) {
      servers['superpilot'] = {
        command: 'node',
        args: [superpilotMcpPath],
        env: {
          SUPERPILOT_API_URL: superpilotApiUrl,
          NANOCLAW_SERVICE_TOKEN: serviceToken,
        },
      };
      log('SuperPilot MCP server registered');
    }
  }

  return servers;
}

/**
 * Connect to MCP servers and return their tools as AI SDK tool definitions.
 * Each server is spawned as a child process via StdioClientTransport.
 * Returns a flat map of tool names to tool objects, plus a cleanup function.
 */
export async function connectMcpServers(
  configs: Record<string, McpServerConfig>,
): Promise<{
  tools: Record<string, unknown>;
  cleanup: () => Promise<void>;
}> {
  const clients: MCPClient[] = [];
  const allTools: Record<string, unknown> = {};

  for (const [name, config] of Object.entries(configs)) {
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env },
      });

      const client = await createMCPClient({
        transport,
        name: `nanoclaw-${name}`,
      });

      clients.push(client);
      const tools = await client.tools();

      // Prefix tool names with server name to avoid collisions
      // e.g., "gmail-personal__search_emails"
      for (const [toolName, toolDef] of Object.entries(tools)) {
        const prefixedName = `mcp__${name}__${toolName}`;
        allTools[prefixedName] = toolDef;
      }

      log(`Connected to MCP server "${name}" — ${Object.keys(tools).length} tools`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to connect to MCP server "${name}": ${errMsg}`);
      // Non-fatal — continue with other servers
    }
  }

  return {
    tools: allTools,
    cleanup: async () => {
      for (const client of clients) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/llm/mcp-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the MCP bridge module**

```bash
git add container/agent-runner/src/mcp-bridge.ts src/llm/mcp-bridge.test.ts
git commit -m "feat(vercel): add MCP tool bridge module

Bridges stdio-based MCP servers (nanoclaw, Gmail, Notion, SuperPilot)
into the Vercel AI SDK path using createMCPClient + StdioClientTransport.
Mirrors the server registration logic from the Claude SDK path."
```

### Step Group B: Wire MCP Bridge into Vercel Runner

- [ ] **Step 6: Update vercel-runner.ts to connect MCP servers**

In `container/agent-runner/src/vercel-runner.ts`, import and use the MCP bridge. MCP tools are merged with IPC tools and passed to `generateText()`.

Add import at the top of the file:

```typescript
import { buildMcpServerConfigs, connectMcpServers } from './mcp-bridge.js';
```

Replace the tools construction and generateText call in `runVercelQuery` (after the `factory` and `model` creation, around line 139) to add MCP tools:

```typescript
    const ipcTools = buildIpcTools(
      '/workspace/ipc',
      input.chatJid,
      input.groupFolder,
    );

    // Connect MCP servers for this session
    const mcpConfigs = buildMcpServerConfigs({
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain,
    });
    const mcpConnection = await connectMcpServers(mcpConfigs);

    // Merge IPC tools and MCP tools into a single tool set
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};

    // IPC tools
    for (const [name, def] of Object.entries(ipcTools)) {
      tools[name] = {
        description: def.description,
        parameters: def.parameters,
        execute: def.execute,
      };
    }

    // MCP tools (already in AI SDK format from createMCPClient)
    for (const [name, def] of Object.entries(mcpConnection.tools)) {
      tools[name] = def;
    }

    log(`Tools registered: ${Object.keys(tools).length} (${Object.keys(ipcTools).length} IPC + ${Object.keys(mcpConnection.tools).length} MCP)`);
```

After the session save and return block (before the `catch`), add MCP cleanup:

```typescript
    // Clean up MCP server connections
    await mcpConnection.cleanup();

    return {
      status: 'success',
      result: result.text,
      newSessionId,
      usage: {
        input_tokens: result.usage?.promptTokens,
        output_tokens: result.usage?.completionTokens,
      },
      numTurns: result.steps.length,
    };
  } catch (err) {
```

Also add cleanup in the catch block to prevent leaked child processes:

```typescript
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Error: ${errorMsg}`);
    // mcpConnection may not exist if error happened before it was created
    // Safe to ignore — StdioClientTransport child processes exit on their own
    return {
      status: 'error',
      result: null,
      error: errorMsg,
    };
  }
```

- [ ] **Step 7: Verify the container builds**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 8: Commit**

```bash
git add container/agent-runner/src/vercel-runner.ts
git commit -m "feat(vercel): wire MCP tool bridge into Vercel runner

Non-Claude agents now get access to the same MCP servers as the Claude
SDK path: nanoclaw IPC, Gmail, Notion, and SuperPilot. Tools are
discovered via createMCPClient + StdioClientTransport and merged with
the existing IPC tools."
```

---

## Task 3: Trust Gateway Integration — Pending Approval Polling

The tool bridge currently has a basic `checkTrust()` that calls the gateway but treats "pending" as a denial. The gateway already supports `GET /trust/approval/:id` for polling. This task adds a poll loop so the agent pauses and waits for user approval, matching the Claude SDK's `preToolUse` hook behavior.

**Files:**
- Modify: `container/agent-runner/src/tool-bridge.ts`
- Create: `src/llm/trust-polling.test.ts`

- [ ] **Step 1: Write the failing test for trust approval polling**

```typescript
// src/llm/trust-polling.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('trust gateway polling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls until approval is granted', async () => {
    // First call: evaluate returns pending
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'pending',
          approval_id: 'apr_123',
          timeout_s: 1800,
        }),
      })
      // Second call: poll returns pending
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'pending' }),
      })
      // Third call: poll returns approved
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'approved' }),
      });

    // Import after mocking fetch
    const { checkTrustWithPolling } = await import(
      '../../container/agent-runner/src/tool-bridge.js'
    );

    const result = await checkTrustWithPolling(
      'send_email',
      'test@chat',
      'test-group',
      'Send an email',
      { pollIntervalMs: 10, maxPollMs: 5000 },
    );

    expect(result.allowed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns denied when approval is denied', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'pending',
          approval_id: 'apr_456',
          timeout_s: 1800,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'denied' }),
      });

    const { checkTrustWithPolling } = await import(
      '../../container/agent-runner/src/tool-bridge.js'
    );

    const result = await checkTrustWithPolling(
      'delete_file',
      'test@chat',
      'test-group',
      'Delete a file',
      { pollIntervalMs: 10, maxPollMs: 5000 },
    );

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/denied/i);
  });

  it('times out and returns denied after maxPollMs', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'pending',
          approval_id: 'apr_789',
          timeout_s: 1800,
        }),
      })
      // All poll attempts return pending
      .mockResolvedValue({
        ok: true,
        json: async () => ({ decision: 'pending' }),
      });

    const { checkTrustWithPolling } = await import(
      '../../container/agent-runner/src/tool-bridge.js'
    );

    const result = await checkTrustWithPolling(
      'send_email',
      'test@chat',
      'test-group',
      'Send an email',
      { pollIntervalMs: 10, maxPollMs: 50 },
    );

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it('auto-approves when gateway returns approved immediately', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ decision: 'approved' }),
    });

    const { checkTrustWithPolling } = await import(
      '../../container/agent-runner/src/tool-bridge.js'
    );

    const result = await checkTrustWithPolling(
      'send_message',
      'test@chat',
      'test-group',
      'Send a chat message',
      { pollIntervalMs: 10, maxPollMs: 5000 },
    );

    expect(result.allowed).toBe(true);
    // Only the initial evaluate call, no polling
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/trust-polling.test.ts`
Expected: FAIL — `checkTrustWithPolling` does not exist.

- [ ] **Step 3: Implement checkTrustWithPolling in tool-bridge.ts**

Add the polling function to `container/agent-runner/src/tool-bridge.ts`. Keep the existing `checkTrust()` for backwards compatibility but add the new function that handles the full pending flow.

Add this above the `buildIpcTools` function in `tool-bridge.ts`:

```typescript
function log(message: string): void {
  console.error(`[tool-bridge] ${message}`);
}

interface TrustPollingOptions {
  pollIntervalMs?: number;
  maxPollMs?: number;
}

/**
 * Check trust with the gateway, and if the decision is "pending",
 * poll until approved/denied/timeout. This matches the Claude SDK's
 * preToolUse hook behavior where the agent pauses until the user
 * approves or denies the action.
 */
export async function checkTrustWithPolling(
  toolName: string,
  chatJid: string,
  groupId: string,
  description?: string,
  options?: TrustPollingOptions,
): Promise<{ allowed: boolean; error?: string }> {
  const gatewayUrl =
    process.env.TRUST_GATEWAY_URL ?? 'http://host.docker.internal:10255';
  const pollInterval = options?.pollIntervalMs ?? 3000;
  const maxPoll = options?.maxPollMs ?? 300_000; // 5 minutes default

  // Step 1: Initial trust evaluation
  let evaluateResult: {
    decision?: string;
    approval_id?: string;
    error?: string;
  };
  try {
    const res = await fetch(`${gatewayUrl}/trust/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: toolName,
        group_id: groupId,
        chat_jid: chatJid,
        description,
      }),
    });
    if (!res.ok) {
      return { allowed: false, error: `Trust gateway returned ${res.status}` };
    }
    evaluateResult = await res.json() as typeof evaluateResult;
  } catch {
    // Gateway unreachable — fail open (container may not have trust enabled)
    return { allowed: true };
  }

  // Auto-approved
  if (evaluateResult.decision === 'approved') {
    return { allowed: true };
  }

  // Not pending — denied or unknown
  if (evaluateResult.decision !== 'pending' || !evaluateResult.approval_id) {
    return {
      allowed: false,
      error: evaluateResult.error ?? 'Trust check denied',
    };
  }

  // Step 2: Poll for approval resolution
  const approvalId = evaluateResult.approval_id;
  log(`Waiting for approval ${approvalId} (tool: ${toolName})`);

  const startTime = Date.now();
  while (Date.now() - startTime < maxPoll) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const pollRes = await fetch(
        `${gatewayUrl}/trust/approval/${approvalId}`,
      );
      if (!pollRes.ok) {
        return {
          allowed: false,
          error: `Poll failed: ${pollRes.status}`,
        };
      }
      const pollResult = (await pollRes.json()) as { decision?: string };

      if (pollResult.decision === 'approved') {
        log(`Approval ${approvalId} granted`);
        return { allowed: true };
      }
      if (
        pollResult.decision === 'denied' ||
        pollResult.decision === 'timeout'
      ) {
        log(`Approval ${approvalId} ${pollResult.decision}`);
        return {
          allowed: false,
          error: `Action ${pollResult.decision} by user`,
        };
      }
      // Still pending — continue polling
    } catch {
      return {
        allowed: false,
        error: 'Lost connection to trust gateway during polling',
      };
    }
  }

  log(`Approval ${approvalId} timed out after ${maxPoll}ms`);
  return {
    allowed: false,
    error: 'Approval timed out waiting for user response',
  };
}
```

- [ ] **Step 4: Replace checkTrust calls with checkTrustWithPolling in tool execute functions**

In `container/agent-runner/src/tool-bridge.ts`, update each tool's `execute` function to use `checkTrustWithPolling` instead of `checkTrust`. Replace the four `checkTrust(...)` calls:

For `send_message`:
```typescript
      execute: async ({ text }: { text: string }) => {
        const trust = await checkTrustWithPolling('send_message', chatJid, groupId, 'Send a chat message');
        if (!trust.allowed) return { success: false, error: trust.error };
```

For `schedule`:
```typescript
      execute: async ({ when, prompt, label }: { when: string; prompt: string; label?: string }) => {
        const trust = await checkTrustWithPolling('schedule', chatJid, groupId, `Schedule task: ${label ?? prompt.slice(0, 60)}`);
        if (!trust.allowed) return { success: false, error: trust.error };
```

For `relay_message`:
```typescript
      execute: async ({ text }: { text: string }) => {
        const trust = await checkTrustWithPolling('relay_message', chatJid, groupId, 'Relay message to main channel');
        if (!trust.allowed) return { success: false, error: trust.error };
```

Then remove the old `checkTrust` function (lines 17-49 in the original file) since it is fully replaced by `checkTrustWithPolling`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/llm/trust-polling.test.ts`
Expected: PASS — all 4 tests pass.

- [ ] **Step 6: Verify the container builds**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/tool-bridge.ts src/llm/trust-polling.test.ts
git commit -m "feat(vercel): add trust gateway approval polling

Replace fire-and-forget checkTrust with checkTrustWithPolling that
handles the pending flow: poll GET /trust/approval/:id until the user
approves/denies via chat, or timeout after 5 minutes. Matches the
Claude SDK preToolUse hook behavior."
```

---

## Task 4: `switch_model` IPC Command

Allow agents to dynamically switch their LLM model mid-conversation. The agent writes a `switch_model` IPC file, the host reads it and stores the override for the group's next container spawn. This is useful for agents that want to escalate to a stronger model for a specific sub-task.

**Files:**
- Modify: `container/agent-runner/src/tool-bridge.ts` (add switch_model tool)
- Modify: `src/ipc.ts` (add switch_model handler)
- Create: `src/llm/switch-model.test.ts`

### Step Group A: Host-side IPC Handler

- [ ] **Step 1: Write the failing test for switch_model IPC handler**

```typescript
// src/llm/switch-model.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processTaskIpc, type IpcDeps } from '../ipc.js';

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: vi.fn().mockReturnValue({
      'test@chat': {
        name: 'Test',
        folder: 'test-group',
        trigger: '!test',
        added_at: new Date().toISOString(),
        containerConfig: {},
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    enqueueEmailTrigger: vi.fn(),
    ...overrides,
  };
}

describe('switch_model IPC handler', () => {
  it('updates the group containerConfig with new provider and model', async () => {
    const registerGroup = vi.fn();
    const deps = makeDeps({ registerGroup });

    await processTaskIpc(
      {
        type: 'switch_model',
        provider: 'google',
        model: 'gemini-2.5-pro',
        chatJid: 'test@chat',
      },
      'test-group',
      false,
      deps,
    );

    expect(registerGroup).toHaveBeenCalledTimes(1);
    const [jid, group] = registerGroup.mock.calls[0];
    expect(jid).toBe('test@chat');
    expect(group.containerConfig.llm.provider).toBe('google');
    expect(group.containerConfig.llm.model).toBe('gemini-2.5-pro');
  });

  it('rejects switch_model from non-matching group', async () => {
    const registerGroup = vi.fn();
    const deps = makeDeps({ registerGroup });

    await processTaskIpc(
      {
        type: 'switch_model',
        provider: 'openai',
        model: 'gpt-4o',
        chatJid: 'test@chat',
      },
      'different-group', // Not the group that owns test@chat
      false,
      deps,
    );

    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('allows main group to switch_model for any group', async () => {
    const registerGroup = vi.fn();
    const deps = makeDeps({ registerGroup });

    await processTaskIpc(
      {
        type: 'switch_model',
        provider: 'openai',
        model: 'gpt-4o',
        chatJid: 'test@chat',
      },
      'main-group',
      true, // isMain
      deps,
    );

    expect(registerGroup).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/switch-model.test.ts`
Expected: FAIL — `processTaskIpc` does not handle `switch_model` type.

- [ ] **Step 3: Add switch_model handler to IPC watcher**

In `src/ipc.ts`, add the `switch_model` case to the `processTaskIpc` switch statement. Add it before the `default` case. Also add the new fields to the `data` type parameter.

First, add the new fields to the `data` parameter type in `processTaskIpc`:

```typescript
    // For switch_model
    provider?: string;
    model?: string;
```

Then add the case handler:

```typescript
    case 'switch_model': {
      const targetJid = data.chatJid;
      if (!targetJid || !data.provider) {
        logger.warn({ sourceGroup }, 'switch_model: missing chatJid or provider');
        break;
      }

      const targetGroup = registeredGroups[targetJid];
      if (!targetGroup) {
        logger.warn({ targetJid }, 'switch_model: target group not registered');
        break;
      }

      // Authorization: non-main groups can only switch their own model
      if (!isMain && targetGroup.folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder: targetGroup.folder },
          'Unauthorized switch_model attempt blocked',
        );
        break;
      }

      // Update the group's LLM config
      const updatedConfig = { ...targetGroup.containerConfig } ?? {};
      updatedConfig.llm = {
        ...updatedConfig.llm,
        provider: data.provider as LlmConfig['provider'],
        model: data.model ?? updatedConfig.llm?.model,
      };

      deps.registerGroup(targetJid, {
        ...targetGroup,
        containerConfig: updatedConfig,
      });

      logger.info(
        {
          targetJid,
          sourceGroup,
          provider: data.provider,
          model: data.model,
        },
        'Model switched via IPC',
      );
      break;
    }
```

Also add the import for `LlmConfig` at the top of `src/ipc.ts`:

```typescript
import type { RegisteredGroup, LlmConfig } from './types.js';
```

(Replace the existing `import { RegisteredGroup } from './types.js';` line.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/llm/switch-model.test.ts`
Expected: PASS — all 3 tests pass.

- [ ] **Step 5: Commit the host-side handler**

```bash
git add src/ipc.ts src/llm/switch-model.test.ts
git commit -m "feat(ipc): add switch_model IPC command handler

Agents can now switch their group's LLM provider and model by writing
a switch_model IPC file. Authorization enforced: non-main groups can
only change their own model."
```

### Step Group B: Container-side Tool

- [ ] **Step 6: Add switch_model tool to the Vercel tool bridge**

In `container/agent-runner/src/tool-bridge.ts`, add a `switch_model` tool to the `buildIpcTools` return object. This tool does NOT go through trust (it only affects the agent's own group config — it is a self-directed action, not an external effect).

Add this to the return object in `buildIpcTools`, after `learn_feedback`:

```typescript
    switch_model: {
      description:
        'Switch the LLM model for this group. Use this to escalate to a stronger model for complex tasks, or switch to a cheaper model for simple follow-ups. The change takes effect on the next message.',
      parameters: z.object({
        provider: z
          .enum(['anthropic', 'openai', 'google', 'ollama', 'groq', 'together'])
          .describe('The LLM provider to switch to'),
        model: z
          .string()
          .optional()
          .describe(
            'Model identifier (e.g. "gpt-4o", "gemini-2.5-pro"). If omitted, uses provider default.',
          ),
      }),
      execute: async ({
        provider,
        model,
      }: {
        provider: string;
        model?: string;
      }) => {
        writeIpcFile(messagesDir, {
          type: 'switch_model',
          chatJid,
          groupFolder,
          provider,
          model,
        });
        return { success: true };
      },
    },
```

- [ ] **Step 7: Verify the container builds**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 8: Commit the container-side tool**

```bash
git add container/agent-runner/src/tool-bridge.ts
git commit -m "feat(vercel): add switch_model tool to Vercel tool bridge

Agents running on the Vercel path can now call switch_model to change
their LLM provider/model mid-conversation. The IPC file is picked up
by the host's switch_model handler."
```

---

## Post-Implementation Verification

After all tasks complete:

1. **Type check both projects:**
   - `npx tsc --noEmit` (host)
   - `cd container/agent-runner && npx tsc --noEmit` (container)

2. **Run all new tests:**
   - `npx vitest run src/llm/session-store.test.ts`
   - `npx vitest run src/llm/mcp-bridge.test.ts`
   - `npx vitest run src/llm/trust-polling.test.ts`
   - `npx vitest run src/llm/switch-model.test.ts`

3. **Run the full test suite:**
   - `npx vitest run`

4. **Rebuild the container:**
   - `./container/build.sh`

5. **Manual smoke test:** Configure a test group with `openai/gpt-4o-mini`, send a message that triggers tool use (e.g., "search my emails"), verify MCP tools are discovered, trust polling works for write operations, and the session preserves tool call structure across messages.
