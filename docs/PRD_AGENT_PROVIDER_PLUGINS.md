# PRD: Provider Plugin Architecture for Codex and Claude Code

Status: Draft

Owner: TBD

Last updated: 2026-04-03

## Summary

NanoClaw currently treats Claude as part of the core product rather than as an interchangeable runtime. The repo hard-codes Claude-specific SDK calls, session paths, memory file names, auth checks, container contents, and remote-control behavior.

This PRD proposes a provider plugin architecture that makes the core orchestration layer provider-agnostic and moves Codex- and Claude-specific behavior into pluggable adapters. The first milestone is not "replace Claude everywhere." The first milestone is "make Claude just another provider," then add a first-party Codex provider on the same interface.

## Problem

Today, adding Codex means touching many unrelated parts of the system because provider assumptions leak across the repo:

| Area | Current lock-in | Example files |
| --- | --- | --- |
| Agent runtime | Imports Claude SDK directly and uses Claude-specific options like `preset: 'claude_code'` | `container/agent-runner/src/index.ts` |
| Session storage | Stores provider state only in `.claude/` and mounts it to `/home/node/.claude` | `src/container-runner.ts` |
| Memory/instructions | Uses `CLAUDE.md` as the canonical memory file | `setup/register.ts`, `src/index.ts`, `docs/SPEC.md` |
| Remote control | Spawns `claude remote-control` and parses Claude URLs | `src/remote-control.ts` |
| Container image | Installs Claude Code CLI in the base agent image | `container/Dockerfile` |
| Setup/verification | Detects Claude-specific auth variables only | `setup/verify.ts` |
| Product docs | Describes NanoClaw as a Claude-native system | `README.md`, `docs/REQUIREMENTS.md`, `docs/SPEC.md` |

This has four concrete costs:

1. Provider work is high-risk because it requires edits across runtime, setup, docs, and persistence.
2. Core features like scheduling and memory are coupled to Claude terminology instead of stable internal abstractions.
3. Feature parity is hard to reason about because provider behavior is implicit.
4. Future providers would require another round of copy-paste architecture.

## Goals

1. Make the core orchestration layer provider-agnostic.
2. Support both `claude-code` and `codex` as first-party providers.
3. Allow provider selection globally and per group without forking the core runtime.
4. Preserve NanoClaw's existing security model: container isolation, mount validation, IPC boundaries, and OneCLI credential injection.
5. Keep current user-facing features working across providers where possible: chat sessions, scheduled tasks, group memory, MCP tools, and containerized execution.
6. Make provider capabilities explicit so unsupported features degrade cleanly instead of being hard-coded assumptions.

## Non-Goals

1. Rebuilding the channel system.
2. Changing the SQLite/message routing/scheduler architecture.
3. Designing a public third-party plugin marketplace in v1.
4. Guaranteeing perfect feature parity where one provider lacks an equivalent capability.
5. Renaming every Claude-facing document and command in the first implementation phase.

## Users

1. Maintainers who want to evolve NanoClaw without re-entangling the runtime around a single AI tool.
2. Power users who want to choose Codex or Claude Code per deployment or per group.
3. Future contributors who may add more providers later.

## Current-State Findings

### Runtime

- `container/agent-runner/src/index.ts` imports `@anthropic-ai/claude-agent-sdk` directly.
- The query loop depends on Claude-specific concepts such as `settingSources`, `preset: 'claude_code'`, and Claude event shapes.
- `src/container-runner.ts` prepares a `.claude` directory, writes Claude-specific environment flags into `settings.json`, and mounts `/home/node/.claude`.

### Memory and sessions

- Group and global memory are modeled as `CLAUDE.md`.
- Session files live in `data/sessions/{group}/.claude/`.
- The host copies `container/skills/` into `.claude/skills/`, which assumes Claude's project layout.

### Setup and product layer

- `setup/verify.ts` checks `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`.
- `container/Dockerfile` installs `@anthropic-ai/claude-code`.
- `src/remote-control.ts` assumes `claude remote-control`.
- README and docs present Claude as part of the product identity rather than as a provider choice.

## Product Requirements

### Functional requirements

1. The core runtime must select an agent provider by `providerId` rather than by hard-coded Claude logic.
2. A provider must be able to own:
   - session storage layout
   - instruction/memory file materialization
   - runtime invocation
   - auth detection
   - optional remote-control support
   - optional provider-specific setup/health checks
3. Core features must remain provider-neutral:
   - group isolation
   - IPC follow-up messaging
   - scheduled task execution
   - mount allowlists
   - message persistence
   - NanoClaw MCP server integration
4. The system must support at least two built-in providers:
   - `claude-code`
   - `codex`
5. Existing installs must continue working without requiring immediate manual migration.
6. Group-level provider selection must be possible, with a configurable default for new groups.
7. Provider-specific capabilities must be discoverable at runtime so the app can enable, disable, or message around unsupported features.

### Non-functional requirements

1. Claude compatibility must be preserved during migration.
2. New abstractions must reduce, not increase, cross-cutting provider conditionals.
3. Provider state must remain isolated per group.
4. Security-sensitive logic must stay in core, not be delegated to provider plugins.
5. The architecture must allow a future provider to be added without editing unrelated channel or scheduler code.

