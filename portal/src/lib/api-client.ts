/**
 * API client for the Portal backend.
 */

const API_BASE = '/api';

let authToken: string | null = null;

export function setToken(token: string | null): void {
  authToken = token;
  if (token) {
    localStorage.setItem('portal_token', token);
  } else {
    localStorage.removeItem('portal_token');
  }
}

export function getToken(): string | null {
  if (authToken) return authToken;
  if (typeof window !== 'undefined') {
    authToken = localStorage.getItem('portal_token');
  }
  return authToken;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    setToken(null);
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data as T;
}

// Auth
export const auth = {
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<User>('/auth/me'),
  register: (data: { email: string; name: string; password: string; role?: string }) =>
    request<User>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Agents
export const agents = {
  list: () => request<Agent[]>('/agents'),
  get: (id: string) => request<Agent>(`/agents/${id}`),
  create: (data: Partial<Agent>) =>
    request<Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Agent>) =>
    request<Agent>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/agents/${id}`, { method: 'DELETE' }),
  start: (id: string) =>
    request<Agent>(`/agents/${id}/start`, { method: 'POST' }),
  pause: (id: string) =>
    request<Agent>(`/agents/${id}/pause`, { method: 'POST' }),
  activity: (id: string) => request<Activity[]>(`/agents/${id}/activity`),
};

// Teams
export const teams = {
  list: () => request<TeamWithMembers[]>('/teams'),
  get: (id: string) => request<TeamWithMembers>(`/teams/${id}`),
  create: (data: Partial<Team>) =>
    request<Team>('/teams', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Team>) =>
    request<Team>(`/teams/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/teams/${id}`, { method: 'DELETE' }),
  addMember: (teamId: string, data: Partial<TeamMember>) =>
    request<TeamMember[]>(`/teams/${teamId}/members`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  removeMember: (teamId: string, agentId: string) =>
    request<{ ok: boolean }>(`/teams/${teamId}/members/${agentId}`, {
      method: 'DELETE',
    }),
  addRule: (teamId: string, data: Partial<EscalationRule>) =>
    request<EscalationRule>(`/teams/${teamId}/rules`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteRule: (teamId: string, ruleId: string) =>
    request<{ ok: boolean }>(`/teams/${teamId}/rules/${ruleId}`, {
      method: 'DELETE',
    }),
};

// Knowledge Bases
export const kb = {
  list: () => request<KBWithDocs[]>('/kb'),
  get: (id: string) => request<KBWithDocs>(`/kb/${id}`),
  create: (data: Partial<KnowledgeBase>) =>
    request<KnowledgeBase>('/kb', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<KnowledgeBase>) =>
    request<KnowledgeBase>(`/kb/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/kb/${id}`, { method: 'DELETE' }),
  uploadDocument: (kbId: string, filename: string, content: string, mimeType?: string) =>
    request<KBDocument>(`/kb/${kbId}/documents`, {
      method: 'POST',
      body: JSON.stringify({ filename, content, mime_type: mimeType }),
    }),
  deleteDocument: (kbId: string, docId: string) =>
    request<{ ok: boolean }>(`/kb/${kbId}/documents/${docId}`, { method: 'DELETE' }),
};

// Dashboard
export const dashboard = {
  stats: () => request<DashboardStats>('/dashboard/stats'),
  activity: (limit?: number) =>
    request<Activity[]>(`/dashboard/activity?limit=${limit || 50}`),
};

// Tickets
export const tickets = {
  list: () => request<TicketSummary[]>('/tickets'),
  get: (id: string) => request<TicketDetail>(`/tickets/${id}`),
};

// Chat
export const chat = {
  send: (agentId: string, content: string) =>
    request<ChatMessage>(`/chat/${agentId}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  history: (agentId: string) =>
    request<ChatMessage[]>(`/chat/${agentId}/history`),
};

// Logs
export const logs = {
  list: (params?: { agent_id?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.agent_id) qs.set('agent_id', params.agent_id);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    return request<Activity[]>(`/logs?${qs}`);
  },
};

// Types
export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface Agent {
  id: string;
  name: string;
  display_name: string | null;
  role: string;
  client_id: number | null;
  client_name: string | null;
  group_folder: string;
  specializations: string;
  triage_config: string;
  custom_instructions: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  team_type: string;
  created_at: string;
}

export interface TeamMember {
  team_id: string;
  agent_id: string;
  role: string;
  escalation_order: number | null;
  trigger_categories: string | null;
  agent_name?: string;
  agent_status?: string;
}

export interface EscalationRule {
  id: string;
  team_id: string;
  condition_type: string;
  condition_value: string;
  target_agent_id: string;
  action: string;
  created_at: string;
}

export interface TeamWithMembers extends Team {
  members: TeamMember[];
  escalation_rules: EscalationRule[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
  scope: string;
  assigned_agent_id: string | null;
  description: string | null;
  created_at: string;
}

export interface KBDocument {
  id: string;
  kb_id: string;
  filename: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  uploaded_at: string;
}

export interface KBWithDocs extends KnowledgeBase {
  documents: KBDocument[];
}

export interface Activity {
  id: number;
  agent_id: string;
  agent_name?: string;
  ticket_id: number | null;
  ticket_display_id: string | null;
  action_type: string;
  detail: string | null;
  client_id: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface DashboardStats {
  total_agents: number;
  active_agents: number;
  total_teams: number;
  total_kb: number;
  recent_activities: number;
}

export interface TicketSummary {
  ticket_id: number;
  ticket_display_id: string;
  agent_id: string;
  client_id: number | null;
  actions: Activity[];
  last_action: string;
}

export interface TicketDetail {
  ticket_id: string;
  activities: Activity[];
}

export interface ChatMessage {
  id: string;
  agent_id: string;
  user_id: string | null;
  direction: string;
  content: string;
  created_at: string;
}
