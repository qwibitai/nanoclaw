## ADDED Requirements

### Requirement: Containerized Execution Boundary
All assistant tool execution MUST occur in isolated Linux containers rather than directly on the host.

#### Scenario: Running a tool-enabled agent task
- **WHEN** NanoClaw invokes an agent for a message or scheduled task
- **THEN** the invocation runs inside a container boundary with host access limited to mounted paths

### Requirement: Required Volume Mount Layout
Container launches MUST mount group, global, and session data paths using the documented layout.

#### Scenario: Mounting runtime paths for a non-main group
- **WHEN** a non-main group container is started
- **THEN** it mounts `groups/<group>/` to `/workspace/group`, `groups/global/` to `/workspace/global/`, and `data/sessions/<group>/.claude/` to `/home/node/.claude/`

### Requirement: Additional Mount Configuration
Registered groups MAY define additional host directories mounted under `/workspace/extra/` in container space.

#### Scenario: Applying per-group additional mounts
- **WHEN** `containerConfig.additionalMounts` is configured for a group
- **THEN** each allowed host path is mounted to `/workspace/extra/<containerPath>` with configured read-only or read-write mode

### Requirement: Read-Only Mount Compatibility
Read-only bind mounts MUST use explicit bind-mount syntax for runtime compatibility.

#### Scenario: Creating a read-only additional mount
- **WHEN** an additional mount is marked as read-only
- **THEN** container launch uses `--mount type=bind,...,readonly` semantics instead of relying on `:ro` suffix behavior

### Requirement: Authentication Variable Minimization
Only Claude authentication variables MUST be extracted from `.env` into the mounted env file for containers.

#### Scenario: Preparing container environment file
- **WHEN** runtime prepares `data/env/env`
- **THEN** it writes `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` while excluding unrelated `.env` variables

### Requirement: Runtime Isolation and Least Privilege
Container security posture MUST include filesystem/process isolation and non-root execution.

#### Scenario: Running agent process in container
- **WHEN** a containerized agent starts
- **THEN** it runs as unprivileged `node` user (uid 1000) and cannot access host files outside explicit mounts

### Requirement: Prompt-Injection Blast Radius Reduction
Message-originated prompt injection risk MUST be mitigated by layered controls.

#### Scenario: Handling potentially malicious inbound message content
- **WHEN** a registered chat sends adversarial instructions
- **THEN** processing remains constrained by trigger gating, registered-group checks, and mount-limited container execution
