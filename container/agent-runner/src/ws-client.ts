/**
 * WebSocket IPC Client for NanoClaw containers
 * Replaces file-based IPC polling with a persistent WS connection.
 * Used by both agent-runner index.ts and ipc-mcp-stdio.ts.
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';

export interface AuthOkPayload {
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>;
  groups: {
    groups: Array<{
      jid: string;
      name: string;
      lastActivity: string;
      isRegistered: boolean;
    }>;
    lastSync: string;
  };
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAYS = [1000, 2000, 4000];

function log(message: string): void {
  console.error(`[ws-client] ${message}`);
}

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private role: 'agent' | 'mcp';
  private reconnectAttempts = 0;
  private pendingRequests = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pingWatchdog: ReturnType<typeof setTimeout> | null = null;

  // Event callbacks set by the consumer
  onInput: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onGroupsUpdated:
    | ((groups: AuthOkPayload['groups']) => void)
    | null = null;

  constructor(url: string, token: string, role: 'agent' | 'mcp') {
    this.url = url;
    this.token = token;
    this.role = role;
  }

  async connect(): Promise<AuthOkPayload> {
    return this.doConnect();
  }

  private doConnect(): Promise<AuthOkPayload> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      let authResolved = false;

      this.ws.on('open', () => {
        log('Connected, authenticating...');
        this.ws!.send(JSON.stringify({ type: 'auth', token: this.token, role: this.role }));
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        let msg: { type: string; [key: string]: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          log('Malformed message from server, ignoring');
          return;
        }

        if (!authResolved) {
          if (msg.type === 'auth_ok') {
            authResolved = true;
            this.reconnectAttempts = 0;
            this.resetPingWatchdog();
            log('Authenticated');
            resolve(msg as unknown as AuthOkPayload);
          } else if (msg.type === 'auth_error') {
            authResolved = true;
            reject(new Error(`Auth failed: ${msg.message}`));
          }
          return;
        }

        this.handleMessage(msg);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        log(`Connection closed: ${code} ${reason.toString()}`);
        if (!authResolved) {
          authResolved = true;
          reject(new Error(`Connection closed during auth: ${code}`));
          return;
        }
        this.handleDisconnect();
      });

      this.ws.on('error', (err: Error) => {
        log(`Connection error: ${err.message}`);
        if (!authResolved) {
          authResolved = true;
          reject(err);
        }
      });

      this.ws.on('ping', () => {
        this.resetPingWatchdog();
      });
    });
  }

  /** If no ping arrives within 45s (1.5x server interval), assume dead connection */
  private resetPingWatchdog(): void {
    if (this.pingWatchdog) clearTimeout(this.pingWatchdog);
    this.pingWatchdog = setTimeout(() => {
      log('Ping watchdog timeout, terminating connection');
      this.ws?.terminate();
    }, 45_000);
  }

  private clearPingWatchdog(): void {
    if (this.pingWatchdog) {
      clearTimeout(this.pingWatchdog);
      this.pingWatchdog = null;
    }
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'input':
        this.onInput?.(msg.text as string);
        break;

      case 'close':
        this.onClose?.();
        break;

      case 'ipc_response': {
        const requestId = msg.requestId as string;
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(requestId);
          pending.resolve(msg);
        }
        break;
      }

      case 'groups_updated':
        this.onGroupsUpdated?.(
          msg.groups as AuthOkPayload['groups'],
        );
        break;

      default:
        log(`Unknown message type: ${msg.type}`);
    }
  }

  private async handleDisconnect(): Promise<void> {
    this.clearPingWatchdog();
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log('Max reconnect attempts reached, giving up');
      // Reject any pending requests
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Connection lost'));
      }
      this.pendingRequests.clear();
      // Signal close to consumer
      this.onClose?.();
      return;
    }

    const delay = RECONNECT_DELAYS[this.reconnectAttempts] ?? 4000;
    this.reconnectAttempts++;
    log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    await new Promise((r) => setTimeout(r, delay));

    try {
      await this.doConnect();
      log('Reconnected successfully');
    } catch (err) {
      log(
        `Reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.handleDisconnect();
    }
  }

  sendOutput(
    status: 'success' | 'error',
    result: string | null,
    newSessionId?: string,
    error?: string,
  ): void {
    this.send({
      type: 'output',
      status,
      result,
      newSessionId,
      error,
    });
  }

  sendMessage(chatJid: string, text: string, sender?: string): void {
    this.send({
      type: 'message',
      chatJid,
      text,
      sender,
      timestamp: new Date().toISOString(),
    });
  }

  sendTask(data: Record<string, unknown>): void {
    this.send(data);
  }

  /**
   * Send a request to the host and await a typed ipc_response.
   * Generates a requestId, registers a pending promise, and sets a timeout.
   */
  async sendTaskRequest(
    data: Record<string, unknown>,
    timeoutMs = 130_000,
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not connected'));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`${data.type} timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
      this.send({ ...data, requestId });
    });
  }

  async listTasks(): Promise<AuthOkPayload['tasks']> {
    const response = await this.sendTaskRequest({ type: 'list_tasks' }, 5000);
    return response.tasks as AuthOkPayload['tasks'];
  }

  refreshGroups(): void {
    this.send({ type: 'refresh_groups' });
  }

  close(): void {
    this.clearPingWatchdog();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'client closing');
    }
    this.ws = null;
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      log(`Message dropped (ws ${this.ws ? `state=${this.ws.readyState}` : 'null'}): type=${data.type}`);
    }
  }
}
