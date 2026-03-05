/**
 * WebSocket IPC Server for NanoClaw
 * Replaces file-based IPC with a single WS server for all containers.
 * Connections are authenticated via Authorization header during HTTP upgrade.
 * All messages use JSON-RPC 2.0 via json-rpc-2.0 library.
 */
import crypto from 'crypto';
import { IncomingMessage } from 'http';

import {
  JSONRPCClient,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0';
import WebSocket, { WebSocketServer } from 'ws';

import { WS_BIND_ADDRESS } from './config.js';
import { AvailableGroup, ContainerOutput } from './container-runner.js';
import { getRegisteredHandlers, HandlerContext } from './ipc-handlers/registry.js';
import { logger } from './logger.js';

const PING_INTERVAL_MS = 30_000;

// Custom WebSocket close codes (4000–4999 range is application-defined)
const WS_CLOSE_TOKEN_REVOKED = 4004;

interface TypedConnection {
  ws: WebSocket;
  role: 'agent' | 'mcp';
  rpc: JSONRPCServerAndClient;
}

interface TokenContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  connections: TypedConnection[];
  onOutput?: (output: ContainerOutput) => Promise<void>;
  resetTimeout?: () => void;
  /** Called when all agent connections are lost and grace period expires */
  onOrphaned?: () => void;
  /** Per-token promise chain to order output callbacks */
  outputChain: Promise<void>;
  /** Grace timer for reconnection after all connections drop */
  graceTimer?: ReturnType<typeof setTimeout>;
}

export interface CreateTokenOpts {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  resetTimeout?: () => void;
  onOrphaned?: () => void;
}

export interface WsIpcServerDeps {
  getTasksSnapshot: (
    groupFolder: string,
    isMain: boolean,
  ) => Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>;
  getGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
  ) => { groups: AvailableGroup[]; lastSync: string };
}

export class WsIpcServer {
  private wss: WebSocketServer | null = null;
  private tokens = new Map<string, TokenContext>();
  private pingIntervals = new Map<WebSocket, ReturnType<typeof setInterval>>();
  private deps: WsIpcServerDeps;
  private _port = 0;

  get port(): number {
    return this._port;
  }

  constructor(deps: WsIpcServerDeps) {
    this.deps = deps;
  }

