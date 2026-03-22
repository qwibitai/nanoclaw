/**
 * MCP Bridge for NanoClaw
 * Manages host-side MCP server processes and forwards tool calls from containers.
 * Used for MCP servers that can't run inside Linux containers (e.g. macOS-native APIs).
 *
 * Generic — no knowledge of specific MCP servers. Servers are configured via env vars.
 */

import { ChildProcess, spawn } from 'child_process';

import { logger } from './logger.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const REQUEST_TIMEOUT = 30_000;

class McpServerProcess {
  private process: ChildProcess | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = '';
  private cachedTools: McpToolSchema[] | null = null;

  constructor(private config: McpServerConfig) {}

  async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.start();
    return this.initializing;
  }

  private async start(): Promise<void> {
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug({ server: this.config.name }, `MCP stderr: ${text}`);
      }
    });

    this.process.on('exit', (code) => {
      logger.warn(
        { server: this.config.name, code },
        'MCP server process exited',
      );
      this.initialized = false;
      this.initializing = null;
      this.process = null;
      this.cachedTools = null;
      // Reject any pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('MCP server process exited'));
        this.pendingRequests.delete(id);
      }
    });

    // Initialize MCP protocol
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nanoclaw-bridge', version: '1.0.0' },
    });

    // Send initialized notification
    this.sendNotification('notifications/initialized', {});
    this.initialized = true;
    logger.info({ server: this.config.name }, 'MCP server initialized');
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id != null) {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(response.id);
            pending.resolve(response);
          }
        }
      } catch {
        logger.debug(
          { server: this.config.name, line },
          'Non-JSON line from MCP server',
        );
      }
    }
  }

  async listTools(): Promise<McpToolSchema[]> {
    if (this.cachedTools) return this.cachedTools;

    await this.ensureStarted();
    const response = await this.sendRequest('tools/list', {});
    if (response.error) {
      throw new Error(response.error.message);
    }
    const result = response.result as { tools?: McpToolSchema[] };
    this.cachedTools = result.tools || [];
    return this.cachedTools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.ensureStarted();
    const response = await this.sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });
    if (response.error) {
      throw new Error(response.error.message);
    }
    return response.result;
  }

  private sendRequest(
    method: string,
    params: unknown,
  ): Promise<JsonRpcResponse> {
    const id = ++this.requestId;
    const request = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const notification = { jsonrpc: '2.0', method, params };
    this.process!.stdin!.write(JSON.stringify(notification) + '\n');
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.initialized = false;
      this.initializing = null;
      this.cachedTools = null;
    }
  }
}

export class McpBridge {
  private servers = new Map<string, McpServerProcess>();

  addServer(config: McpServerConfig): void {
    this.servers.set(config.name, new McpServerProcess(config));
    logger.info({ server: config.name }, 'MCP bridge server registered');
  }

  /**
   * List all tools from all registered MCP servers.
   * Returns tools prefixed with server name for namespacing.
   */
  async listAllTools(): Promise<
    Array<{ server: string; tools: McpToolSchema[] }>
  > {
    const results: Array<{ server: string; tools: McpToolSchema[] }> = [];
    for (const [name, server] of this.servers) {
      try {
        const tools = await server.listTools();
        results.push({ server: name, tools });
      } catch (err) {
        logger.error(
          { server: name, err },
          'Failed to list tools from MCP server',
        );
        results.push({ server: name, tools: [] });
      }
    }
    return results;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Unknown MCP bridge server: ${serverName}`);
    }
    return server.callTool(toolName, args);
  }

  hasServers(): boolean {
    return this.servers.size > 0;
  }

  stop(): void {
    for (const server of this.servers.values()) {
      server.stop();
    }
  }
}