## Proposed Solution

### 1. Introduce an `AgentProvider` plugin interface

Create a provider registry in core and move all provider-specific behavior behind explicit interfaces.

Suggested core interface:

```ts
export interface AgentProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  validateHost(env: NodeJS.ProcessEnv, projectRoot: string): ProviderCheckResult[];
  prepareSession(ctx: PrepareSessionContext): PreparedSession;
  buildContainerSpec(ctx: BuildContainerSpecContext): ProviderContainerSpec;
  serializeRuntimeInput(ctx: RuntimeInvocationContext): ProviderRuntimeInput;
  startRemoteControl?(ctx: RemoteControlContext): Promise<RemoteControlResult>;
  stopRemoteControl?(): Promise<void>;
}

export interface ProviderCapabilities {
  persistentSessions: boolean;
  projectMemory: boolean;
  remoteControl: boolean;
  agentTeams: boolean;
  providerSkills: boolean;
}
```

Core owns the lifecycle. Providers own how the agent is invoked.

### 2. Split host-side and container-side responsibilities

The current implementation mixes host orchestration and Claude SDK behavior together. That should be separated into two layers:

1. Host-side provider plugin.
   Responsibilities:
   - validate credentials and local prerequisites
   - define mount requirements
   - define session directory layout
   - serialize provider runtime config
   - expose optional features like remote control

2. Container-side provider runner.
   Responsibilities:
   - invoke the provider CLI/SDK
   - translate provider-native events into NanoClaw's standard event protocol
   - manage provider-specific resume/session semantics
   - materialize provider-specific instruction files

Suggested in-container event shape:

```ts
type AgentEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'result'; text: string | null }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'provider_state'; state: Record<string, unknown> };
```

This keeps `src/container-runner.ts` focused on containers, timeouts, IPC, and mount policy rather than provider semantics.

### 3. Create a provider registry instead of provider conditionals

Add a registry that loads first-party providers by ID.

Recommended v1 approach:

1. Built-in local plugins only.
2. Register them in code from a single place.
3. Defer dynamic plugin loading from npm or external repos until after the interface is proven.

This still achieves the architectural goal without introducing a second plugin system problem.

### 4. Introduce a canonical provider-neutral memory model

The repo currently treats `CLAUDE.md` as both the product concept and the implementation detail. That creates lock-in.

Proposed direction:

1. Adopt a provider-neutral canonical memory file in core, recommended name: `AGENT.md`.
2. Provider plugins materialize whatever their runtime expects from that source of truth.
3. During migration, support legacy `CLAUDE.md` by reading it if `AGENT.md` is absent.
4. Do not force existing users to rename files on day one.

Examples:

- Claude provider renders `CLAUDE.md` inside the provider workspace.
- Codex provider renders `AGENTS.md` or its equivalent instruction file inside the provider workspace.

Core should care about "group memory" and "global memory," not the filename required by a specific tool.

### 5. Namespace provider session state

Provider state should be isolated under provider-specific directories rather than hard-coded `.claude`.

Proposed layout:

```text
data/
  sessions/
    <group>/
      claude-code/
        ...
      codex/
        ...
```

Rules:

1. Core owns the top-level session namespace.
2. Providers own the contents under their namespace.
3. Provider plugins can mount their state into provider-specific in-container locations such as `/home/node/.claude` or `/home/node/.codex`.
4. Existing `.claude` session data should remain readable for Claude during migration.

### 6. Add provider selection to the data model

Group and task execution must know which provider to use.

Proposed additions:

1. Add `provider_id` to `registered_groups`.
2. Add `DEFAULT_AGENT_PROVIDER` to environment configuration.
3. Add optional provider config in the group model.

Suggested shape:

```ts
export interface AgentProviderConfig {
  providerId: string;
  options?: Record<string, unknown>;
}
```

`containerConfig` should remain focused on timeouts and mounts. Provider config should be separate.

### 7. Make container assembly provider-aware

`container/Dockerfile` should stop representing a Claude-specific image.

Recommended v1 approach:

1. Keep one core agent image.
2. Install the core runtime host plus built-in provider binaries inside that image.
3. Let each provider declare:
   - npm packages to install
   - system packages to install
   - extra environment or directories it needs

This preserves the current simple deployment model while removing Claude as a baked-in assumption.

If image size becomes a problem later, the architecture can evolve to provider-specific images.

### 8. Treat remote control as an optional provider capability

Remote control is currently a Claude-specific feature path. It should become capability-based.

Rules:

1. Core exposes `/remote-control` only if the active provider supports it.
2. Claude provider can reuse the current implementation.
3. Codex provider can either implement an equivalent flow or report "unsupported" with a provider-specific explanation.

This avoids forcing all providers to mimic Claude's exact UX.

### 9. Decouple provider skills from core orchestration

The repo currently copies `container/skills/` into `.claude/skills/`, which is useful but Claude-specific.

Proposed direction:

1. Core owns NanoClaw operational capabilities.
2. Provider plugins own how bundled helper skills/prompts/tools are exposed to their runtime.
3. The provider interface should define a skill sync step if the provider has a skill/plugin concept.

