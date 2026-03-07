## ADDED Requirements

### Requirement: Pre-Turn Hippocampus Recall Middleware
The runtime MUST execute Hippocampus recall middleware between inbound user message processing and every LLM dispatch.

#### Scenario: Recall executes before model invocation
- **WHEN** a turn is about to be sent to the LLM
- **THEN** the runtime resolves recall context and injects it into the prompt before dispatch

### Requirement: User-Topic Query Extraction
Recall queries MUST be derived from key topics in the current user message with limited recent user context.

#### Scenario: Build recall query from user context
- **WHEN** the middleware prepares a recall request
- **THEN** it extracts key terms from the latest user message and recent user messages in the same turn

### Requirement: Hippocampus Recall API Contract
Recall retrieval MUST call Hippocampus at `POST /api/recall` using body `{ query, topK, minScore }`.

#### Scenario: Recall API request
- **WHEN** the middleware issues a recall lookup
- **THEN** it posts JSON to `${HIPPOCAMPUS_URL}/api/recall` with `query` and configured `topK` and `minScore`

### Requirement: RECALL.md Prompt Injection
Recalled memories MUST be injected as a `RECALL.md` section in the prompt and include scored snippets with source references.

#### Scenario: Inject recalled snippets
- **WHEN** Hippocampus returns recall results
- **THEN** the prompt includes a `RECALL.md` section listing memory text, score, and source file references with line positions when available

### Requirement: Per-Turn Recall Cache
The middleware MUST cache recall results for a turn key so duplicate recalls in the same turn do not re-query Hippocampus.

#### Scenario: Duplicate middleware call in same turn
- **WHEN** the same turn context is processed more than once before dispatch completes
- **THEN** the middleware reuses cached recall output and skips an additional `/api/recall` request

### Requirement: Fail-Open Recall Behavior
The runtime MUST continue turn execution if Hippocampus is unavailable.

#### Scenario: Recall service error
- **WHEN** the recall API call fails or times out
- **THEN** the runtime sends the turn without recall injection instead of aborting the turn
