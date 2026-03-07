## Purpose
Define the WhatsApp channel provider contract for connectivity, inbound/outbound message handling, media text extraction, and reliability behavior.

## Requirements

### Requirement: Channel Registration and Discovery
WhatsApp integration MUST self-register as a channel provider discoverable by the runtime at startup.

#### Scenario: Runtime channel bootstrap
- **GIVEN** the channel barrel import is loaded
- **WHEN** startup resolves registered channel factories
- **THEN** the WhatsApp factory is present and can be instantiated with shared channel callbacks

### Requirement: Persistent Authentication State
WhatsApp connectivity MUST use persisted auth state so sessions survive restarts.

#### Scenario: Startup with existing credentials
- **GIVEN** persisted WhatsApp credentials are available
- **WHEN** the channel connects
- **THEN** it reuses the stored credentials instead of requiring a fresh login

### Requirement: Re-Authentication Signaling
The integration MUST fail fast when authentication is missing or expired.

#### Scenario: QR authentication required
- **GIVEN** WhatsApp reports a QR challenge during runtime connect
- **WHEN** the channel receives the QR update
- **THEN** it logs an authentication-required signal and terminates so setup can re-authenticate

### Requirement: Inbound Message Normalization
Incoming WhatsApp events MUST be normalized before runtime routing.

#### Scenario: Message upsert with wrapped content
- **GIVEN** an inbound WhatsApp message is wrapped in container message types
- **WHEN** the channel processes the upsert
- **THEN** it unwraps content, ignores status broadcasts, records chat metadata, and emits normalized message fields to runtime callbacks

### Requirement: Registered-Group Message Delivery
Only registered chats MUST receive full inbound message delivery into runtime processing.

#### Scenario: Message from non-registered chat
- **GIVEN** a WhatsApp chat is not registered in runtime state
- **WHEN** the channel receives a message from that chat
- **THEN** it publishes chat metadata but does not emit full message content for agent processing

### Requirement: Media Caption Support
Text carried in media captions MUST be treated as message content.

#### Scenario: Image or video with caption
- **GIVEN** an inbound media message includes a caption
- **WHEN** content extraction runs
- **THEN** the caption text is used as the message content for routing

### Requirement: Reliable Outbound Delivery Across Disconnects
Outbound sends MUST queue during disconnection and flush on reconnect.

#### Scenario: Sending while disconnected
- **GIVEN** WhatsApp is temporarily disconnected
- **WHEN** runtime requests a send
- **THEN** the message is queued and later delivered when the connection is re-established

### Requirement: Assistant Identity in Outbound Text
Outbound WhatsApp text MUST carry assistant identity when running on a shared number.

#### Scenario: Shared-number response send
- **GIVEN** the assistant does not have a dedicated phone number
- **WHEN** a response is sent
- **THEN** the message is prefixed with the configured assistant name for user-visible attribution

### Requirement: Group Metadata Synchronization
WhatsApp group names MUST be periodically synchronized into runtime state.

#### Scenario: Scheduled group sync
- **GIVEN** the channel is connected
- **WHEN** sync runs on startup, manual trigger, or periodic interval
- **THEN** discovered group subjects are written to chat metadata storage