  async start(): Promise<{ port: number; host: string }> {
    const host = WS_BIND_ADDRESS;
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host, port: 0 });

      this.wss.on('listening', () => {
        const addr = this.wss!.address();
        if (typeof addr === 'object' && addr) {
          this._port = addr.port;
          logger.info(
            { port: this._port, host },
            'WebSocket IPC server listening',
          );
          resolve({ port: this.port, host });
        }
      });

      this.wss.on('error', (err) => {
        logger.error({ err }, 'WebSocket server error');
        reject(err);
      });

      this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        this.handleConnection(ws, req);
      });
    });
  }

  createToken(opts: CreateTokenOpts): string {
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(token, {
      groupFolder: opts.groupFolder,
      chatJid: opts.chatJid,
      isMain: opts.isMain,
      connections: [],
      onOutput: opts.onOutput,
      resetTimeout: opts.resetTimeout,
      onOrphaned: opts.onOrphaned,
      outputChain: Promise.resolve(),
    });
    return token;
  }

  async revokeToken(token: string): Promise<void> {
    const ctx = this.tokens.get(token);
    if (!ctx) return;

    // Await pending output callbacks before cleanup
    await ctx.outputChain.catch(() => {});

    if (ctx.graceTimer) clearTimeout(ctx.graceTimer);
    for (const conn of ctx.connections) {
      this.clearPing(conn.ws);
      conn.rpc.rejectAllPendingRequests('token revoked');
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1000, 'token revoked');
      }
    }
    this.tokens.delete(token);
  }

  sendInput(token: string, text: string): boolean {
    const ctx = this.tokens.get(token);
    if (!ctx) return false;

    const agentConns = ctx.connections.filter(
      (c) => c.role === 'agent' && c.ws.readyState === WebSocket.OPEN,
    );
    if (agentConns.length === 0) return false;

    for (const conn of agentConns) {
      conn.rpc.notify('input', { text });
    }
    return true;
  }

  sendClose(token: string): void {
    const ctx = this.tokens.get(token);
    if (!ctx) return;

    for (const conn of ctx.connections) {
      if (conn.role === 'agent' && conn.ws.readyState === WebSocket.OPEN) {
        conn.rpc.notify('close', {});
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.wss) return;
    // Clear all ping intervals
    for (const interval of this.pingIntervals.values()) {
      clearInterval(interval);
    }
    this.pingIntervals.clear();
    // Clear all grace timers
    for (const ctx of this.tokens.values()) {
      if (ctx.graceTimer) clearTimeout(ctx.graceTimer);
    }
    this.tokens.clear();
    // Close the listening socket (no new connections)
    // Existing connections drain naturally
    return new Promise((resolve) => {
      this.wss!.close(() => {
        logger.info('WebSocket IPC server shut down');
        resolve();
      });
    });
  }

  /** Create a JSONRPCServerAndClient for a connection, registering all methods */
  private createRpc(ws: WebSocket, ctx: TokenContext): JSONRPCServerAndClient {
    const rpc = new JSONRPCServerAndClient(
      new JSONRPCServer(),
      new JSONRPCClient((request) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(request));
          return Promise.resolve();
        }
        return Promise.reject(new Error('WebSocket not connected'));
      }),
    );

    // Output handler (transport-level — manages the output chain on the token context)
    rpc.addMethod('output', (params: Record<string, unknown>) => {
      this.handleOutput(params, ctx);
    });

    // All domain handlers from registry (core + skill handlers)
    const handlerCtx: HandlerContext = {
      groupFolder: ctx.groupFolder,
      chatJid: ctx.chatJid,
      isMain: ctx.isMain,
    };
    for (const [method, handler] of getRegisteredHandlers()) {
      rpc.addMethod(method, (params: Record<string, unknown>) =>
        handler(params, handlerCtx),
      );
    }

    return rpc;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Authenticate via Authorization header and role query parameter
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );
    const role = url.searchParams.get('role');

    if (!token || (role !== 'agent' && role !== 'mcp')) {
      ws.close(1008, 'invalid auth');
      return;
    }

    const ctx = this.tokens.get(token);
    if (!ctx) {
      ws.close(1008, 'invalid token');
      return;
    }

    // Clear grace timer if an agent is reconnecting
    if (role === 'agent' && ctx.graceTimer) {
      clearTimeout(ctx.graceTimer);
      ctx.graceTimer = undefined;
    }

    // Create per-connection RPC instance
    const rpc = this.createRpc(ws, ctx);
    ctx.connections.push({ ws, role, rpc });

    // Send initial state via JSON-RPC notification
    const tasks = this.deps.getTasksSnapshot(ctx.groupFolder, ctx.isMain);
    const groupsData = this.deps.getGroupsSnapshot(
      ctx.groupFolder,
      ctx.isMain,
    );
    rpc.notify('auth_ok', { tasks, groups: groupsData });

    // Start ping/pong heartbeat
    this.startPing(ws);

    logger.debug(
      {
        groupFolder: ctx.groupFolder,
        role,
        connCount: ctx.connections.length,
      },
      'WS client connected',
    );

    // Route all incoming messages via JSON-RPC (serialized via promise chain)
    let messageChain = Promise.resolve();

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        logger.warn('Malformed WS message, ignoring');
        return;
      }

      if (!this.tokens.has(token)) {
        ws.close(WS_CLOSE_TOKEN_REVOKED, 'token revoked');
        return;
      }

      messageChain = messageChain
        .then(() => rpc.receiveAndSend(msg))
        .catch((err) => {
          logger.error({ err, msg }, 'Error processing WS message');
        });
    });

    ws.on('close', () => {
      this.clearPing(ws);

      const currentCtx = this.tokens.get(token);
      if (!currentCtx) return;

      // Reject pending requests for this connection's RPC
      const conn = currentCtx.connections.find((c) => c.ws === ws);
      if (conn) {
        conn.rpc.rejectAllPendingRequests('Connection closed');
      }

      currentCtx.connections = currentCtx.connections.filter(
        (c) => c.ws !== ws,
      );

      if (role === 'mcp') {
        logger.debug(
          { groupFolder: currentCtx.groupFolder },
          'MCP connection disconnected',
        );
      }

      // Start grace period only when no agent connections remain.
      // If no agent reconnects in time, notify the container-runner
      // so it can stop the container directly.
      const hasAgent = currentCtx.connections.some((c) => c.role === 'agent');
      if (!hasAgent && !currentCtx.graceTimer) {
        currentCtx.graceTimer = setTimeout(() => {
          logger.warn(
            { groupFolder: currentCtx.groupFolder },
            'All agent connections lost after grace period',
          );
          currentCtx.onOrphaned?.();
        }, 30_000);
      }
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'WS connection error');
    });
  }

  private startPing(ws: WebSocket): void {
    let isAlive = true;

    ws.on('pong', () => {
      isAlive = true;
    });

    const interval = setInterval(() => {
      if (!isAlive) {
        logger.warn('WS pong timeout, terminating connection');
        clearInterval(interval);
        this.pingIntervals.delete(ws);
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, PING_INTERVAL_MS);

    this.pingIntervals.set(ws, interval);
  }

  private clearPing(ws: WebSocket): void {
    const interval = this.pingIntervals.get(ws);
    if (interval) {
      clearInterval(interval);
      this.pingIntervals.delete(ws);
    }
  }

  private handleOutput(
    params: Record<string, unknown>,
    ctx: TokenContext,
  ): void {
    if (params.status !== 'success' && params.status !== 'error') return;

    const output: ContainerOutput = {
      status: params.status,
      result: (params.result as string) ?? null,
      newSessionId: params.newSessionId as string | undefined,
      error: params.error as string | undefined,
    };

    // Reset container timeout on output activity
    ctx.resetTimeout?.();

    // Chain output callbacks for ordered processing
    if (ctx.onOutput) {
      ctx.outputChain = ctx.outputChain
        .then(() => ctx.onOutput!(output))
        .catch((err) => {
          logger.error(
            { err, groupFolder: ctx.groupFolder },
            'Output callback error',
          );
        });
    }
  }
}
