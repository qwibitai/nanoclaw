// ── Central DB entities ──

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
}

export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number; // 0 | 1
  unknown_sender_policy: UnknownSenderPolicy;
  /**
   * When set, the owner explicitly denied registering this channel — the
   * router drops silently and does not re-escalate. Cleared by any explicit
   * wiring mutation (admin command). See migration 012.
   *
   * Optional on the TS type so pre-migration-012 callers that build
   * MessagingGroup objects in code (fixtures, etc.) don't need to update;
   * the column itself defaults to NULL in SQLite.
   */
  denied_at?: string | null;
  /**
   * When 1, bare-URL messages on this channel are silently filed to the
   * knowledge-intake sprite instead of being dispatched to an agent. Toggled
   * via the /intake on|off slash command. See migration 014.
   *
   * Optional on the TS type so pre-migration-014 callers that build
   * MessagingGroup objects in code (fixtures, etc.) don't need to update;
   * the column itself defaults to 0 in SQLite.
   */
  auto_url_intake?: number; // 0 | 1
  /**
   * Per-channel listening mode (added by migration 015). Carried forward
   * from v1's YAML `listening_mode` field. The router itself doesn't gate
   * on this yet — engage rules are per-wiring on `messaging_group_agents`.
   * The jibrain-intake module reads it informationally so the hook script
   * can route silent vs attentive captures differently.
   *
   *   'attentive' — normal default; agent engage rules apply unchanged.
   *   'silent'    — channel is a passive listener; no agent should be wired.
   *   'intake'    — explicit knowledge-feed channel.
   *
   * Optional on the TS type so pre-migration-015 fixtures don't need updating.
   */
  listening_mode?: 'attentive' | 'silent' | 'intake';
  /**
   * When 1, the jibrain-intake module suppresses the shared-intake hook for
   * this channel (the conversation is sensitive; capture happens via the
   * per-workstream confidential path elsewhere). See migration 015.
   * Optional on the TS type for the same reason as the fields above.
   */
  confidential_intake?: number; // 0 | 1
  /**
   * Capture mode forwarded to the jibrain hook script (5th positional arg).
   *
   *   'standalone' — one intake markdown per quiet-window burst (default).
   *   'digest'     — daily aggregated digest markdown per channel.
   *
   * Mirrors v1's joi-sd4 capture_mode YAML field. See migration 015.
   */
  capture_mode?: 'standalone' | 'digest';
  created_at: string;
}

// ── Identity & privilege ──

/**
 * User = a messaging-platform identifier. Namespaced so distinct channels
 * with numeric IDs don't collide: "phone:+1555...", "tg:123", "discord:456",
 * "email:a@x.com". A single human with a phone AND a telegram handle has
 * two separate users — no cross-channel linking (yet).
 */
export interface User {
  id: string;
  kind: string; // 'phone' | 'email' | 'discord' | 'telegram' | 'matrix' | ...
  display_name: string | null;
  created_at: string;
}

export type UserRoleKind = 'owner' | 'admin';

/**
 * Role grant. Owner is always global. Admin is either global
 * (agent_group_id = null) or scoped to a specific agent group.
 * Admin @ A implicitly makes the user a member of A — we do not require
 * a separate agent_group_members row for admins.
 */
export interface UserRole {
  user_id: string;
  role: UserRoleKind;
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

/** "Known" membership in an agent group — required for unprivileged users. */
export interface AgentGroupMember {
  user_id: string;
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

/** Cached DM channel for a user on a specific channel_type. */
export interface UserDm {
  user_id: string;
  channel_type: string;
  messaging_group_id: string;
  resolved_at: string;
}

export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';
export type SenderScope = 'all' | 'known';
export type IgnoredMessagePolicy = 'drop' | 'accumulate';

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: EngageMode;
  /**
   * Regex source string used when engage_mode='pattern'. `'.'` is the sentinel
   * for "match every message" (the "always" flavor). Ignored for 'mention' /
   * 'mention-sticky' modes.
   */
  engage_pattern: string | null;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
  session_mode: 'shared' | 'per-thread' | 'agent-shared';
  priority: number;
  created_at: string;
}

export interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  agent_provider: string | null;
  status: 'active' | 'closed';
  container_status: 'running' | 'idle' | 'stopped';
  last_active: string | null;
  created_at: string;
}

// ── Session DB entities ──

export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';
export type MessageInStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface MessageIn {
  id: string;
  kind: MessageInKind;
  timestamp: string;
  status: MessageInStatus;
  status_changed: string | null;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

export interface MessageOut {
  id: string;
  in_reply_to: string | null;
  timestamp: string;
  delivered: number; // 0 | 1
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

// ── Pending questions (central DB) ──

export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options: import('./channels/ask-question.js').NormalizedOption[];
  created_at: string;
}

// ── Pending approvals (central DB) ──

export interface PendingApproval {
  approval_id: string;
  session_id: string | null;
  request_id: string;
  action: string;
  payload: string; // JSON
  created_at: string;
  agent_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  platform_message_id: string | null;
  expires_at: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  title: string;
  options_json: string;
}

// ── Agent destinations (central DB) ──

export interface AgentDestination {
  agent_group_id: string;
  local_name: string;
  target_type: 'channel' | 'agent';
  target_id: string;
  created_at: string;
}
