## Purpose
Define runtime configuration contracts for environment-driven behavior, path resolution, and secret handling across host and container boundaries.

## Requirements

### Requirement: Environment-First Configuration Resolution
Runtime settings MUST resolve from environment sources with deterministic defaults.

#### Scenario: Config value resolution
- **GIVEN** a runtime setting is defined in process environment, `.env`, or default constants
- **WHEN** configuration is loaded
- **THEN** process environment takes precedence, `.env` is used as fallback, and built-in defaults apply when unset

### Requirement: Assistant Identity and Trigger Configuration
Assistant identity MUST control both trigger detection and response identity.

#### Scenario: Custom assistant name configured
- **GIVEN** a custom `ASSISTANT_NAME`
- **WHEN** trigger and outbound formatting rules are applied
- **THEN** trigger matching uses the configured assistant name and outbound text attribution uses the same identity contract

### Requirement: Absolute Host Path Contracts
Runtime path settings used for mounts MUST resolve to absolute host paths.

#### Scenario: Configured mount-related paths
- **GIVEN** workspace, auth, data, and group directory settings are configured
- **WHEN** the runtime prepares container mount inputs
- **THEN** configured paths are normalized to absolute host paths before use

### Requirement: Container Runtime Limits and Polling Configuration
Operational timings and limits MUST be externally configurable.

#### Scenario: Runtime boot with custom limits
- **GIVEN** container timeout, idle timeout, poll intervals, and concurrency settings are supplied
- **WHEN** the runtime starts
- **THEN** it uses configured values and enforces sane minimum bounds where applicable

### Requirement: Group-Level Container Overrides
Registered groups MAY provide per-group container overrides through persisted group configuration.

#### Scenario: Group has additional mounts or timeout override
- **GIVEN** a registered group includes container configuration metadata
- **WHEN** a container run is prepared for that group
- **THEN** the runtime applies that group's additional mounts and timeout behavior for the run

### Requirement: Secret Minimization for Container Environment
Only required Claude authentication secrets MUST be exported into the container environment file.

#### Scenario: Preparing `data/env/env`
- **GIVEN** a host `.env` contains multiple variables
- **WHEN** the runtime writes the container-mounted env file
- **THEN** it includes only Claude auth variables required for agent authentication and excludes unrelated host secrets

### Requirement: CC and Hippocampus Endpoint Configuration
Webhook and recall integrations MUST be controlled through explicit runtime config keys.

#### Scenario: External integration endpoints configured
- **GIVEN** CC webhook and Hippocampus settings are provided
- **WHEN** integrations initialize
- **THEN** runtime uses configured host/port/path/token/model and recall URL/top-K/token-budget values to drive integration behavior
