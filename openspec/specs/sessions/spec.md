## ADDED Requirements

### Requirement: Per-Group Session Identity Persistence
NanoClaw MUST persist one active assistant session identifier per group folder in SQLite.

#### Scenario: Looking up continuity state for a group
- **WHEN** the router prepares an invocation for `groups/<group-folder>`
- **THEN** it resolves that group's session record from the `sessions` table keyed by `group_folder`

### Requirement: Resume-Based Conversation Continuity
Assistant invocations MUST pass the persisted session ID to the Claude Agent SDK `resume` mechanism.

#### Scenario: Continuing an existing conversation
- **WHEN** a group already has a stored session ID
- **THEN** the next invocation uses that ID so conversation context continues instead of starting a fresh session

### Requirement: Session Transcript Storage
Session transcripts MUST be stored in per-group `.claude` directories under `data/sessions/`.

#### Scenario: Persisting transcript artifacts
- **WHEN** an invocation produces session transcript output
- **THEN** transcript files are written as JSONL under `data/sessions/<group>/.claude/`

### Requirement: Correct Session Mount Path in Containers
Containerized agent runs MUST mount session state to the container user's home `.claude` path.

#### Scenario: Mounting session state for the `node` user
- **WHEN** a container is launched for a group
- **THEN** `data/sessions/<group>/.claude/` is mounted to `/home/node/.claude/` so resume data is readable and writable

### Requirement: Session State Update After Interaction
After a successful agent interaction, runtime state MUST persist updated continuity metadata.

#### Scenario: Saving post-response session state
- **WHEN** the assistant response is sent
- **THEN** the system stores the latest session ID and interaction timestamp for future catch-up and resume behavior
