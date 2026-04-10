export interface ControlPlaneTaskUpdate {
  claim?: boolean;
  status?: string;
  message?: string;
}

export interface ControlPlaneMessagePayload {
  taskId?: string;
  body: string;
}

export interface ControlPlaneHeartbeatPayload {
  status: string;
  metadata?: Record<string, unknown>;
}

export interface ControlPlaneClientOptions {
  baseUrl: string;
  agentKey: string;
  fetchImpl?: typeof fetch;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly agentKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.agentKey = options.agentKey;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async bootstrap(): Promise<any> {
    return this.request('GET', '/api/agent/bootstrap');
  }

  async heartbeat(
    status: string,
    metadata?: Record<string, unknown>,
  ): Promise<any> {
    return this.request('POST', '/api/agent/heartbeat', {
      status,
      metadata,
    } satisfies ControlPlaneHeartbeatPayload);
  }

  async getTasks(includeBacklog: boolean = false): Promise<any[]> {
    const search = includeBacklog ? '?includeBacklog=true' : '';
    const result = await this.request('GET', `/api/agent/tasks${search}`);
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.tasks)) return result.tasks;
    return [];
  }

  async updateTask(
    taskId: string,
    payload: ControlPlaneTaskUpdate,
  ): Promise<any> {
    return this.request(
      'PATCH',
      `/api/agent/tasks/${encodeURIComponent(taskId)}`,
      payload,
    );
  }

  async getMessages(taskId?: string): Promise<any[]> {
    const search = taskId
      ? `?taskId=${encodeURIComponent(taskId)}`
      : '';
    const result = await this.request('GET', `/api/agent/messages${search}`);
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.messages)) return result.messages;
    return [];
  }

  async postMessage(payload: ControlPlaneMessagePayload): Promise<any> {
    return this.request('POST', '/api/agent/messages', payload);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'x-agent-key': this.agentKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    const parsed = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      const message =
        (parsed && typeof parsed.error === 'string' && parsed.error) ||
        text ||
        response.statusText;
      throw new Error(
        `Control plane ${method} ${path} failed: ${response.status} ${message}`,
      );
    }

    return parsed;
  }
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
