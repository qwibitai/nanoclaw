// --- Channels & Sessions ---

export type ChannelType = 'web-chat' | 'discord' | 'whatsapp' | 'resend';

export interface ChannelInfo {
  id: string;
  type: ChannelType;
  connected: boolean;
  metadata?: Record<string, string>;
}

export interface Session {
  id: string;
  channelType: ChannelType;
  channelId: string;
  agentSessionId?: string;
  lastActivity: string;
  messageCount: number;
}

// --- Work Queue ---

export interface Attachment {
  url: string;
  filename: string;
  contentType: string;
}

export interface WorkItem {
  id: string;
  sessionId: string;
  channel: ChannelType;
  channelId: string;
  prompt: string;
  attachments?: Attachment[];
  agentSessionId?: string;
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

// --- Activity ---

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

// --- Operator ---

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
