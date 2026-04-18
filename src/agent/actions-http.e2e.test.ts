/**
 * End-to-end reproducer for "Actions HTTP server not configured" warning.
 *
 * Drives the real ActionsHttp host code AND the real container-side shim
 * (container/agent-runner/dist/ipc-mcp-stdio.js) over its actual stdio
 * MCP transport. The shim throws its warning only when an action tool is
 * invoked, so each case issues a real `tools/call` to prove behavior
 * rather than guessing from static reading.
 *
 * Layout of cases (see plan file why-agent-complain-concurrent-kazoo.md):
 *   A — host-side: loopback-only interfaces disable the server
 *   B — plumbing: null mint produces undefined actionsAuth
 *   C — shim: missing env vars surface the exact warning on tools/call
 *   D — healthy path: LAN IP → shim reaches host handler over HTTP
 *   E — negative: bogus token is rejected and bubbles back through stdio
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import url from 'url';
import fs from 'fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { z } from 'zod';

import { ActionsHttp } from './actions-http.js';
import { logger } from '../logger.js';
import type { RegisteredAction } from '../api/action.js';

// ─── Resolve the built shim path ────────────────────────────────────

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SHIM_PATH = path.join(
  repoRoot,
  'container',
  'agent-runner',
  'dist',
  'ipc-mcp-stdio.js',
);

if (!fs.existsSync(SHIM_PATH)) {
  throw new Error(
    `E2E prerequisite missing: ${SHIM_PATH}\n` +
      `Run \`cd container/agent-runner && npm run build\` (or ./container/build.sh) before this test.`,
  );
}

// ─── Minimal stdio MCP client ───────────────────────────────────────
// Newline-delimited JSON-RPC. The SDK's own client isn't a root
// dependency, and the wire format is trivial, so inline it.

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioMcpClient {
  private nextId = 1;
  private pending = new Map<number, (res: JsonRpcResponse) => void>();
  private stdoutBuffer = '';
  public stderr = '';

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      let idx: number;
      while ((idx = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, idx).replace(/\r$/, '');
        this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (typeof msg.id === 'number') {
          const cb = this.pending.get(msg.id);
          if (cb) {
            this.pending.delete(msg.id);
            cb(msg);
          }
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  async request(
    method: string,
    params: unknown = {},
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request ${method} #${id} timed out. stderr so far:\n${this.stderr}`,
          ),
        );
      }, 5000);
      this.pending.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.proc.stdin.write(payload + '\n');
    });
  }

  async initialize(): Promise<void> {
    const res = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '0.0.0' },
    });
    if (res.error) {
      throw new Error(`initialize failed: ${res.error.message}`);
    }
    // MCP spec: send initialized notification after initialize reply
    this.proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) {
      throw new Error(
        `tools/call ${name} returned JSON-RPC error: ${res.error.message}`,
      );
    }
    return res.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
  }
}

function spawnShim(extraEnv: Record<string, string>): {
  proc: ChildProcessWithoutNullStreams;
  client: StdioMcpClient;
} {
  const proc = spawn('node', [SHIM_PATH], {
    env: {
      PATH: process.env.PATH ?? '',
      // Minimum the shim reads at module init; writeIpcFile isn't
      // exercised by search_actions/call_action so the unreachable
      // /workspace/ipc path is fine.
      AGENTLITE_CHAT_JID: 'test-jid',
      AGENTLITE_GROUP_FOLDER: 'test-group',
      AGENTLITE_IS_MAIN: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const client = new StdioMcpClient(proc);
  return { proc, client };
}

async function terminate(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 1500);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ─── Action registry helper ─────────────────────────────────────────

function registerEcho(
  actions: Map<string, RegisteredAction>,
  calls: Array<Record<string, unknown>>,
): void {
  actions.set('echo_action', {
    description: 'Echo back the payload for e2e verification.',
    inputSchema: { message: z.string() },
    handler: async (payload) => {
      calls.push(payload);
      return { echoed: payload.message };
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('ActionsHttp e2e reproducer', () => {
  let server: ActionsHttp | null = null;
  let spawned: ChildProcessWithoutNullStreams | null = null;

  afterEach(async () => {
    if (spawned) {
      await terminate(spawned);
      spawned = null;
    }
    if (server) {
      await server.stop();
      server = null;
    }
    vi.restoreAllMocks();
  });

  // Case A: loopback-only interfaces disable the server
  it('A: start() returns null and warns when only loopback IPv4 is available', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo0: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    });
    const warnSpy = vi.spyOn(logger, 'warn');

    server = new ActionsHttp(() => new Map());
    const info = await server.start();

    expect(info).toBeNull();
    const warnedMessages = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
    expect(
      warnedMessages.some((m) => m.includes('No non-loopback IPv4 interface')),
    ).toBe(true);
    expect(server.mintContainerToken('grp', true)).toBeNull();
  });

  // Case B: the message-processor ternary produces undefined when mint returns null.
  // This mirrors src/agent/message-processor.ts:387-389 exactly.
  it('B: null mint flows to actionsAuth=undefined and omitted env vars', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({});
    server = new ActionsHttp(() => new Map());
    await server.start();
    const actionAuth = server.mintContainerToken('grp', true);

    const actionsAuth = actionAuth
      ? { url: actionAuth.url, token: actionAuth.token }
      : undefined;
    expect(actionsAuth).toBeUndefined();

    // Mirrors container/agent-runner/src/index.ts:570-575
    const env: Record<string, string> = {};
    if (actionsAuth) {
      env.AGENTLITE_ACTIONS_URL = (actionsAuth as { url: string }).url;
      env.AGENTLITE_ACTIONS_TOKEN = (actionsAuth as { token: string }).token;
    }
    expect(env.AGENTLITE_ACTIONS_URL).toBeUndefined();
    expect(env.AGENTLITE_ACTIONS_TOKEN).toBeUndefined();
  });

  // Case C: shim returns the exact warning when action tools are invoked without env vars.
  it('C: shim surfaces "Actions HTTP server not configured" on tools/call without env vars', async () => {
    const { proc, client } = spawnShim({});
    spawned = proc;

    await client.initialize();
    const result = await client.callTool('search_actions', {
      query: 'anything',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Actions HTTP server not configured — AGENTLITE_ACTIONS_URL / TOKEN missing',
    );
  }, 15_000);

  // Case D: healthy path end-to-end. Skipped if the runner has no LAN IPv4.
  const hasLanIp = Object.values(os.networkInterfaces()).some((list) =>
    (list ?? []).some((a) => a.family === 'IPv4' && !a.internal),
  );
  it.skipIf(!hasLanIp)(
    'D: LAN IP present — shim reaches host handler over HTTP',
    async () => {
      const actions = new Map<string, RegisteredAction>();
      const calls: Array<Record<string, unknown>> = [];
      registerEcho(actions, calls);
      server = new ActionsHttp(() => actions);
      const info = await server.start();
      expect(info).not.toBeNull();
      const minted = server!.mintContainerToken('grp', true);
      expect(minted).not.toBeNull();

      const { proc, client } = spawnShim({
        AGENTLITE_ACTIONS_URL: minted!.url,
        AGENTLITE_ACTIONS_TOKEN: minted!.token,
      });
      spawned = proc;
      await client.initialize();

      const result = await client.callTool('call_action', {
        name: 'echo_action',
        payload: { message: 'hello-from-e2e' },
      });

      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ message: 'hello-from-e2e' });
      expect(result.content[0]?.text).toContain('hello-from-e2e');
    },
    15_000,
  );

  // Case E: bogus token is rejected end-to-end via shim → host.
  it.skipIf(!hasLanIp)(
    'E: wrong token is rejected with 401 surfaced through stdio',
    async () => {
      const actions = new Map<string, RegisteredAction>();
      registerEcho(actions, []);
      server = new ActionsHttp(() => actions);
      const info = await server.start();
      expect(info).not.toBeNull();

      const { proc, client } = spawnShim({
        AGENTLITE_ACTIONS_URL: info!.url,
        AGENTLITE_ACTIONS_TOKEN: 'not-a-real-token',
      });
      spawned = proc;
      await client.initialize();

      const result = await client.callTool('call_action', {
        name: 'echo_action',
        payload: { message: 'nope' },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text.toLowerCase()).toContain('unauthorized');
    },
    15_000,
  );
});
