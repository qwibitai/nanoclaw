## Purpose
Define Command Center webhook ingestion, authentication, event validation, and routing into runtime actions.

## Requirements

### Requirement: Dedicated CC Webhook Endpoint
The runtime MUST expose a POST-only endpoint for Command Center events.

#### Scenario: Request to non-matching route or method
- **GIVEN** an HTTP request does not match `POST /hooks/cc`
- **WHEN** the webhook server handles the request
- **THEN** it returns not found without invoking event routing

### Requirement: Shared-Secret Authentication
Webhook processing MUST require a configured token and valid token match.

#### Scenario: Missing or invalid token
- **GIVEN** webhook token validation is required
- **WHEN** the runtime has no configured token or the request token is invalid
- **THEN** it rejects the request with an authentication/configuration error and does not process the event

### Requirement: Payload Shape and Size Validation
Webhook payloads MUST be valid JSON objects within size limits.

#### Scenario: Invalid payload body
- **GIVEN** a webhook request carries malformed JSON, oversized body, or non-object JSON
- **WHEN** payload parsing and validation run
- **THEN** the runtime returns a client error and skips event routing

### Requirement: Supported Event Type Resolution
The runtime MUST accept only known Command Center event types.

#### Scenario: Unknown event type
- **GIVEN** a webhook payload lacks a supported event type
- **WHEN** event extraction runs
- **THEN** the runtime returns a bad-request response and does not route the event

### Requirement: Task Event Routing to Hook Session
Task lifecycle events MUST be converted into synthetic runtime messages for the configured hooks group.

#### Scenario: task_review_ready or task_failed event
- **GIVEN** a valid task lifecycle webhook event arrives
- **WHEN** event routing executes
- **THEN** the runtime composes an assistant-addressed instruction message and stores it as a synthetic message in the configured hooks chat

### Requirement: Alert Event Routing to Direct WhatsApp Notification
Operational alert events MUST send direct notifications to the configured recipient JID.

#### Scenario: pipeline_stalled or release_closed event
- **GIVEN** a valid alert-style webhook event arrives
- **WHEN** event routing executes
- **THEN** the runtime sends a formatted alert/summary message to the configured WhatsApp recipient

### Requirement: Hook Group Safety Checks
Synthetic hook-session writes MUST require a configured and registered target group.

#### Scenario: Hook group missing or unregistered
- **GIVEN** a webhook event requires synthetic message storage
- **WHEN** hook group configuration is absent or not registered
- **THEN** the runtime logs the condition and skips message insertion without crashing

### Requirement: Accepted Response on Successful Routing
Successfully routed webhook events MUST return an accepted response.

#### Scenario: Event handled successfully
- **GIVEN** a valid authenticated event was processed
- **WHEN** routing completes without internal error
- **THEN** the server returns an accepted status with the resolved event type
