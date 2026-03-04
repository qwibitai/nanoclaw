/**
 * WebSocket IPC Server for NanoClaw
 * Replaces file-based IPC with a single WS server for all containers.
 * Connections are authenticated with per-container cryptographic tokens.
 */
import crypto from 'crypto';
import { IncomingMessage } from 'http';

import { CronExpressionParser } from 'cron-parser';
import WebSocket, { WebSocketServer } from 'ws';

import { TIMEZONE, WS_BIND_ADDRESS } from './config.js';
import { AvailableGroup, ContainerOutput } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { resolveIpcHandler } from './ipc-handlers/registry.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const AUTH_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0;
}

interface TokenContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  connections: WebSocket[];
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
  private pingIntervals = new Map<
    WebSocket,
    ReturnType<typeof setInterval>
  >();
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
    for (const ws of ctx.connections) {
      this.clearPing(ws);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'token revoked');
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

    const connected = ctx.connections.filter(
      (ws) => ws.readyState === WebSocket.OPEN,
    );
    if (connected.length === 0) return false;

    const msg = JSON.stringify({ type: 'input', text });
    for (const ws of connected) {
      ws.send(msg);
    }
    return true;
  }

  sendClose(token: string): void {
    const ctx = this.tokens.get(token);
    if (!ctx) return;

    const msg = JSON.stringify({ type: 'close' });
    for (const ws of ctx.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
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
    // Close the listening socket (no new connections)
    // Existing connections drain naturally
    return new Promise((resolve) => {
      this.wss!.close(() => {
        logger.info('WebSocket IPC server shut down');
        resolve();
      });
    });
  }

  private handleConnection(ws: WebSocket): void {
    let authenticated = false;
    let tokenStr: string | null = null;

    // Close unauthenticated connections after timeout
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        logger.warn('WS connection auth timeout, closing');
        ws.close(4001, 'auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', async (raw: WebSocket.RawData) => {
      let msg: { type: string; [key: string]: unknown };
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
        clearTimeout(authTimer);

        // Clear grace timer if reconnecting
        if (ctx.graceTimer) {
          clearTimeout(ctx.graceTimer);
          ctx.graceTimer = undefined;
        }

        ctx.connections.push(ws);

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
          { groupFolder: ctx.groupFolder, connCount: ctx.connections.length },
          'WS client authenticated',
        );
        return;
      }

      // Authenticated — route message
      const ctx = this.tokens.get(tokenStr!);
      if (!ctx) {
        ws.close(4004, 'token revoked');
        return;
      }

      await this.routeMessage(msg, ctx);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clearPing(ws);
      if (!tokenStr) return;

      const ctx = this.tokens.get(tokenStr);
      if (!ctx) return;

      ctx.connections = ctx.connections.filter((c) => c !== ws);

      // Start grace period if all connections dropped
      if (ctx.connections.length === 0 && !ctx.graceTimer) {
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

  private async routeMessage(
    msg: { type: string; [key: string]: unknown },
    ctx: TokenContext,
  ): Promise<void> {
    try {
      switch (msg.type) {
        case 'output':
          this.handleOutput(msg, ctx);
          break;

        case 'message':
          await this.handleMessage(msg, ctx);
          break;

        case 'list_tasks': {
          const requestId = msg.requestId as string;
          const tasks = this.deps.getTasksSnapshot(ctx.groupFolder, ctx.isMain);
          const response = JSON.stringify({
            type: 'ipc_response',
            requestId,
            tasks,
          });
          for (const ws of ctx.connections) {
            if (ws.readyState === WebSocket.OPEN) ws.send(response);
          }
          break;
        }

        default:
          await this.handleTaskIpc(msg, ctx);
      }
    } catch (err) {
      logger.error({ err, type: msg.type }, 'Error routing WS message');
    }
  }

  private handleOutput(
    msg: { type: string; [key: string]: unknown },
    ctx: TokenContext,
  ): void {
    if (msg.status !== 'success' && msg.status !== 'error') return;

    const output: ContainerOutput = {
      status: msg.status,
      result: (msg.result as string) ?? null,
      newSessionId: msg.newSessionId as string | undefined,
      error: msg.error as string | undefined,
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
    msg: { type: string; [key: string]: unknown },
    ctx: TokenContext,
  ): Promise<void> {
    if (!isNonEmptyString(msg.chatJid) || !isNonEmptyString(msg.text)) return;

    const chatJid = msg.chatJid;
    const text = msg.text;
    const sender = msg.sender as string | undefined;

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

  private async handleTaskIpc(
    msg: { type: string; [key: string]: unknown },
    ctx: TokenContext,
  ): Promise<void> {
    const registeredGroups = this.deps.registeredGroups();

    switch (msg.type) {
      case 'schedule_task': {
        if (
          !isNonEmptyString(msg.prompt) ||
          !isNonEmptyString(msg.schedule_type) ||
          !isNonEmptyString(msg.schedule_value) ||
          !isNonEmptyString(msg.targetJid)
        )
          break;

        const prompt = msg.prompt;
        const scheduleType = msg.schedule_type;
        const scheduleValue = msg.schedule_value;
        const targetJid = msg.targetJid;

        const targetGroupEntry = registeredGroups[targetJid];
        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!ctx.isMain && targetFolder !== ctx.groupFolder) {
          logger.warn(
            { sourceGroup: ctx.groupFolder, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        let nextRun: string | null = null;
        const validType = scheduleType as 'cron' | 'interval' | 'once';
        if (validType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(scheduleValue, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue }, 'Invalid cron expression');
            break;
          }
        } else if (validType === 'interval') {
          const ms = parseInt(scheduleValue, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (validType === 'once') {
          const scheduled = new Date(scheduleValue);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          msg.context_mode === 'group' || msg.context_mode === 'isolated'
            ? (msg.context_mode as 'group' | 'isolated')
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt,
          schedule_type: validType,
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
        break;
      }

      case 'pause_task': {
        if (!isNonEmptyString(msg.taskId)) break;
        const taskId = msg.taskId;
        const task = getTaskById(taskId);
        if (task && (ctx.isMain || task.group_folder === ctx.groupFolder)) {
          updateTask(taskId, { status: 'paused' });
          logger.info(
            { taskId, sourceGroup: ctx.groupFolder },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId, sourceGroup: ctx.groupFolder },
            'Unauthorized task pause attempt',
          );
        }
        break;
      }

      case 'resume_task': {
        if (!isNonEmptyString(msg.taskId)) break;
        const taskId = msg.taskId;
        const task = getTaskById(taskId);
        if (task && (ctx.isMain || task.group_folder === ctx.groupFolder)) {
          updateTask(taskId, { status: 'active' });
          logger.info(
            { taskId, sourceGroup: ctx.groupFolder },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId, sourceGroup: ctx.groupFolder },
            'Unauthorized task resume attempt',
          );
        }
        break;
      }

      case 'cancel_task': {
        if (!isNonEmptyString(msg.taskId)) break;
        const taskId = msg.taskId;
        const task = getTaskById(taskId);
        if (task && (ctx.isMain || task.group_folder === ctx.groupFolder)) {
          deleteTask(taskId);
          logger.info(
            { taskId, sourceGroup: ctx.groupFolder },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId, sourceGroup: ctx.groupFolder },
            'Unauthorized task cancel attempt',
          );
        }
        break;
      }

      case 'refresh_groups': {
        if (ctx.isMain) {
          logger.info(
            { sourceGroup: ctx.groupFolder },
            'Group metadata refresh requested via IPC',
          );
          await this.deps.syncGroups(true);
          // Send updated groups to all connections for this token
          const groupsData = this.deps.getGroupsSnapshot(
            ctx.groupFolder,
            ctx.isMain,
          );
          const response = JSON.stringify({
            type: 'groups_updated',
            groups: groupsData,
          });
          for (const ws of ctx.connections) {
            if (ws.readyState === WebSocket.OPEN) ws.send(response);
          }
        } else {
          logger.warn(
            { sourceGroup: ctx.groupFolder },
            'Unauthorized refresh_groups attempt blocked',
          );
        }
        break;
      }

      case 'register_group': {
        if (!ctx.isMain) {
          logger.warn(
            { sourceGroup: ctx.groupFolder },
            'Unauthorized register_group attempt blocked',
          );
          break;
        }
        if (
          !isNonEmptyString(msg.jid) ||
          !isNonEmptyString(msg.name) ||
          !isNonEmptyString(msg.folder) ||
          !isNonEmptyString(msg.trigger)
        ) {
          logger.warn(
            { data: msg },
            'Invalid register_group request - missing required fields',
          );
          break;
        }
        const jid = msg.jid;
        const name = msg.name;
        const folder = msg.folder;
        const trigger = msg.trigger;
        if (!isValidGroupFolder(folder)) {
          logger.warn(
            { sourceGroup: ctx.groupFolder, folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        this.deps.registerGroup(jid, {
          name,
          folder,
          trigger,
          added_at: new Date().toISOString(),
          containerConfig:
            msg.containerConfig as RegisteredGroup['containerConfig'],
          requiresTrigger: msg.requiresTrigger as boolean | undefined,
        });
        break;
      }

      default: {
        const result = await resolveIpcHandler(
          msg,
          ctx.groupFolder,
          ctx.isMain,
        );
        if (result !== null) {
          const requestId = msg.requestId as string | undefined;
          if (requestId) {
            const response = JSON.stringify({
              type: 'ipc_response',
              requestId,
              ...result,
            });
            for (const ws of ctx.connections) {
              if (ws.readyState === WebSocket.OPEN) ws.send(response);
            }
          }
        } else {
          logger.warn({ type: msg.type }, 'Unknown IPC task type');
        }
        break;
      }
    }
  }
}
