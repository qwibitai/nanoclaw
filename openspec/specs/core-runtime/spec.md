## Purpose
Define the host runtime contract for session continuity, message routing, tool dispatch, and containerized agent execution.

## Requirements

### Requirement: Deterministic Runtime Startup
The runtime MUST initialize subsystems in a fixed order so message processing begins only after state and channels are ready.

#### Scenario: Service boot
- **GIVEN** the runtime process starts
- **WHEN** startup initialization runs
- **THEN** it ensures container runtime availability, initializes SQLite state, restores persisted runtime state, connects available channels, and only then starts scheduler, IPC watcher, queue processing, and message polling

### Requirement: SQLite-Backed Ingress
Inbound chat messages MUST be persisted before routing decisions are made.

#### Scenario: Channel receives inbound message
- **GIVEN** a connected channel emits a new message event
- **WHEN** the runtime receives the event
- **THEN** it stores the message and chat metadata in SQLite for polling-based processing

### Requirement: Registered-Group and Trigger Gating
Agent invocation MUST be limited to registered chats and trigger-eligible messages.

#### Scenario: Non-eligible message
- **GIVEN** a message arrives in an unregistered chat or a trigger-required chat without a valid trigger
- **WHEN** the polling loop evaluates it
- **THEN** the message remains stored as history but the agent is not invoked

### Requirement: Conversation Catch-Up Prompt Assembly
Agent prompts MUST include missed conversation context since the last agent turn.

#### Scenario: Trigger arrives after normal conversation
- **GIVEN** multiple non-trigger messages were posted after the last agent response
- **WHEN** a valid trigger message is processed
- **THEN** the runtime builds the prompt from all messages since the last agent timestamp, preserving sender and timestamp context

### Requirement: Per-Group Session Continuity
Each group MUST maintain resumable assistant continuity through persisted session identifiers.

#### Scenario: Continuing an existing group conversation
- **GIVEN** a group has a saved session identifier
- **WHEN** the runtime invokes the agent for that group
- **THEN** it passes the session identifier as resume context and persists any updated session identifier returned by the run

### Requirement: Per-Group Queue and Retry Safety
Message processing MUST preserve per-group ordering and avoid duplicate user-visible responses on retries.

#### Scenario: Agent run fails after sending output
- **GIVEN** an agent run emits at least one outbound response and then errors
- **WHEN** the runtime handles the failure
- **THEN** it avoids cursor rollback to prevent duplicate replies

### Requirement: Channel-Owned Outbound Routing
Outbound messages MUST be dispatched only through the channel that owns the target JID.

#### Scenario: Sending an assistant response
- **GIVEN** the runtime has response text for a chat JID
- **WHEN** routing outbound traffic
- **THEN** it resolves the owning channel and sends through that channel's send API

### Requirement: Tool Dispatch via Runtime MCP Surface
Agent tool calls for scheduling and outbound task messaging MUST be routed through the runtime MCP surface with group-scoped permissions.

#### Scenario: Agent requests task operations
- **GIVEN** an agent invocation includes access to built-in runtime tools
- **WHEN** the agent calls scheduling or send-message tools
- **THEN** the runtime executes those calls against its scheduler/message subsystems using the current group's authorization scope
