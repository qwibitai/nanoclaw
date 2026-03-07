## Purpose
Define per-turn memory recall behavior using Hippocampus embeddings, including recall injection and episode extraction at conversation boundaries.

## Requirements

### Requirement: Opt-In Recall Middleware
Hippocampus recall MUST be runtime-configurable and bypassed when disabled.

#### Scenario: Recall disabled by configuration
- **GIVEN** Hippocampus integration is disabled
- **WHEN** a prompt is prepared for agent invocation
- **THEN** the prompt is passed through without recall augmentation

### Requirement: Per-Turn Query Derivation
Recall queries MUST be derived from the most recent conversational context.

#### Scenario: Building recall query terms
- **GIVEN** a set of recent messages for a turn
- **WHEN** recall query extraction runs
- **THEN** it derives a bounded query string from recent non-empty user-visible content

### Requirement: Recall Retrieval with Context
Recall requests MUST include conversation identity and bounded retrieval settings.

#### Scenario: Calling Hippocampus recall API
- **GIVEN** recall is enabled and a query is available
- **WHEN** the runtime requests memory recall
- **THEN** it sends chat/session context plus configured top-K and token-budget limits to the Hippocampus recall endpoint

### Requirement: Recall Block Injection
Returned memories MUST be injected into the prompt as a structured recall block ahead of user conversation text.

#### Scenario: Recall results found
- **GIVEN** Hippocampus returns one or more memories
- **WHEN** the runtime prepares the final prompt
- **THEN** it prepends a recall block containing ranked memory summaries within the configured budget

### Requirement: Fail-Open Turn Execution
Turn processing MUST continue when Hippocampus is unavailable.

#### Scenario: Recall API timeout or error
- **GIVEN** a turn requires recall but Hippocampus is unreachable or returns errors
- **WHEN** recall retrieval fails
- **THEN** the runtime logs a warning and proceeds with the original prompt without blocking the turn

### Requirement: Endpoint Compatibility Fallback
The runtime MUST support compatible Hippocampus endpoint variants.

#### Scenario: Primary endpoint returns not found
- **GIVEN** the configured Hippocampus base URL is reachable
- **WHEN** one recall or extraction path returns 404
- **THEN** the runtime retries against supported fallback endpoint paths before failing the request

### Requirement: Boundary Episode Extraction
Conversation episodes MUST be extracted at idle and shutdown boundaries for later retrieval.

#### Scenario: Idle or session-end boundary reached
- **GIVEN** a group conversation reaches idle timeout or runtime shutdown
- **WHEN** boundary extraction executes
- **THEN** the runtime submits an episode extraction payload to Hippocampus with boundary type and conversation context