Examples:

- Claude provider syncs to `.claude/skills/`.
- Codex provider syncs to its provider-specific skill directory or prompt bundle location.

### 10. Move auth verification behind providers

`setup/verify.ts` and related setup flows should ask the active provider how to validate credentials.

Examples:

- Claude provider validates `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or equivalent proxy assumptions.
- Codex provider validates Codex-specific auth state and CLI readiness.

Core should know whether credentials are valid, not which environment variable names imply validity.

## Recommended Code Layout

```text
src/
  agent/
    provider-types.ts
    provider-registry.ts
    runtime.ts
    memory.ts
    session-store.ts
    providers/
      claude-code/
        host.ts
        remote-control.ts
      codex/
        host.ts
container/
  agent-runner/
    src/
      runtime/
        index.ts
        provider-types.ts
        providers/
          claude-code.ts
          codex.ts
```

Initial files likely to change:

1. `src/container-runner.ts`
2. `container/agent-runner/src/index.ts`
3. `src/remote-control.ts`
4. `setup/register.ts`
5. `src/index.ts`
6. `setup/verify.ts`
7. `container/Dockerfile`
8. `src/types.ts`

## Migration Plan

### Phase 1: Extract Claude into a provider plugin

Goal: no product behavior change.

Deliverables:

1. Create provider interfaces and registry.
2. Move current Claude behavior into `claude-code` host/container providers.
3. Keep existing `.claude` and `CLAUDE.md` behavior as compatibility mode.
4. Ensure all existing tests still pass.

### Phase 2: Add provider-neutral memory and session abstractions

Goal: remove provider assumptions from core persistence and workspace preparation.

Deliverables:

1. Introduce canonical `AGENT.md` support.
2. Namespace provider session directories.
3. Add `provider_id` to group persistence.
4. Add migration logic for existing groups and sessions.

### Phase 3: Implement Codex provider

Goal: run NanoClaw end-to-end on Codex without forking core code.

Deliverables:

1. Codex host plugin.
2. Codex container-side runner.
3. Codex auth verification.
4. Codex memory/instruction materialization.
5. Codex container dependencies.

### Phase 4: Make setup and commands capability-aware

Goal: user-facing flows stop assuming Claude.

Deliverables:

1. Provider selection in setup/config.
2. Capability-gated `/remote-control`.
3. Provider-neutral health checks and status output.
4. Updated docs for dual-provider support.

### Phase 5: Switch default provider if desired

Goal: make Codex the default only after parity is acceptable.

Deliverables:

1. Set `DEFAULT_AGENT_PROVIDER=codex` by default if approved.
2. Keep Claude provider supported for existing users.
3. Publish migration notes.

## Acceptance Criteria

1. Core modules outside provider folders no longer import provider-specific SDKs or CLIs.
2. A group can declare `providerId: 'claude-code'` or `providerId: 'codex'`.
3. Existing Claude users continue working without manually re-registering groups.
4. Both providers can:
   - start a new conversation
   - resume a conversation
   - read group memory
   - read global memory
   - execute scheduled tasks
   - call NanoClaw MCP tools
5. Provider state is isolated per group and per provider.
6. Unsupported provider features fail explicitly and cleanly.
7. Setup/verify reports provider-specific readiness without hard-coded Claude env checks in generic code.
8. Documentation distinguishes NanoClaw core concepts from provider-specific implementation details.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Codex and Claude have different session/resume semantics | Conversation continuity may regress | Standardize NanoClaw's event contract and let providers translate internally |
| Memory file expectations differ | Users may end up editing the wrong file | Introduce canonical memory plus provider-rendered compatibility files |
| Remote control has no Codex equivalent | UX divergence | Make it an optional capability, not a required core feature |
| Container image grows too large | Slower builds and setup | Start with built-in providers; split images later only if needed |
| Migration touches many docs and tests | Rollout slows down | Phase the implementation: runtime first, docs second |
| Provider abstractions become too generic | Harder to implement real providers | Keep the v1 interface opinionated and based on the needs of Claude plus Codex only |

## Recommended Decisions for V1

1. Built-in provider plugins only. Do not start with dynamic external loading.
2. Claude remains the default during the extraction phase.
3. `AGENT.md` becomes the canonical long-term memory file, with compatibility reads from `CLAUDE.md`.
4. Remote control is optional per provider.
5. Provider-specific skills/tool bundles are managed by the provider plugin rather than by core.

## Open Questions

1. Should Codex become the default provider in the first public release of this work, or only after a stabilization period?
2. Should existing `CLAUDE.md` files be migrated automatically to `AGENT.md`, or should the system support both indefinitely?
3. Do we want per-task provider override, or is per-group provider selection enough for v1?
4. How much Codex parity is required before Claude-specific docs are rewritten to be provider-neutral?
5. Should provider capabilities be visible to end users in `/status` or only used internally?

## Definition of Done

This project is complete when NanoClaw can run the same core chat and task workflows through either a Claude Code provider plugin or a Codex provider plugin, while the core orchestration layer no longer contains hard-coded provider assumptions.
