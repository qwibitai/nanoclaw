/**
 * S3 message types for NanoClaw B2 storage bus.
 * Used for agent inbox/outbox communication via Backblaze B2 (S3-compatible).
 */

export type S3MessageType =
  | 'user_message'
  | 'agent_message'
  | 'delegate_task'
  | 'context_request'
  | 'context_update'
  | 'file_transfer'
  | 'system';

/**
 * Envelope for messages written to an agent's S3 inbox.
 */
export interface S3Message {
  id: string;
  timestamp: string;
  sourceAgentId: string;
  sourceChannelJid?: string;
  type: S3MessageType;
  payload: Record<string, unknown>;
}

/** delegate_task payload */
export interface DelegateTaskPayload {
  description: string;
  callbackAgentId: string;
  files?: string[];
}

/** context_request payload */
export interface ContextRequestPayload {
  description: string;
  requestedTopics?: string[];
}

/** context_update payload */
export interface ContextUpdatePayload {
  path: string;
  description: string;
}

/** file_transfer payload */
export interface FileTransferPayload {
  transferId: string;
  description: string;
  files: string[];
}

/** user_message payload */
export interface UserMessagePayload {
  text: string;
  senderName?: string;
}

/**
 * Envelope for results written to an agent's S3 outbox.
 * Host polls these to deliver responses to channels.
 */
export interface S3Output {
  id: string;
  timestamp: string;
  agentId: string;
  targetChannelJid?: string;
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * File transfer manifest stored at files/{transferId}/manifest.json.
 */
export interface FileTransferManifest {
  sourceAgentId: string;
  targetAgentId: string;
  files: string[];
  description: string;
  timestamp: string;
}
