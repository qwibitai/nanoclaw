export interface AuthMe {
  user_id: string;
  scopes: { role: string; allowed_group_ids: string[]; no_filter: boolean };
}

export interface TaskSummary {
  task_id: string;
  parent_session_id: string;
  task_content: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  admitted_at: string;
  last_progress_message?: string;
  fail_reason?: string;
}

// Matches backend src/dashboard/api/tasks.ts TranscriptEntry exactly.
// Post-build QA fix MF-4: previous shape was {seq, role, text, ts} which had
// no overlap with backend {id, seq, kind, timestamp, content, direction, source}
// — TaskDetail rendered empty rows for every transcript entry.
export interface TranscriptEntry {
  id: string;
  seq: number;
  kind: string;
  timestamp: string;          // ISO 8601 — host writes T+ms+Z; container writes 'YYYY-MM-DD HH:MM:SS'
  content: unknown;           // JSON-parsed; usually has a `text` field for human-readable rendering
  direction: 'inbound' | 'outbound';
  source: 'dashboard' | 'chat' | 'agent' | 'system';
}

export interface TaskDetail extends TaskSummary {
  started_at?: string;
  completed_at?: string;
  // Backend SELECT * on detail returns child_session_id; SPA uses it to filter
  // chokidar-emitted SSE inbound_message events (post-build QA fix SF-8).
  child_session_id?: string | null;
}

export interface SessionSummary {
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  last_active: string | null;
  container_status: 'idle' | 'running' | 'stale' | 'unknown';
}

export interface TaskListResponse {
  tasks: TaskSummary[];
}

export interface TaskDetailResponse {
  task: TaskDetail;
  transcript: TranscriptEntry[];   // top-level, NOT nested in task
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

export interface SteerResponse {
  task_id: string;
  message_id: string;
  echo_status: string;
}

export interface ApiError {
  status: number;
  error: string;
  retry_after?: number;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; retry_after?: number };
    const apiErr: ApiError = {
      status: res.status,
      error: body.error ?? 'unknown',
      ...(body.retry_after != null ? { retry_after: body.retry_after } : {}),
    };
    throw apiErr;
  }
  return res.json() as Promise<T>;
}

export async function authMe(): Promise<AuthMe> {
  return apiFetch<AuthMe>('/dashboard/api/auth/me');
}

// Post-build QA fix SF-3: exchange returns {user_id, expires_at} only — no scopes.
// AuthGate refetches authMe() after the cookie lands, so this return value is
// consumed only for type-completeness; tighter type prevents future code from
// mistakenly reading .scopes off the exchange result.
export interface ExchangeResponse {
  user_id: string;
  expires_at: string;
}

export async function exchangeToken(token: string): Promise<ExchangeResponse> {
  return apiFetch<ExchangeResponse>('/dashboard/api/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export async function listTasks(
  filter?: { status?: string; limit?: number; before?: string }
): Promise<TaskListResponse> {
  const params = new URLSearchParams();
  if (filter?.status) params.set('status', filter.status);
  if (filter?.limit != null) params.set('limit', String(filter.limit));
  if (filter?.before) params.set('before', filter.before);
  const qs = params.toString();
  return apiFetch<TaskListResponse>(`/dashboard/api/tasks${qs ? `?${qs}` : ''}`);
}

export async function getTask(id: string): Promise<TaskDetailResponse> {
  return apiFetch<TaskDetailResponse>(`/dashboard/api/tasks/${encodeURIComponent(id)}`);
}

export async function listSessions(): Promise<SessionsResponse> {
  return apiFetch<SessionsResponse>('/dashboard/api/sessions');
}

export async function postSteer(
  taskId: string,
  body: { idempotency_key: string; text: string }
): Promise<SteerResponse> {
  return apiFetch<SteerResponse>(
    `/dashboard/api/tasks/${encodeURIComponent(taskId)}/message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}
