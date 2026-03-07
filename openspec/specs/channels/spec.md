## ADDED Requirements

### Requirement: Registry-Driven Channel Discovery
The channel subsystem MUST use a registry that maps channel names to channel factories and exposes registration and lookup operations.

#### Scenario: Registering a channel factory
- **WHEN** channel code calls `registerChannel(name, factory)` during module load
- **THEN** the registry stores the factory so startup code can discover it by name

### Requirement: Credential-Aware Channel Factories
Each channel factory MUST return either a valid channel instance or `null` when required credentials are missing.

#### Scenario: Missing credentials for an installed channel
- **WHEN** startup invokes a registered channel factory without valid credentials present
- **THEN** the factory returns `null` and the channel is skipped instead of failing process startup

### Requirement: Standard Channel Runtime Interface
All channels MUST implement the shared channel contract for connectivity and messaging.

#### Scenario: Channel contract compliance
- **WHEN** a channel implementation is added
- **THEN** it provides `name`, `connect`, `sendMessage`, `isConnected`, `ownsJid`, and `disconnect`, with optional `setTyping` and `syncGroups`

### Requirement: Self-Registration via Barrel Imports
Installed channels MUST self-register through import side effects, and the barrel index MUST import channel modules to trigger registration.

#### Scenario: Bootstrapping installed channels
- **WHEN** `src/channels/index.ts` is imported during startup
- **THEN** each imported channel module executes its registration logic and becomes available to the orchestrator

### Requirement: Startup Connection of Registered Channels
The orchestrator MUST iterate all registered channel names at startup, instantiate available channels, and connect only valid instances.

#### Scenario: Connecting configured channels
- **WHEN** NanoClaw starts and registry entries exist
- **THEN** the orchestrator attempts each factory and calls `connect()` for channels that returned a non-null instance

### Requirement: Channel Ownership for Outbound Routing
Outbound messages MUST be delivered through the channel that owns the destination JID.

#### Scenario: Sending a reply to a chat JID
- **WHEN** the router needs to emit an assistant response
- **THEN** it finds the owning channel by `ownsJid` and sends via that channel's `sendMessage` implementation

### Requirement: Extension-Friendly Channel Onboarding
Adding a new channel MUST follow the same registration and barrel import pattern used by existing channel integrations.

#### Scenario: Installing a new channel skill
- **WHEN** a new channel is introduced
- **THEN** the change adds a `src/channels/<name>.ts` implementation, calls `registerChannel`, and adds the module import to `src/channels/index.ts`

### Requirement: WhatsApp Headless Pairing Artifacts
The WhatsApp channel MUST persist pairing artifacts for headless setups when authentication is required.

#### Scenario: QR update emitted by Baileys
- **WHEN** the WhatsApp connection emits a QR update event
- **THEN** the channel writes QR payload data to `store/qr-data.txt`
- **AND** if `WHATSAPP_PAIRING_PHONE` is configured, it requests a pairing code and writes it to `store/pairing-code.txt`

### Requirement: WhatsApp Media Message Normalization
The WhatsApp channel MUST normalize non-text media messages into routable textual content for the runtime router.

#### Scenario: Image or voice note received without caption
- **WHEN** a registered WhatsApp chat receives an image or voice note that has no text body
- **THEN** the channel emits an inbound message with stable placeholder content (`[Image]` or `[Voice note]`) so routing and agent invocation remain functional

### Requirement: WhatsApp Reconnect Backoff
The WhatsApp channel MUST reconnect automatically after transient disconnects using exponential backoff.

#### Scenario: Repeated transient disconnects
- **WHEN** WhatsApp disconnects for a non-logout reason
- **THEN** the channel schedules reconnect attempts with increasing delays up to a bounded maximum
