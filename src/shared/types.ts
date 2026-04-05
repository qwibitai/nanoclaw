export interface WorkItem {
  id: string;
  groupId: string;
  channel: string;
  prompt: string;
  sessionId?: string;
  createdAt: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export interface WorkResult {
  id: string;
  status: 'success' | 'error';
  result: string | null;
  sessionId?: string;
  error?: string;
  completedAt: string;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  type:
    | 'message_in'
    | 'message_out'
    | 'agent_start'
    | 'agent_complete'
    | 'agent_error'
    | 'system';
  channel: string;
  groupId: string;
  summary: string;
}

export interface OperatorConfig {
  name: string;
  slug: string;
  products: string[];
  channels: string[];
}

export interface SkillInfo {
  name: string;
  path: string;
  status: 'active' | 'stub';
  source: 'base' | 'override';
}
