import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

import {
  createInitialAppServerTurnState,
  getAppServerTurnResult,
  isAppServerTurnFinished,
  reduceAppServerTurnState,
  type AppServerTurnEvent,
  type AppServerTurnState,
} from './app-server-state.js';

export interface AppServerInputItemText {
  type: 'text';
  text: string;
  text_elements: [];
}

export interface AppServerInputItemLocalImage {
  type: 'localImage';
  path: string;
}

export type AppServerInputItem =
  | AppServerInputItemText
  | AppServerInputItemLocalImage;

export interface CodexAppServerThreadOptions {
  cwd: string;
  model?: string;
  baseInstructions?: string;
}

export interface CodexAppServerTurnOptions {
  cwd: string;
  model?: string;
  effort?: string;
  onProgress?: (message: string) => void;
}

export interface CodexAppServerTurnResult {
  state: AppServerTurnState;
  result: string | null;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface ActiveTurn {
  threadId: string;
  state: AppServerTurnState;
  onProgress?: (message: string) => void;
  resolve: (value: CodexAppServerTurnResult) => void;
  reject: (reason?: unknown) => void;
}

export interface CodexAppServerClientOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

const CODEX_BIN = process.env.CODEX_BIN || '/opt/homebrew/bin/codex';

export class CodexAppServerClient {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = '';
  private activeTurn: ActiveTurn | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.cwd = options.cwd;
    this.env = options.env || process.env;
    this.log = options.log;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn(CODEX_BIN, ['app-server'], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleStdoutLine(trimmed);
      }
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.log(`[app-server] ${trimmed}`);
      }
    });

    this.proc.on('close', (code) => {
      const error = new Error(
        `Codex app-server exited with code ${code ?? 'unknown'}`,
      );
      this.rejectAll(error);
    });

    this.proc.on('error', (error) => {
      this.rejectAll(error);
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'nanoclaw_codex_runner',
        title: 'NanoClaw Codex Runner',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'item/agentMessage/delta',
          'item/plan/delta',
          'item/reasoning/textDelta',
          'item/reasoning/summaryTextDelta',
          'item/reasoning/summaryPartAdded',
        ],
      },
    });
    this.notify('initialized', {});
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  async startOrResumeThread(
    sessionId: string | undefined,
    options: CodexAppServerThreadOptions,
  ): Promise<string> {
    const commonParams = {
      cwd: options.cwd,
      model: options.model,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      serviceName: 'nanoclaw',
      baseInstructions: options.baseInstructions,
      persistExtendedHistory: true,
    };

    const result = sessionId
      ? await this.request('thread/resume', {
          threadId: sessionId,
          ...commonParams,
        })
      : await this.request('thread/start', {
          ...commonParams,
          experimentalRawEvents: false,
        });

    const thread = (result as { thread?: { id?: string } }).thread;
    if (!thread?.id) {
      throw new Error('Codex app-server did not return a thread id.');
    }
    return thread.id;
  }

  async startTurn(
    threadId: string,
    input: AppServerInputItem[],
    options: CodexAppServerTurnOptions,
  ): Promise<{
    turnId: string;
    steer: (nextInput: AppServerInputItem[]) => Promise<void>;
    interrupt: () => Promise<void>;
    wait: () => Promise<CodexAppServerTurnResult>;
  }> {
    if (this.activeTurn) {
      throw new Error('A Codex app-server turn is already active.');
    }

    const turnPromise = new Promise<CodexAppServerTurnResult>((resolve, reject) => {
      this.activeTurn = {
        threadId,
        state: createInitialAppServerTurnState(),
        onProgress: options.onProgress,
        resolve,
        reject,
      };
    });

    let turnId = '';
    try {
      const response = (await this.request('turn/start', {
        threadId,
        input,
        cwd: options.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [options.cwd],
          readOnlyAccess: { type: 'fullAccess' },
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        model: options.model,
        effort: options.effort,
        summary: 'concise',
      })) as { turn?: { id?: string; status?: string } };

      turnId = response.turn?.id || '';
      if (!turnId) {
        throw new Error('Codex app-server did not return a turn id.');
      }

      const activeTurn = this.activeTurn as ActiveTurn | null;
      if (activeTurn !== null) {
        activeTurn.state = reduceAppServerTurnState(activeTurn.state, {
          method: 'turn/started',
          params: {
            turn: {
              id: turnId,
              status: response.turn?.status || 'inProgress',
            },
          },
        });
      }
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }

    return {
      turnId,
      steer: async (nextInput: AppServerInputItem[]) => {
        await this.request('turn/steer', {
          threadId,
          input: nextInput,
          expectedTurnId: turnId,
        });
      },
      interrupt: async () => {
        await this.request('turn/interrupt', {
          threadId,
          turnId,
        });
      },
      wait: async () => turnPromise,
    };
  }

  private handleStdoutLine(line: string): void {
    let payload: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;
    try {
      payload = JSON.parse(line);
    } catch {
      this.log(`Failed to parse JSON-RPC line: ${line.slice(0, 200)}`);
      return;
    }

    if ('id' in payload && !('method' in payload)) {
      this.handleResponse(payload);
      return;
    }

    if ('id' in payload && 'method' in payload) {
      this.handleServerRequest(payload);
      return;
    }

    this.handleNotification(payload);
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(
        new Error(
          response.error.message ||
            `Codex app-server request failed: ${pending.method}`,
        ),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    this.log(`Unexpected server request: ${request.method}`);
    this.write({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (!this.activeTurn) return;

    const event = notification as AppServerTurnEvent;
    this.activeTurn.state = reduceAppServerTurnState(this.activeTurn.state, event);

    if (notification.method === 'item/completed') {
      const item = notification.params?.item as
        | { type?: string; text?: string | null; phase?: string | null }
        | undefined;
      if (
        item?.type === 'agentMessage' &&
        item.phase !== 'final_answer' &&
        typeof item.text === 'string' &&
        item.text.trim()
      ) {
        this.activeTurn.onProgress?.(item.text.trim());
      }
    }

    if (isAppServerTurnFinished(this.activeTurn.state)) {
      const activeTurn = this.activeTurn;
      this.activeTurn = null;
      if (
        activeTurn.state.status === 'failed' ||
        activeTurn.state.status === 'interrupted'
      ) {
        activeTurn.reject(
          new Error(
            activeTurn.state.errorMessage ||
              `Codex turn ${activeTurn.state.status}.`,
          ),
        );
        return;
      }

      activeTurn.resolve({
        state: activeTurn.state,
        result: getAppServerTurnResult(activeTurn.state),
      });
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    this.write({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private write(payload: unknown): void {
    if (!this.proc) {
      throw new Error('Codex app-server is not running.');
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

    if (this.activeTurn) {
      this.activeTurn.reject(error);
      this.activeTurn = null;
    }
  }
}
