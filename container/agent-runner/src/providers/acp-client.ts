/**
 * Agent Client Protocol (ACP) provider.
 *
 * ACP (https://agentclientprotocol.com) is a JSON-RPC 2.0 protocol where
 * NanoClaw acts as the client, spawning an AI agent subprocess and
 * communicating over stdin/stdout, or connecting to one over TCP.
 *
 * Per-turn flow: initialize → session/new → session/prompt → collect
 * session/update notifications → session/prompt response (stopReason=done)
 *
 * Config (injected by host-side src/providers/acp-client.ts):
 *   ACP_CLIENT_CMD   — JSON array: command + args for subprocess mode
 *   ACP_CLIENT_HOST  — hostname for TCP mode
 *   ACP_CLIENT_PORT  — port for TCP mode (used with ACP_CLIENT_HOST)
 */
import fs from 'fs';
import path from 'path';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

// ── JSON-RPC 2.0 types ──────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

function isRpcResponse(msg: RpcMessage): msg is RpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isRpcRequest(msg: RpcMessage): msg is RpcRequest {
  return 'id' in msg && 'method' in msg;
}

// ── Line reader ─────────────────────────────────────────────────────────────

export class LineReader {
  private buf = '';
  private lines: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private ended = false;

  feed(chunk: string): void {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop()!;
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (this.waiters.length > 0) this.waiters.shift()!(trimmed);
      else this.lines.push(trimmed);
    }
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters) w(null);
    this.waiters = [];
  }

  readLine(): Promise<string | null> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

// ── Transport interface ─────────────────────────────────────────────────────

export interface AcpTransport {
  write(msg: string): void;
  readLine(): Promise<string | null>;
  close(): void;
}

// ── Subprocess transport ────────────────────────────────────────────────────

export async function connectSubprocess(cmd: string[]): Promise<AcpTransport> {
  const [prog, ...args] = cmd;
  const proc = Bun.spawn([prog, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const reader = new LineReader();
  const dec = new TextDecoder();

  (async () => {
    const r = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        reader.feed(dec.decode(value));
      }
    } finally {
      reader.end();
    }
  })().catch(() => reader.end());

  return {
    write(msg) {
      proc.stdin.write(msg + '\n');
      proc.stdin.flush();
    },
    readLine: () => reader.readLine(),
    close() { try { proc.kill(); } catch { /* already dead */ } },
  };
}

// ── TCP transport ───────────────────────────────────────────────────────────

export async function connectTcp(host: string, port: number): Promise<AcpTransport> {
  const reader = new LineReader();
  const dec = new TextDecoder();

  return new Promise<AcpTransport>((resolve, reject) => {
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          resolve({
            write(msg) { socket.write(msg + '\n'); },
            readLine: () => reader.readLine(),
            close() { try { socket.end(); } catch { /* ignore */ } },
          });
        },
        data(_socket, data) { reader.feed(dec.decode(data)); },
        close() { reader.end(); },
        error(_socket, err) { reader.end(); reject(err); },
      },
    }).catch(reject);
  });
}

// ── JSON-RPC dispatcher ─────────────────────────────────────────────────────

export class JsonRpcDispatcher {
  private idSeq = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: unknown) => void }>();
  private notifHandlers = new Map<string, (params: unknown) => void>();
  private reqHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  constructor(private transport: AcpTransport) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.idSeq++;
    this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notifHandlers.set(method, handler);
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.reqHandlers.set(method, handler);
  }

  dispatch(line: string): void {
    let msg: RpcMessage;
    try { msg = JSON.parse(line) as RpcMessage; } catch { return; }

    if (isRpcResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (isRpcRequest(msg)) {
      const handler = this.reqHandlers.get(msg.method);
      const respond = (result: unknown) =>
        this.transport.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      const respondErr = (code: number, message: string) =>
        this.transport.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }));
      if (handler) {
        handler(msg.params).then(respond).catch(e => respondErr(-32603, e instanceof Error ? e.message : String(e)));
      } else {
        respondErr(-32601, `Method not found: ${msg.method}`);
      }
    } else {
      // Notification (no id, has method)
      const p = msg as RpcNotification;
      if ('method' in p) this.notifHandlers.get(p.method)?.(p.params);
    }
  }

  async pumpLoop(): Promise<void> {
    while (true) {
      const line = await this.transport.readLine();
      if (line === null) {
        for (const { reject } of this.pending.values()) reject(new Error('Connection closed'));
        this.pending.clear();
        return;
      }
      this.dispatch(line);
    }
  }
}

// ── Workspace path guard ────────────────────────────────────────────────────

const WORKSPACE = '/workspace';

function resolveWorkspacePath(uri: string): string | null {
  let filePath = uri;
  if (filePath.startsWith('file://')) filePath = decodeURIComponent(filePath.slice(7));
  if (!path.isAbsolute(filePath)) filePath = path.join(WORKSPACE, filePath);
  const resolved = path.resolve(filePath);
  if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) return null;
  return resolved;
}

