// Package protocol defines the NanoClaw runner protocol v0 wire types.
// This mirrors runner-protocol.ts on the central side.
package protocol

import "encoding/json"

// ProtocolVersion is the v0 protocol identifier.
const ProtocolVersion = "0"

// MessageType enumerates all valid frame types.
type MessageType string

const (
	TypeRunnerRegister  MessageType = "RUNNER_REGISTER"
	TypeRunnerAck       MessageType = "RUNNER_ACK"
	TypeInboundMessage  MessageType = "INBOUND_MESSAGE"
	TypeMessageAck      MessageType = "MESSAGE_ACK"
	TypeToolCallProxy   MessageType = "TOOL_CALL_PROXY"
	TypeToolResultProxy MessageType = "TOOL_RESULT_PROXY"
	TypeStaleToolResult MessageType = "STALE_TOOL_RESULT"
	TypeResponse        MessageType = "RESPONSE"
	TypeHeartbeat       MessageType = "HEARTBEAT"
	TypeHeartbeatAck    MessageType = "HEARTBEAT_ACK"
	TypeLifecycle       MessageType = "LIFECYCLE"
	TypeReplayEnd       MessageType = "REPLAY_END"
	TypeGapNotice       MessageType = "GAP_NOTICE"
	TypeError           MessageType = "ERROR"
	// Credential lifecycle (v0.3). Integer IDs 100-102 reserved for future int-type protocol.
	// IDs 110-119 reserved for EVENT_EMIT (v0.4 event bus).
	TypeTokenRotateRequest MessageType = "TOKEN_ROTATE_REQUEST"
	TypeTokenRotateAck     MessageType = "TOKEN_ROTATE_ACK"
	TypeTokenInvalidate    MessageType = "TOKEN_INVALIDATE"
)

// Frame is the envelope for every message in both directions.
type Frame struct {
	Type        MessageType `json:"type"`
	Seq         int64       `json:"seq"`
	LastAckedSeq int64      `json:"last_acked_seq"`
	SessionID   string      `json:"session_id"`
	Payload     interface{} `json:"payload"`
}

// RawFrame is used for decoding when the payload type is not yet known.
type RawFrame struct {
	Type        MessageType     `json:"type"`
	Seq         int64           `json:"seq"`
	LastAckedSeq int64          `json:"last_acked_seq"`
	SessionID   string          `json:"session_id"`
	Payload     json.RawMessage `json:"payload"`
}

// ── RUNNER_REGISTER (R→C) ────────────────────────────────────────────────────

// LocalMCP describes a locally-available MCP server on the runner.
type LocalMCP struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

// RunnerRegisterPayload is the first frame sent by the runner after connecting.
type RunnerRegisterPayload struct {
	RunnerToken     string     `json:"runner_token"`
	// AuthType is "credential" (default) or "bootstrap" on first connect after provisioning.
	AuthType        string     `json:"auth_type,omitempty"`
	RunnerName      string     `json:"runner_name"`
	RunnerType      string     `json:"runner_type"`
	RunnerVersion   string     `json:"runner_version"`
	ProtocolVersion string     `json:"protocol_version"`
	LastInboundSeq  int64      `json:"last_inbound_seq"`
	LastOutboundSeq int64      `json:"last_outbound_seq"`
	LocalMCPs       []LocalMCP `json:"local_mcps"`
}

// ── RUNNER_ACK (C→R) ─────────────────────────────────────────────────────────

// MCPServerConfig describes a MCP server for an assigned agent.
type MCPServerConfig struct {
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env,omitempty"`
	Local   bool              `json:"local"`
}

// AssignedAgent describes a remote agent assigned to this runner.
type AssignedAgent struct {
	RemoteAgentID string            `json:"remote_agent_id"`
	RunnerID      string            `json:"runner_id"`
	Model         string            `json:"model"`
	Instructions  string            `json:"instructions"`
	MCPServers    []MCPServerConfig `json:"mcp_servers"`
	WorkspacePath string            `json:"workspace_path"`
}

// RunnerConfig is the snapshot of agents assigned to this runner.
type RunnerConfig struct {
	RemoteAgents []AssignedAgent `json:"remote_agents"`
}

