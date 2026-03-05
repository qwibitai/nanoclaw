/**
 * WebSocket IPC Client for NanoClaw containers
 * Uses json-rpc-2.0 for protocol handling after auth handshake.
 * Used by both agent-runner index.ts and ipc-mcp-stdio.ts.
 */
import WebSocket from 'ws';
import {
  JSONRPCClient,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0';

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
  private closed = false;
  private reconnecting = false;
  private rpc: JSONRPCServerAndClient | null = null;
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
    this.closed = false;
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
        let msg: { type?: string; [key: string]: unknown };
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
            this.initRpc();
            log('Authenticated');
            resolve(msg as unknown as AuthOkPayload);
          } else if (msg.type === 'auth_error') {
            authResolved = true;
            reject(new Error(`Auth failed: ${msg.message}`));
          }
          return;
        }

        // Post-auth: delegate to JSON-RPC
        if (this.rpc) {
          this.rpc.receiveAndSend(msg);
        }
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

  /** Initialize the JSON-RPC server+client after successful auth */
  private initRpc(): void {
    const ws = this.ws!;

    this.rpc = new JSONRPCServerAndClient(
      new JSONRPCServer(),
      new JSONRPCClient((request) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(request));
          return Promise.resolve();
        }
        return Promise.reject(new Error('WebSocket not connected'));
      }),
    );

    // Register server-side methods for incoming calls from host
    this.rpc.addMethod('input', ({ text }: { text: string }) => {
      this.onInput?.(text);
    });

    this.rpc.addMethod('close', () => {
      this.onClose?.();
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

  private async handleDisconnect(): Promise<void> {
    this.clearPingWatchdog();
    if (this.rpc) {
      this.rpc.rejectAllPendingRequests('Connection closed');
      this.rpc = null;
    }
    if (this.closed || this.reconnecting) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log('Max reconnect attempts reached, giving up');
      this.close();
      this.onClose?.();
      return;
    }

    this.reconnecting = true;
    const delay = RECONNECT_DELAYS[this.reconnectAttempts] ?? 4000;
    this.reconnectAttempts++;
    log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    await new Promise((r) => setTimeout(r, delay));

    if (this.closed) {
      this.reconnecting = false;
      return;
    }

    try {
      const payload = await this.doConnect();
      this.reconnecting = false;
      log('Reconnected successfully');
      this.onGroupsUpdated?.(payload.groups);
    } catch (err) {
      this.reconnecting = false;
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
    this.rpc?.notify('output', { status, result, newSessionId, error });
  }

  async sendMessage(chatJid: string, text: string, sender?: string): Promise<void> {
    await this.request('message', { chatJid, text, sender }, 10_000);
  }

  /**
   * Send a JSON-RPC request to the host and await the result.
   * Throws on error (JSON-RPC error or timeout).
   */
  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 130_000,
  ): Promise<Record<string, unknown>> {
    if (!this.rpc) {
      throw new Error('WebSocket not connected');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.rpc.request(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timeout (${timeoutMs}ms)`)), timeoutMs);
        }),
      ]);
      return (result as Record<string, unknown>) ?? {};
    } finally {
      clearTimeout(timer);
    }
  }

  async listTasks(): Promise<AuthOkPayload['tasks']> {
    const response = await this.request('list_tasks', {}, 5000);
    return response.tasks as AuthOkPayload['tasks'];
  }

  async refreshGroups(): Promise<void> {
    await this.request('refresh_groups', {}, 10_000);
  }

  close(): void {
    this.closed = true;
    this.clearPingWatchdog();
    if (this.rpc) {
      this.rpc.rejectAllPendingRequests('Connection closed');
      this.rpc = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'client closing');
    }
    this.ws = null;
  }
}