// ── Injectable transport factory (overridden in tests) ──────────────────────

export const _test = {
  createTransport: async (cmd: string[] | null, host: string | null, port: number | null): Promise<AcpTransport> => {
    if (cmd) return connectSubprocess(cmd);
    return connectTcp(host!, port!);
  },
};

// ── Provider ────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.error(`[acp-client-provider] ${msg}`);
}

export class AcpClientProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly cmd: string[] | null;
  private readonly host: string | null;
  private readonly port: number | null;

  constructor(_options: ProviderOptions = {}) {
    const cmdEnv = process.env.ACP_CLIENT_CMD;
    this.cmd = cmdEnv ? (JSON.parse(cmdEnv) as string[]) : null;
    this.host = process.env.ACP_CLIENT_HOST || null;
    this.port = process.env.ACP_CLIENT_PORT ? parseInt(process.env.ACP_CLIENT_PORT, 10) : null;

    if (!this.cmd && !(this.host && this.port)) {
      throw new Error('ACP_CLIENT_CMD or ACP_CLIENT_HOST+ACP_CLIENT_PORT required for acp-client provider');
    }
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /session.*not found|invalid state|connection closed/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    let aborted = false;
    const { cmd, host, port } = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      if (aborted) return;

      // ── Connect ──────────────────────────────────────────────────────────
      let transport: AcpTransport;
      try {
        transport = await _test.createTransport(cmd, host, port);
      } catch (e) {
        yield { type: 'error', message: `Failed to connect to ACP agent: ${e instanceof Error ? e.message : String(e)}`, retryable: true };
        return;
      }

      const rpc = new JsonRpcDispatcher(transport);

      // Serve fs/ requests from /workspace
      rpc.onRequest('fs/read_text_file', async (params) => {
        const { uri } = params as { uri: string };
        const resolved = resolveWorkspacePath(uri);
        if (!resolved) throw new Error(`Path outside workspace: ${uri}`);
        return { content: fs.readFileSync(resolved, 'utf-8') };
      });

      rpc.onRequest('fs/write_text_file', async (params) => {
        const { uri, content } = params as { uri: string; content: string };
        const resolved = resolveWorkspacePath(uri);
        if (!resolved) throw new Error(`Path outside workspace: ${uri}`);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf-8');
        return {};
      });

      // Accumulate streamed message chunks from session/update notifications
      const chunks: string[] = [];
      rpc.onNotification('session/update', (params) => {
        const p = params as { update?: { kind: string; content?: unknown } };
        if (p?.update?.kind !== 'agent_message_chunk') return;
        const c = p.update.content as { content?: Array<{ type: string; text?: string }> } | undefined;
        const text = (c?.content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');
        if (text) chunks.push(text);
      });

      // Start pump loop — runs concurrently with the request awaits below
      rpc.pumpLoop().catch(() => {});

      try {
        // ── initialize ────────────────────────────────────────────────────
        if (aborted) { transport.close(); return; }
        yield { type: 'activity' };

        await rpc.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'nanoclaw', version: '1.0.0' },
          capabilities: {
            fileSystem: { readTextFile: true, writeTextFile: true },
            terminal: { create: false, output: false, waitForExit: false, kill: false, release: false },
            prompts: { audio: false, image: false, embeddedContext: false },
          },
          authenticationMethods: [],
        });

        // ── session/new ───────────────────────────────────────────────────
        if (aborted) { transport.close(); return; }

        const sessionResult = (await rpc.request('session/new', { cwd: WORKSPACE })) as { sessionId: string };
        const sessionId = sessionResult.sessionId;
        log(`session created: ${sessionId}`);
        yield { type: 'init', continuation: sessionId };

        // ── session/prompt ────────────────────────────────────────────────
        if (aborted) { transport.close(); return; }
        yield { type: 'activity' };

        const promptResult = (await rpc.request('session/prompt', {
          sessionId,
          content: [{ type: 'text', text: input.prompt }],
        })) as { content?: Array<{ type: string; text?: string }>; stopReason: string };

        if (promptResult.stopReason === 'cancelled') {
          yield { type: 'error', message: 'ACP session prompt was cancelled', retryable: false };
          return;
        }

        // Merge streamed chunks + any inline text in the final response
        const inlineText = (promptResult.content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');

        const fullText = [...chunks, inlineText].join('').trim() || null;
        log(`session ${sessionId} done (${promptResult.stopReason}), ${fullText?.length ?? 0} chars`);
        yield { type: 'result', text: fullText };
      } catch (e) {
        if (!aborted) {
          yield {
            type: 'error',
            message: `ACP client error: ${e instanceof Error ? e.message : String(e)}`,
            retryable: true,
          };
        }
      } finally {
        transport.close();
      }
    }

    return {
      push: () => { log('push() no-op on acp-client (single-turn per session)'); },
      end: () => {},
      events: gen(),
      abort: () => { aborted = true; },
    };
  }
}

registerProvider('acp-client', (opts) => new AcpClientProvider(opts));