// RunnerAckPayload is sent by central after a successful RUNNER_REGISTER.
type RunnerAckPayload struct {
	RunnerID       string       `json:"runner_id"`
	SessionID      string       `json:"session_id"`
	ConfigSnapshot RunnerConfig `json:"config_snapshot"`
	ReplayFromSeq  int64        `json:"replay_from_seq"`
	// Credential is set only when bootstrap auth was used — the long-lived token to save.
	Credential     string       `json:"credential,omitempty"`
}

// ── INBOUND_MESSAGE (C→R) ────────────────────────────────────────────────────

// InboundMessagePayload carries a user message to a remote agent.
type InboundMessagePayload struct {
	MessageID          string `json:"message_id"`
	RemoteAgentID      string `json:"remote_agent_id"`
	Sender             string `json:"sender"`
	SenderDestination  string `json:"sender_destination"`
	Text               string `json:"text"`
	DeliveredAt        string `json:"delivered_at"`
}

// ── MESSAGE_ACK (R→C) ────────────────────────────────────────────────────────

// MessageAckPayload acknowledges receipt of an INBOUND_MESSAGE.
type MessageAckPayload struct {
	MessageID     string `json:"message_id"`
	RemoteAgentID string `json:"remote_agent_id"`
	Status        string `json:"status"`
}

// ── RESPONSE (R→C) ───────────────────────────────────────────────────────────

// TurnStats carries optional timing/token metadata for a completed turn.
type TurnStats struct {
	DurationMs   int64 `json:"duration_ms"`
	InputTokens  int64 `json:"input_tokens,omitempty"`
	OutputTokens int64 `json:"output_tokens,omitempty"`
}

// ResponsePayload carries the agent's reply for a completed turn.
type ResponsePayload struct {
	RemoteAgentID  string     `json:"remote_agent_id"`
	TurnMessageID  string     `json:"turn_message_id"`
	Text           string     `json:"text"`
	TurnStats      *TurnStats `json:"turn_stats,omitempty"`
}

// ── HEARTBEAT (R→C) ──────────────────────────────────────────────────────────

// RunnerError represents a non-fatal error state on the runner.
type RunnerError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Since   string `json:"since"`
}

// HeartbeatPayload is sent periodically by the runner.
type HeartbeatPayload struct {
	RunnerVersion  string        `json:"runner_version"`
	SourcesActive  []string      `json:"sources_active"`
	AgentsRunning  int           `json:"agents_running"`
	Errors         []RunnerError `json:"errors"`
	UptimeSeconds  int64         `json:"uptime_seconds"`
}

// ── HEARTBEAT_ACK (C→R) ──────────────────────────────────────────────────────

// HeartbeatAckPayload is central's reply to a heartbeat.
type HeartbeatAckPayload struct {
	RunnerStatus string `json:"runner_status"`
	ServerTime   string `json:"server_time"`
}

// ── LIFECYCLE (C→R) ──────────────────────────────────────────────────────────

// LifecyclePayload instructs the runner to take a lifecycle action.
type LifecyclePayload struct {
	Action string                 `json:"action"`
	Params map[string]interface{} `json:"params,omitempty"`
}

// ── REPLAY_END (C→R) ─────────────────────────────────────────────────────────

// ReplayEndPayload signals that replay is complete.
type ReplayEndPayload struct {
	ReplayedCount int `json:"replayed_count"`
}

// ── GAP_NOTICE (C→R) ─────────────────────────────────────────────────────────

// GapNoticePayload informs the runner that some replay frames were evicted.
type GapNoticePayload struct {
	FirstAvailableSeq int64  `json:"first_available_seq"`
	DroppedCount      int64  `json:"dropped_count"`
	GapStart          string `json:"gap_start"`
}

// ── ERROR (both) ─────────────────────────────────────────────────────────────

// ErrorPayload carries protocol-level error information.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	RefSeq  int64  `json:"ref_seq,omitempty"`
	Fatal   bool   `json:"fatal"`
}

// ── TOKEN_ROTATE_ACK (C→R) ────────────────────────────────────────────────────

// TokenRotateAckPayload carries the new credential issued by central.
type TokenRotateAckPayload struct {
	NewCredential string `json:"new_credential"`
}

// ── TOKEN_INVALIDATE (C→R) ────────────────────────────────────────────────────

// TokenInvalidatePayload signals that the runner's credential has been revoked.
type TokenInvalidatePayload struct {
	Reason  string `json:"reason"`
	Message string `json:"message,omitempty"`
}
