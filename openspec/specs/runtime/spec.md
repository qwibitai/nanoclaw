## ADDED Requirements

### Requirement: Host Orchestrator and Container Agent Separation
NanoClaw MUST run orchestration logic in the host Node.js process and execute assistant work inside an isolated Linux container runner.

#### Scenario: Running agent work from host loops
- **WHEN** the message loop or scheduler identifies work to execute
- **THEN** the host process invokes containerized agent execution instead of running agent tools directly on the host

### Requirement: Startup Initialization Order
NanoClaw MUST perform startup in a deterministic order so runtime state is valid before processing messages.

#### Scenario: Service startup sequence
- **WHEN** NanoClaw starts
- **THEN** it ensures the container runtime is available, initializes SQLite state, restores persisted state, connects configured channels, and only then starts scheduler, IPC watcher, queue processing, and message polling

### Requirement: SQLite-Backed Message Processing
Incoming messages MUST be persisted and processed through a polling loop backed by SQLite.

#### Scenario: Polling and routing a message
- **WHEN** a channel receives a message
- **THEN** the message is written to SQLite and later consumed by the message loop that polls on a fixed interval

### Requirement: Trigger-Gated Agent Invocation
The router MUST invoke the assistant only for registered groups and messages that match the configured trigger pattern.

#### Scenario: Non-triggered message in registered chat
- **WHEN** a message is stored for a registered group but does not start with the trigger pattern
- **THEN** the system keeps the message in history but does not invoke the assistant

### Requirement: Conversation Catch-Up for Prompt Construction
Before each assistant invocation, the router MUST include missed conversation context since the last agent interaction.

#### Scenario: Building prompt context from backlog
- **WHEN** a triggered message arrives after non-triggered messages in the same chat
- **THEN** the prompt includes timestamped catch-up messages and the current message so the assistant can respond with full context

### Requirement: Assistant Name-Driven Trigger Behavior
Assistant addressing MUST be configurable through `ASSISTANT_NAME` and applied to both trigger parsing and response identity.

#### Scenario: Custom assistant name at runtime
- **WHEN** `ASSISTANT_NAME` is set to a non-default value
- **THEN** trigger matching uses `^@<ASSISTANT_NAME>\b` case-insensitively and responses are prefixed with that assistant name

### Requirement: Managed Service Execution on macOS
NanoClaw MUST support long-running deployment through `launchd` using `com.nanoclaw` service semantics.

#### Scenario: LaunchAgent keeps runtime alive
- **WHEN** `com.nanoclaw.plist` is installed and loaded
- **THEN** launchd runs the Node entrypoint from the project root at load time, keeps it alive, and writes stdout/stderr to project log files

### Requirement: Command Center Webhook Endpoint
NanoClaw MUST expose a Command Center webhook receiver at `POST /hooks/cc` that accepts JSON event payloads.

#### Scenario: Valid webhook request accepted
- **WHEN** Command Center sends a POST request to `/hooks/cc` with a JSON object body containing an event
- **THEN** runtime parses the payload and acknowledges successful routing

### Requirement: Command Center Hook Token Validation
NanoClaw MUST authenticate Command Center webhook requests using the configured hook token.

#### Scenario: Invalid token rejected
- **WHEN** a webhook request does not include a valid token matching `CC_HOOK_TOKEN` (or its backward-compatible alias)
- **THEN** runtime rejects the request and does not route the event

### Requirement: Command Center Event-to-Session Routing
NanoClaw MUST route Command Center lifecycle events to the correct session target.

#### Scenario: Task failure routed to main session
- **WHEN** the webhook event type is `task_failed`
- **THEN** runtime stores a synthetic system message in the main session so Hal is notified

#### Scenario: Task completion or review routed to hook session
- **WHEN** the webhook event type is `task_done` or `review_ready`
- **THEN** runtime stores a synthetic system message in the Command Center hook session
