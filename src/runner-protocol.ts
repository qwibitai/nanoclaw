/**
 * NanoClaw Runner Protocol — v0 wire types.
 *
 * This file is the TypeScript representation of the protocol contract.
 * Central interacts with runners only through these types.
 * No runner-internal types leak into this file or into central's routing layer.
 *
 * Spec: projects/nanoclaw/specs/runner-protocol-v0.md
 */

// ── Base frame ────────────────────────────────────────────────────────────────

export type MessageType =
  | 'RUNNER_REGISTER'
  | 'RUNNER_ACK'
  | 'INBOUND_MESSAGE'
  | 'MESSAGE_ACK'
  | 'TOOL_CALL_PROXY'
  | 'TOOL_RESULT_PROXY'
  | 'STALE_TOOL_RESULT'
  | 'RESPONSE'
  | 'HEARTBEAT'
  | 'HEARTBEAT_ACK'
  | 'LIFECYCLE'
  | 'REPLAY_END'
  | 'GAP_NOTICE'
  | 'ERROR'
  // Credential lifecycle (v0.3) — IDs 100-102 reserved for future int-type protocol.
  // Leave gap before 110-119 reserved for EVENT_EMIT (v0.4 event bus).
  | 'TOKEN_ROTATE_REQUEST'
  | 'TOKEN_ROTATE_ACK'
  | 'TOKEN_INVALIDATE';

export interface Frame<T extends MessageType = MessageType, P = unknown> {
  type: T;
  seq: number;
  last_acked_seq: number;
  session_id: string;
  payload: P;
}

// ── RUNNER_REGISTER (R→C) ─────────────────────────────────────────────────────

export interface LocalMCP {
  name: string;
  version?: string;
}

export interface WatcherSubscription {
  type: 'file_watch' | 'process_list' | 'log_tail' | 'journal_stream' | 'launchd_events' | 'disk_usage';
  args: Record<string, unknown>;
}

export interface WebhookEndpoint {
  path: string;
  methods: string[];
  description?: string;
}

export interface RunnerRegisterPayload {
  runner_token: string;
  /** 'credential' (default) or 'bootstrap' (first connect after provisioning). */
  auth_type?: 'credential' | 'bootstrap';
  runner_name: string;
  runner_type: 'persistent' | 'ephemeral';
  runner_version: string;
  protocol_version: string;
  last_inbound_seq: number;
  last_outbound_seq: number;
  local_mcps: LocalMCP[];
  watcher_subscriptions: WatcherSubscription[];
  webhook_endpoints?: WebhookEndpoint[];
}

// ── RUNNER_ACK (C→R) ──────────────────────────────────────────────────────────

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  local: boolean;
}

export interface AssignedAgent {
  remote_agent_id: string;
  runner_id: string;
  model: string;
  instructions: string;
  mcp_servers: MCPServerConfig[];
  workspace_path: string;
}

export interface RunnerConfig {
  remote_agents: AssignedAgent[];
}

export interface RunnerAckPayload {
  runner_id: string;
  session_id: string;
  config_snapshot: RunnerConfig;
  replay_from_seq: number;
  /** Present only when bootstrap auth was used — the long-lived credential to save to keychain. */
  credential?: string;
}

// ── INBOUND_MESSAGE (C→R) ─────────────────────────────────────────────────────

export interface Attachment {
  attachment_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  fetch_url: string;
}

export interface InboundMessagePayload {
  message_id: string;
  remote_agent_id: string;
  sender: string;
  sender_destination: string;
  text: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
  delivered_at: string;
}

// ── MESSAGE_ACK (R→C) ─────────────────────────────────────────────────────────

export interface MessageAckPayload {
  message_id: string;
  remote_agent_id: string;
  status: 'received';
}

// ── TOOL_CALL_PROXY (R→C) ─────────────────────────────────────────────────────

export interface ToolCallProxyPayload {
  call_id: string;
  remote_agent_id: string;
  turn_message_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

// ── TOOL_RESULT_PROXY (C→R) ───────────────────────────────────────────────────

export interface ToolResultProxyPayload {
  call_id: string;
  remote_agent_id: string;
  tool_name: string;
  result: Record<string, unknown>;
  error?: { code: string; message: string };
}

// ── STALE_TOOL_RESULT (R→C) ───────────────────────────────────────────────────

export interface StaleToolResultPayload {
  call_id: string;
  remote_agent_id: string;
  turn_message_id: string;
  reason: 'turn_aborted';
}

// ── RESPONSE (R→C) ────────────────────────────────────────────────────────────

export interface OutboundAttachment {
  filename: string;
  content_type: string;
  data: string; // base64
}

export interface ResponsePayload {
  remote_agent_id: string;
  turn_message_id: string;
  text: string;
  attachments?: OutboundAttachment[];
  turn_stats?: { duration_ms: number; input_tokens?: number; output_tokens?: number };
}

// ── HEARTBEAT (R→C) ───────────────────────────────────────────────────────────

export interface RunnerError {
  code: string;
  message: string;
  since: string;
}

export interface HeartbeatPayload {
  runner_version: string;
  sources_active: string[];
  agents_running: number;
  errors: RunnerError[];
  uptime_seconds: number;
}

// ── HEARTBEAT_ACK (C→R) ───────────────────────────────────────────────────────

export type RunnerStatus = 'connected' | 'unresponsive' | 'disconnected';

export interface HeartbeatAckPayload {
  runner_status: RunnerStatus;
  server_time: string;
}

// ── LIFECYCLE (C→R) ───────────────────────────────────────────────────────────

export type LifecycleAction = 'drain_and_restart' | 'force_restart' | 'update_config' | 'rekey';

export interface LifecyclePayload {
  action: LifecycleAction;
  params?: {
    new_token?: string;
    config_snapshot?: RunnerConfig;
  };
}

// ── REPLAY_END (C→R) ──────────────────────────────────────────────────────────

export interface ReplayEndPayload {
  replayed_count: number;
}

// ── GAP_NOTICE (C→R) ──────────────────────────────────────────────────────────

export interface GapNoticePayload {
  first_available_seq: number;
  dropped_count: number;
  gap_start: string;
}

// ── ERROR (both) ──────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'INVALID_FRAME'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'AUTH_FAILED'
  | 'SESSION_EXPIRED'
  | 'TOOL_ROUTING_VIOLATION'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  ref_seq?: number;
  fatal: boolean;
}

// ── TOKEN_ROTATE_REQUEST (R→C) ────────────────────────────────────────────────

// No payload needed — the authenticated WS connection establishes identity.
export type TokenRotateRequestPayload = Record<string, never>;

// ── TOKEN_ROTATE_ACK (C→R) ────────────────────────────────────────────────────

export interface TokenRotateAckPayload {
  /** New long-lived credential. Runner must save to keychain and use on next RUNNER_REGISTER. */
  new_credential: string;
}

// ── TOKEN_INVALIDATE (C→R) ────────────────────────────────────────────────────

export interface TokenInvalidatePayload {
  reason: 'revoked' | 'compromised';
  message?: string;
}

// ── Protocol version ──────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = '0';
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION]);

// ── Typed frame constructors (central → runner direction) ─────────────────────

export function makeFrame<T extends MessageType, P>(
  type: T,
  payload: P,
  seq: number,
  lastAckedSeq: number,
  sessionId: string,
): Frame<T, P> {
  return { type, seq, last_acked_seq: lastAckedSeq, session_id: sessionId, payload };
}
