/**
 * WebSocket IPC Server for NanoClaw
 * Replaces file-based IPC with a single WS server for all containers.
 * Connections are authenticated with per-container cryptographic tokens.
 * Post-auth messages use JSON-RPC 2.0 via json-rpc-2.0 library.
 */
import crypto from 'crypto';
import { IncomingMessage } from 'http';

import { CronExpressionParser } from 'cron-parser';
import {
  JSONRPCClient,
  JSONRPCErrorException,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0';
import WebSocket, { WebSocketServer } from 'ws';

import { TIMEZONE, WS_BIND_ADDRESS } from './config.js';
import { AvailableGroup, ContainerOutput } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { getRegisteredHandlers } from './ipc-handlers/registry.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const AUTH_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 30_000;

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0;
}

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
  /** Per-token promise chain to order output callbacks */
  outputChain: Promise<void>;
  /** Grace timer for reconnection after all connections drop */
  graceTimer?: ReturnType<typeof setTimeout>;
}

export interface WsIpcServerDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
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

      this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
        this.handleConnection(ws);
      });
    });
  }

  createToken(groupFolder: string, chatJid: string, isMain: boolean): string {
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(token, {
      groupFolder,
      chatJid,
      isMain,
      connections: [],
      outputChain: Promise.resolve(),
    });
    return token;
  }

  revokeToken(token: string): void {
    const ctx = this.tokens.get(token);
    if (!ctx) return;

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

  /**
   * Get the output promise chain for a token.
   * Used by container-runner to await pending output before resolving.
   */
  getOutputChain(token: string): Promise<void> {
    return this.tokens.get(token)?.outputChain ?? Promise.resolve();
  }

  /**
   * Set the onOutput callback and resetTimeout function for a token.
   * Called by container-runner after creating the token.
   */
  setTokenCallbacks(
    token: string,
    onOutput: (output: ContainerOutput) => Promise<void>,
    resetTimeout: () => void,
  ): void {
    const ctx = this.tokens.get(token);
    if (ctx) {
      ctx.onOutput = onOutput;
      ctx.resetTimeout = resetTimeout;
    }
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

    // --- Notifications (no return value) ---

    rpc.addMethod('output', (params: Record<string, unknown>) => {
      this.handleOutput(params, ctx);
    });

    rpc.addMethod('message', async (params: Record<string, unknown>) => {
      await this.handleMessage(params, ctx);
    });

    // --- Requests (return result) ---

    rpc.addMethod('list_tasks', () => {
      return { tasks: this.deps.getTasksSnapshot(ctx.groupFolder, ctx.isMain) };
    });

    rpc.addMethod('schedule_task', (params: Record<string, unknown>) => {
      return this.handleScheduleTask(params, ctx);
    });

    rpc.addMethod('pause_task', (params: Record<string, unknown>) => {
      return this.handlePauseTask(params, ctx);
    });

    rpc.addMethod('resume_task', (params: Record<string, unknown>) => {
      return this.handleResumeTask(params, ctx);
    });

    rpc.addMethod('cancel_task', (params: Record<string, unknown>) => {
      return this.handleCancelTask(params, ctx);
    });

    rpc.addMethod('refresh_groups', async () => {
      return this.handleRefreshGroups(ctx);
    });

    rpc.addMethod('register_group', (params: Record<string, unknown>) => {
      return this.handleRegisterGroup(params, ctx);
    });

    // --- Skill handlers from registry ---
    for (const [type, handler] of getRegisteredHandlers()) {
      rpc.addMethod(type, (params: Record<string, unknown>) =>
        handler(params, ctx.groupFolder, ctx.isMain),
      );
    }

    return rpc;
  }

  private handleConnection(ws: WebSocket): void {
    let authenticated = false;
    let tokenStr: string | null = null;
    let connRole: 'agent' | 'mcp' | null = null;
    let rpc: JSONRPCServerAndClient | null = null;
    let messageChain = Promise.resolve();

    // Close unauthenticated connections after timeout
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        logger.warn('WS connection auth timeout, closing');
        ws.close(4001, 'auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        logger.warn('Malformed WS message, ignoring');
        return;
      }

      if (!authenticated) {
        if (msg.type !== 'auth') {
          ws.close(4002, 'must authenticate first');
          clearTimeout(authTimer);
          return;
        }

        const token = msg.token as string;
        const role = msg.role as string | undefined;
        if (role !== 'agent' && role !== 'mcp') {
          ws.send(
            JSON.stringify({ type: 'auth_error', message: 'invalid role' }),
          );
          ws.close(4003, 'invalid role');
          clearTimeout(authTimer);
          return;
        }

        const ctx = this.tokens.get(token);
        if (!ctx) {
          ws.send(
            JSON.stringify({ type: 'auth_error', message: 'invalid token' }),
          );
          ws.close(4003, 'invalid token');
          clearTimeout(authTimer);
          return;
        }

        authenticated = true;
        tokenStr = token;
        connRole = role;
        clearTimeout(authTimer);

        // Clear grace timer if an agent is reconnecting
        if (role === 'agent' && ctx.graceTimer) {
          clearTimeout(ctx.graceTimer);
          ctx.graceTimer = undefined;
        }

        // Create per-connection RPC instance
        rpc = this.createRpc(ws, ctx);
        ctx.connections.push({ ws, role, rpc });

        // Send auth_ok with current snapshots
        const tasks = this.deps.getTasksSnapshot(ctx.groupFolder, ctx.isMain);
        const groupsData = this.deps.getGroupsSnapshot(
          ctx.groupFolder,
          ctx.isMain,
        );
        ws.send(
          JSON.stringify({
            type: 'auth_ok',
            tasks,
            groups: groupsData,
          }),
        );

        // Start ping/pong heartbeat
        this.startPing(ws);

        logger.debug(
          {
            groupFolder: ctx.groupFolder,
            role,
            connCount: ctx.connections.length,
          },
          'WS client authenticated',
        );
        return;
      }

      // Authenticated — route via JSON-RPC (serialized via promise chain)
      const ctx = this.tokens.get(tokenStr!);
      if (!ctx) {
        ws.close(4004, 'token revoked');
        return;
      }

      messageChain = messageChain
        .then(() => rpc!.receiveAndSend(msg))
        .catch((err) => {
          logger.error({ err, msg }, 'Error processing WS message');
        });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clearPing(ws);
      if (!tokenStr) return;

      const ctx = this.tokens.get(tokenStr);
      if (!ctx) return;

      const disconnectedRole = connRole;

      // Reject pending requests for this connection's RPC
      const conn = ctx.connections.find((c) => c.ws === ws);
      if (conn) {
        conn.rpc.rejectAllPendingRequests('Connection closed');
      }

      ctx.connections = ctx.connections.filter((c) => c.ws !== ws);

      if (disconnectedRole === 'mcp') {
        logger.debug(
          { groupFolder: ctx.groupFolder },
          'MCP connection disconnected',
        );
      }

      // Start grace period only when no agent connections remain
      const hasAgent = ctx.connections.some((c) => c.role === 'agent');
      if (!hasAgent && !ctx.graceTimer) {
        ctx.graceTimer = setTimeout(() => {
          logger.warn(
            { groupFolder: ctx.groupFolder },
            'All WS connections lost after grace period',
          );
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

  private async handleMessage(
    params: Record<string, unknown>,
    ctx: TokenContext,
  ): Promise<void> {
    if (!isNonEmptyString(params.chatJid) || !isNonEmptyString(params.text)) return;

    const chatJid = params.chatJid;
    const text = params.text;
    const sender = params.sender as string | undefined;

    // Authorization: main can send to any JID, others only to their own
    const registeredGroups = this.deps.registeredGroups();
    const targetGroup = registeredGroups[chatJid];
    if (ctx.isMain || (targetGroup && targetGroup.folder === ctx.groupFolder)) {
      await this.deps.sendMessage(chatJid, text, sender);
      logger.info({ chatJid, sourceGroup: ctx.groupFolder }, 'WS message sent');
    } else {
      logger.warn(
        { chatJid, sourceGroup: ctx.groupFolder },
        'Unauthorized WS message attempt blocked',
      );
    }
  }

  private handleScheduleTask(
    params: Record<string, unknown>,
    ctx: TokenContext,
  ): { taskId: string } {
    const registeredGroups = this.deps.registeredGroups();

    if (
      !isNonEmptyString(params.prompt) ||
      !isNonEmptyString(params.schedule_type) ||
      !isNonEmptyString(params.schedule_value) ||
      !isNonEmptyString(params.targetJid)
    ) {
      throw new JSONRPCErrorException('Missing required fields', -32602);
    }

    const prompt = params.prompt;
    const scheduleType = params.schedule_type;
    const scheduleValue = params.schedule_value;
    const targetJid = params.targetJid;

    const targetGroupEntry = registeredGroups[targetJid];
    if (!targetGroupEntry) {
      logger.warn(
        { targetJid },
        'Cannot schedule task: target group not registered',
      );
      throw new JSONRPCErrorException('Target group not registered', -32602);
    }

    const targetFolder = targetGroupEntry.folder;

    // Authorization: non-main groups can only schedule for themselves
    if (!ctx.isMain && targetFolder !== ctx.groupFolder) {
      logger.warn(
        { sourceGroup: ctx.groupFolder, targetFolder },
        'Unauthorized schedule_task attempt blocked',
      );
      throw new JSONRPCErrorException('Unauthorized: cannot schedule for other groups', -32600);
    }

    if (
      scheduleType !== 'cron' &&
      scheduleType !== 'interval' &&
      scheduleType !== 'once'
    ) {
      logger.warn({ scheduleType }, 'Invalid schedule type');
      throw new JSONRPCErrorException(`Invalid schedule type: ${scheduleType}`, -32602);
    }

    let nextRun: string | null = null;
    if (scheduleType === 'cron') {
      try {
        const interval = CronExpressionParser.parse(scheduleValue, {
          tz: TIMEZONE,
        });
        nextRun = interval.next().toISOString();
      } catch {
        logger.warn({ scheduleValue }, 'Invalid cron expression');
        throw new JSONRPCErrorException(`Invalid cron expression: ${scheduleValue}`, -32602);
      }
    } else if (scheduleType === 'interval') {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms) || ms <= 0) {
        logger.warn({ scheduleValue }, 'Invalid interval');
        throw new JSONRPCErrorException(`Invalid interval: ${scheduleValue}`, -32602);
      }
      nextRun = new Date(Date.now() + ms).toISOString();
    } else if (scheduleType === 'once') {
      const scheduled = new Date(scheduleValue);
      if (isNaN(scheduled.getTime())) {
        logger.warn({ scheduleValue }, 'Invalid timestamp');
        throw new JSONRPCErrorException(`Invalid timestamp: ${scheduleValue}`, -32602);
      }
      nextRun = scheduled.toISOString();
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const contextMode =
      params.context_mode === 'group' || params.context_mode === 'isolated'
        ? (params.context_mode as 'group' | 'isolated')
        : 'isolated';
    createTask({
      id: taskId,
      group_folder: targetFolder,
      chat_jid: targetJid,
      prompt,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: contextMode,
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info(
      { taskId, sourceGroup: ctx.groupFolder, targetFolder, contextMode },
      'Task created via IPC',
    );
    return { taskId };
  }

  private handlePauseTask(
    params: Record<string, unknown>,
    ctx: TokenContext,
  ): Record<string, unknown> {
    if (!isNonEmptyString(params.taskId)) {
      throw new JSONRPCErrorException('Missing taskId', -32602);
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (task && (ctx.isMain || task.group_folder === ctx.groupFolder)) {
      updateTask(taskId, { status: 'paused' });
      logger.info(
        { taskId, sourceGroup: ctx.groupFolder },
        'Task paused via IPC',
      );
      return { ok: true };
    }
    logger.warn(
      { taskId, sourceGroup: ctx.groupFolder },
      'Unauthorized task pause attempt',
    );
    throw new JSONRPCErrorException('Task not found or unauthorized', -32600);
  }

  private handleResumeTask(
    params: Record<string, unknown>,
    ctx: TokenContext,
  ): Record<string, unknown> {
    if (!isNonEmptyString(params.taskId)) {
      throw new JSONRPCErrorException('Missing taskId', -32602);
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (task && (ctx.isMain || task.group_folder === ctx.groupFolder)) {
      updateTask(taskId, { status: 'active' });
      logger.info(
        { taskId, sourceGroup: ctx.groupFolder },
        'Task resumed via IPC',
      );
      return { ok: true };
    }
    logger.warn(
      { taskId, sourceGroup: ctx.groupFolder },
      'Unauthorized task resume attempt',
    );
    throw new JSONRPCErrorException('Task not found or unauthorized', -32600);
  }

  private handleCancelTask(
    params: Record<string, unknown>,
    ctx: TokenContext,
  ): Record<string, unknown> {
    if (!isNonEmptyString(params.taskId)) {
      throw new JSONRPCErrorException('Missing taskId', -32602);
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (task && (ctx.isMain || task.group_folder === ctx.groupFolder)) {
      deleteTask(taskId);
      logger.info(
        { taskId, sourceGroup: ctx.groupFolder },
        'Task cancelled via IPC',
      );
      return { ok: true };
    }
    logger.warn(
      { taskId, sourceGroup: ctx.groupFolder },
      'Unauthorized task cancel attempt',
    );
    throw new JSONRPCErrorException('Task not found or unauthorized', -32600);
  }

  private async handleRefreshGroups(
    ctx: TokenContext,
  ): Promise<Record<string, unknown>> {
    if (!ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.groupFolder },
        'Unauthorized refresh_groups attempt blocked',
      );
      throw new JSONRPCErrorException('Unauthorized: main group only', -32600);
    }
    logger.info(
      { sourceGroup: ctx.groupFolder },
      'Group metadata refresh requested via IPC',
    );
    await this.deps.syncGroups(true);
    const groupsData = this.deps.getGroupsSnapshot(
      ctx.groupFolder,
      ctx.isMain,
    );
    return { groups: groupsData };
  }

  private handleRegisterGroup(
    params: Record<string, unknown>,
    ctx: TokenContext,
  ): Record<string, unknown> {
    if (!ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.groupFolder },
        'Unauthorized register_group attempt blocked',
      );
      throw new JSONRPCErrorException('Unauthorized: main group only', -32600);
    }
    if (
      !isNonEmptyString(params.jid) ||
      !isNonEmptyString(params.name) ||
      !isNonEmptyString(params.folder) ||
      !isNonEmptyString(params.trigger)
    ) {
      logger.warn(
        'Invalid register_group request - missing required fields',
      );
      throw new JSONRPCErrorException('Missing required fields', -32602);
    }
    const jid = params.jid;
    const name = params.name;
    const folder = params.folder;
    const trigger = params.trigger;
    if (!isValidGroupFolder(folder)) {
      logger.warn(
        { sourceGroup: ctx.groupFolder, folder },
        'Invalid register_group request - unsafe folder name',
      );
      throw new JSONRPCErrorException('Invalid folder name', -32602);
    }
    // Defense in depth: agent cannot set isMain via IPC
    this.deps.registerGroup(jid, {
      name,
      folder,
      trigger,
      added_at: new Date().toISOString(),
      containerConfig:
        params.containerConfig as RegisteredGroup['containerConfig'],
      requiresTrigger: params.requiresTrigger as boolean | undefined,
    });
    return { ok: true };
  }
}
