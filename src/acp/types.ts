// Zed Agent Client Protocol (ACP) types for the outbound client.
// Source of truth: `@agentclientprotocol/sdk` (Apache-2.0, maintained by Zed).
//
// NOT to be confused with the Linux Foundation / BeeAI "Agent Communication
// Protocol" — that's a different protocol that happens to share the acronym.

export type {
  AgentCapabilities,
  CancelNotification,
  ClientCapabilities,
  ContentBlock,
  EnvVariable,
  FileSystemCapabilities,
  Implementation,
  InitializeRequest,
  InitializeResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PermissionOptionKind,
  PromptRequest,
  PromptResponse,
  ProtocolVersion,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionId,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

export {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';

// --- AgentLite-specific types (not in the ACP spec) ---

/** User-configured outbound peer declaration in AgentOptions.acp.peers. */
export interface AcpPeerConfig {
  /** Stable name the model uses to reference this peer (e.g. "claude-code"). */
  name: string;
  /** Executable to spawn. */
  command: string;
  /** CLI args passed to the command. */
  args: string[];
  /** Env vars to inject — resolved host-side, never written into the container. */
  env?: Record<string, string>;
  /** Short description shown to the model in `list_remote_agents`. */
  description?: string;
}

/** Shape returned by acp_list_remote_agents — one entry per configured peer. */
export interface AcpPeerDirectoryEntry {
  name: string;
  description?: string;
  /** Populated lazily after the first successful initialize handshake. */
  agent_info?: { name: string; version: string; title?: string | null } | null;
}
