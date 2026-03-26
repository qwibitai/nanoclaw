// Shared API types for the NanoClaw Web UI.
// Types only — no runtime imports.

/** Authenticated user from JWT (cockpit login). */
export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'member';
  groups: string[];
}

/** Active session state shared between routes.ts and web-ui.ts. */
export interface ActiveSession {
  group: string;
  groupJid: string;
  threadId?: string;
  startedAt: string;
}

// Paginated response envelope used by all list endpoints
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// GET /api/capabilities response
export interface Capabilities {
  version: string;
  features: {
    memory: boolean;
    backlog: boolean;
    ship_log: boolean;
    thread_search: boolean;
    tone_profiles: boolean;
    gate_protocol: boolean;
    activity_summary: boolean;
    commit_digest: boolean;
    ollama: boolean;
  };
  channels: string[];
  groups: Array<{ jid: string; name: string; folder: string; channel: string }>;
  folders: Array<{
    folder: string;
    name: string;
    channels: Array<{ jid: string; channel: string; name: string }>;
  }>;
}

// WebSocket protocol types
export type WsClientMessage =
  | {
      type: 'send_message';
      groupJid?: string;
      groupFolder?: string; // web channel: target group by folder name
      text: string;
      senderName?: string;
      senderId?: string;
      threadId?: string;
    }
  | { type: 'subscribe'; groups?: string[]; since?: number };

export type WsServerMessage =
  | { type: 'connected'; capabilities: Capabilities }
  | {
      type: 'progress';
      sessionKey: string;
      group: string;
      event: unknown;
    }
  | {
      type: 'session_start';
      sessionKey: string;
      group: string;
      groupJid: string;
      threadId?: string;
    }
  | { type: 'session_end'; sessionKey: string }
  | { type: 'message_stored'; id: string }
  | {
      type: 'skill_install_progress';
      jobId: string;
      output: string;
      status: 'running' | 'completed' | 'failed';
    }
  | {
      type: 'web_message';
      groupFolder: string;
      threadId?: string;
      text: string;
      timestamp: string;
    }
  | { type: 'resync' }
  | { type: 'error'; code: string; message: string };
