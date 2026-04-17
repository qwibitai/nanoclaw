import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeEach } from 'vitest';

/**
 * Shared state for all MCP ipc-stdio test files. Tests spawn the built
 * `dist/ipc-mcp-stdio.js` as a child process via an MCP stdio client,
 * so per-test sandbox dirs must be re-created before each case.
 */
export interface McpTestContext {
  readonly ipcDir: string;
  readonly groupDir: string;
  readonly tasksDir: string;
  readonly messagesDir: string;
}

let current: {
  ipcDir: string;
  groupDir: string;
  tasksDir: string;
  messagesDir: string;
} | null = null;

/**
 * Install the harness's `beforeEach` hook. Call at module scope in each
 * test file. Returns a context object whose fields read through to the
 * current per-test paths.
 */
export function setupMcpHarness(): McpTestContext {
  beforeEach(() => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
    current = {
      ipcDir,
      groupDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-group-')),
      tasksDir: path.join(ipcDir, 'tasks'),
      messagesDir: path.join(ipcDir, 'messages'),
    };
  });

  return {
    get ipcDir() {
      return current!.ipcDir;
    },
    get groupDir() {
      return current!.groupDir;
    },
    get tasksDir() {
      return current!.tasksDir;
    },
    get messagesDir() {
      return current!.messagesDir;
    },
  };
}

export async function createClient(
  env: Record<string, string>,
): Promise<Client> {
  const serverPath = path.resolve(
    import.meta.dirname,
    '../dist/ipc-mcp-stdio.js',
  );
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) childEnv[k] = v;
  }
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: childEnv,
  });
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

export function readIpcFiles(dir: string): object[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

export function defaultEnv(ctx: McpTestContext): Record<string, string> {
  return {
    NANOCLAW_IPC_DIR: ctx.ipcDir,
    NANOCLAW_GROUP_DIR: ctx.groupDir,
    NANOCLAW_CHAT_JID: 'tg:123',
    NANOCLAW_GROUP_FOLDER: 'telegram_main',
    NANOCLAW_IS_MAIN: '1',
  };
}
