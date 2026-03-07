## ADDED Requirements

### Requirement: Hierarchical CLAUDE.md Memory Model
NanoClaw MUST provide memory at global and group scopes using `CLAUDE.md` files in the `groups/` hierarchy.

#### Scenario: Reading memory for a group interaction
- **WHEN** an agent runs for a group folder
- **THEN** it can use both global memory (`groups/CLAUDE.md`) and that group's local memory (`groups/<group>/CLAUDE.md`)

### Requirement: Group-Scoped Working Directory
Agent runs MUST execute with the current working directory set to the target group's folder.

#### Scenario: Group context during execution
- **WHEN** the router invokes an agent for a registered group
- **THEN** the agent's project context is rooted at `groups/<group>/` and file operations apply within that group context

### Requirement: Project-Source Context Loading
Memory loading MUST rely on project settings so parent and local `CLAUDE.md` files are included automatically.

#### Scenario: Loading parent and local memory files
- **WHEN** the agent starts with project setting sources enabled
- **THEN** it includes both `../CLAUDE.md` and `./CLAUDE.md` in context

### Requirement: Explicit Memory Write Semantics
User intents for remembering information MUST map to scoped file updates in the memory hierarchy.

#### Scenario: Group-level memory write
- **WHEN** a user asks to remember information in a regular group
- **THEN** the agent records it in that group's `CLAUDE.md`

#### Scenario: Global memory write request
- **WHEN** a user asks to remember information globally
- **THEN** only the main group can update `groups/CLAUDE.md`

### Requirement: Main Group Administrative Privileges
The main group MUST hold elevated control for cross-group operations.

#### Scenario: Main channel executes privileged operations
- **WHEN** an action requires managing groups, global memory, scheduling across groups, or configuring additional mounts
- **THEN** the action is allowed only from the main group context

### Requirement: Group File Memory Artifacts
Group conversations MUST be able to persist structured artifacts as files in their own folder.

#### Scenario: Writing notes during a conversation
- **WHEN** the assistant creates notes or research artifacts for a group
- **THEN** files such as `notes.md` and `research.md` are saved under that group's directory
