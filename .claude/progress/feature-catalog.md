# NanoClaw Feature Catalog

Generated: 2026-03-07T18:58:50.793Z
Project: nanoclaw

## Features

### core-message-loop - Core Message Loop
- Risk: high
- Summary: Ingress-to-response orchestration for group messages and agent runs.
- Keywords: message loop, group queue, orchestrator, trigger
- Files (5):
  - src/config.ts
  - src/group-folder.ts
  - src/group-queue.ts
  - src/index.ts
  - src/router.ts
- Tests (3):
  - src/group-folder.test.ts
  - src/group-queue.test.ts
  - src/routing.test.ts
- Shared Files:
  - src/config.ts
  - src/group-queue.ts
  - src/index.ts
  - src/router.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/group-folder.test.ts src/group-queue.test.ts src/routing.test.ts

### whatsapp-channel - WhatsApp Channel
- Risk: high
- Summary: WhatsApp transport, auth lifecycle, and incoming message normalization.
- Keywords: whatsapp, baileys, auth, channel
- Files (4):
  - src/channels/whatsapp.ts
  - src/config.ts
  - src/types.ts
  - src/whatsapp-auth.ts
- Tests (1):
  - src/channels/whatsapp.test.ts
- Shared Files:
  - src/channels/whatsapp.ts
  - src/config.ts
  - src/types.ts
- Validation Warnings:
  - missing file: src/whatsapp-auth.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/channels/whatsapp.test.ts

### ipc-dispatch-contract - IPC Dispatch Contract
- Risk: high
- Summary: Task dispatch, approval boundaries, and worker contract validation.
- Keywords: ipc, dispatch, contract, worker
- Files (4):
  - groups/andy-developer/docs/jarvis-dispatch.md
  - src/dispatch-validator.ts
  - src/event-bridge.ts
  - src/ipc.ts
- Tests (3):
  - src/extensions/jarvis/frontdesk-service.test.ts
  - src/ipc-auth.test.ts
  - src/jarvis-worker-dispatch.test.ts
- Shared Files:
  - groups/andy-developer/docs/jarvis-dispatch.md
  - src/dispatch-validator.ts
  - src/event-bridge.ts
  - src/ipc.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/extensions/jarvis/frontdesk-service.test.ts src/ipc-auth.test.ts src/jarvis-worker-dispatch.test.ts

### container-runtime - Container Runtime
- Risk: high
- Summary: Container launch, mount safety, runtime policies, and process supervision.
- Keywords: container, runtime, mount, supervisor
- Files (4):
  - src/container-runner.ts
  - src/container-runtime.ts
  - src/mount-security.ts
  - src/worker-run-supervisor.ts
- Tests (3):
  - src/container-runner.test.ts
  - src/container-runtime.test.ts
  - src/worker-run-supervisor.test.ts
- Shared Files:
  - src/container-runner.ts
  - src/container-runtime.ts
  - src/worker-run-supervisor.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/container-runner.test.ts src/container-runtime.test.ts src/worker-run-supervisor.test.ts

### runtime-ownership-isolation - Runtime Ownership Isolation
- Risk: high
- Summary: Single active NanoClaw host ownership, heartbeat/lease tracking, and service-vs-manual session isolation to prevent WhatsApp conflict churn.
- Keywords: runtime ownership, session isolation, launchd, whatsapp conflict, single owner, manual override
- Files (11):
  - docs/architecture/nanoclaw-system-architecture.md
  - docs/reference/SPEC.md
  - docs/workflow/nanoclaw-container-debugging.md
  - launchd/com.nanoclaw.plist
  - scripts/jarvis-preflight.sh
  - scripts/jarvis-reliability.sh
  - src/channels/whatsapp.ts
  - src/config.ts
  - src/db.ts
  - src/index.ts
  - src/runtime-ownership.ts
- Tests (3):
  - src/channels/whatsapp.test.ts
  - src/db.test.ts
  - src/runtime-ownership.test.ts
- Shared Files:
  - docs/architecture/nanoclaw-system-architecture.md
  - scripts/jarvis-preflight.sh
  - scripts/jarvis-reliability.sh
  - src/channels/whatsapp.ts
  - src/config.ts
  - src/db.ts
  - src/index.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/channels/whatsapp.test.ts src/db.test.ts src/runtime-ownership.test.ts

### task-scheduling - Task Scheduling
- Risk: medium
- Summary: Time-based task definitions and execution pipeline.
- Keywords: schedule, cron, tasks
- Files (2):
  - src/index.ts
  - src/task-scheduler.ts
- Tests (1):
  - src/task-scheduler.test.ts
- Shared Files:
  - src/index.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/task-scheduler.test.ts

### database-state - Database State
- Risk: medium
- Summary: SQLite persistence for tasks, sessions, and metadata.
- Keywords: database, sqlite, state
- Files (2):
  - src/db.ts
  - src/index.ts
- Tests (1):
  - src/db.test.ts
- Shared Files:
  - src/db.ts
  - src/index.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/db.test.ts

### config-env - Config and Environment
- Risk: medium
- Summary: Runtime config resolution and environment variable handling.
- Keywords: config, env, settings
- Files (2):
  - src/config.ts
  - src/env.ts
- Tests (0):
  - none
- Shared Files:
  - src/config.ts
- Suggested Verify:
  - npm run typecheck

### routing-formatting - Routing and Formatting
- Risk: medium
- Summary: Outbound message formatting, mention behavior, and routing logic.
- Keywords: routing, formatting, mentions
- Files (2):
  - src/router.ts
  - src/types.ts
- Tests (2):
  - src/formatting.test.ts
  - src/routing.test.ts
- Shared Files:
  - src/router.ts
  - src/types.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/formatting.test.ts src/routing.test.ts

### jarvis-worker-lifecycle - Jarvis Worker Lifecycle
- Risk: high
- Summary: Worker status transitions, retry loops, and dispatch handoff behavior.
- Keywords: jarvis, worker, lifecycle, handoff, timeout, no-output, retry
- Files (4):
  - groups/andy-developer/CLAUDE.md
  - src/dispatch-validator.ts
  - src/ipc.ts
  - src/worker-run-supervisor.ts
- Tests (2):
  - src/jarvis-worker-dispatch.test.ts
  - src/worker-run-supervisor.test.ts
- Shared Files:
  - groups/andy-developer/CLAUDE.md
  - src/dispatch-validator.ts
  - src/ipc.ts
  - src/worker-run-supervisor.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/jarvis-worker-dispatch.test.ts src/worker-run-supervisor.test.ts

### forked-worker-runtime-restore - Forked Worker Runtime Restore
- Risk: high
- Summary: Root-runtime parity for synthetic worker dispatch, Andy linkage, and live worker recovery in the customized fork.
- Keywords: fork, worker dispatch, synthetic worker, andy, request linkage, runtime restore
- Files (11):
  - scripts/jarvis-incident.sh
  - scripts/jarvis-worker-probe.sh
  - src/config.ts
  - src/container-runner.ts
  - src/container-runtime.ts
  - src/db.ts
  - src/event-bridge.ts
  - src/index.ts
  - src/ipc.ts
  - src/types.ts
  - src/worker-run-supervisor.ts
- Tests (3):
  - src/ipc-auth.test.ts
  - src/jarvis-worker-dispatch.test.ts
  - src/worker-run-supervisor.test.ts
- Shared Files:
  - scripts/jarvis-incident.sh
  - scripts/jarvis-worker-probe.sh
  - src/config.ts
  - src/container-runner.ts
  - src/container-runtime.ts
  - src/db.ts
  - src/event-bridge.ts
  - src/index.ts
  - src/ipc.ts
  - src/types.ts
  - src/worker-run-supervisor.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/ipc-auth.test.ts src/jarvis-worker-dispatch.test.ts src/worker-run-supervisor.test.ts

### jarvis-extension-boundary - Jarvis Extension Boundary
- Risk: high
- Summary: Explicit Jarvis extension modules, lane identity, and dispatch-attempt state extracted out of NanoClaw core control files.
- Keywords: jarvis extension, lane id, dispatch attempts, andy frontdesk, synthetic worker, architecture
- Files (15):
  - docs/architecture/nanoclaw-jarvis.md
  - docs/architecture/nanoclaw-system-architecture.md
  - src/db.ts
  - src/extensions/jarvis/dispatch-service.ts
  - src/extensions/jarvis/frontdesk-service.ts
  - src/extensions/jarvis/index.ts
  - src/extensions/jarvis/lane-control-service.test.ts
  - src/extensions/jarvis/lane-control-service.ts
  - src/extensions/jarvis/lanes.ts
  - src/extensions/jarvis/request-state-service.ts
  - src/group-queue.test.ts
  - src/group-queue.ts
  - src/index.ts
  - src/ipc.ts
  - src/types.ts
- Tests (4):
  - src/extensions/jarvis/lane-control-service.test.ts
  - src/group-queue.test.ts
  - src/ipc-auth.test.ts
  - src/jarvis-worker-dispatch.test.ts
- Shared Files:
  - docs/architecture/nanoclaw-jarvis.md
  - docs/architecture/nanoclaw-system-architecture.md
  - src/db.ts
  - src/extensions/jarvis/frontdesk-service.ts
  - src/extensions/jarvis/request-state-service.ts
  - src/group-queue.ts
  - src/index.ts
  - src/ipc.ts
  - src/types.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/extensions/jarvis/lane-control-service.test.ts src/group-queue.test.ts src/ipc-auth.test.ts src/jarvis-worker-dispatch.test.ts

### andy-review-ownership - Andy Review Ownership
- Risk: high
- Summary: Auto-triggered review workflow for Andy-developer, including review-state progression, bounded direct review patches, and rework lineage.
- Keywords: andy review, review requested, review trigger, direct patch, rework lineage, request state
- Files (11):
  - docs/architecture/nanoclaw-jarvis.md
  - docs/workflow/nanoclaw-jarvis-dispatch-contract.md
  - groups/andy-developer/CLAUDE.md
  - groups/andy-developer/docs/github.md
  - groups/andy-developer/docs/jarvis-dispatch.md
  - groups/jarvis-worker-1/docs/workflow/worker-skill-policy.md
  - groups/jarvis-worker-2/docs/workflow/worker-skill-policy.md
  - src/db.ts
  - src/extensions/jarvis/frontdesk-service.ts
  - src/extensions/jarvis/request-state-service.ts
  - src/index.ts
- Tests (3):
  - src/db.test.ts
  - src/extensions/jarvis/frontdesk-service.test.ts
  - src/jarvis-worker-dispatch.test.ts
- Shared Files:
  - docs/architecture/nanoclaw-jarvis.md
  - groups/andy-developer/CLAUDE.md
  - groups/andy-developer/docs/jarvis-dispatch.md
  - src/db.ts
  - src/extensions/jarvis/frontdesk-service.ts
  - src/extensions/jarvis/request-state-service.ts
  - src/index.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/db.test.ts src/extensions/jarvis/frontdesk-service.test.ts src/jarvis-worker-dispatch.test.ts

### andy-request-admin-cleanup - Andy Request Admin Cleanup
- Risk: medium
- Summary: Administrative cleanup tooling for stale non-terminal Andy requests, including dry-run inspection and explicit archival/closure.
- Keywords: andy requests, stale request cleanup, archive requests, cancel stale requests, admin command, testing backlog
- Files (3):
  - .claude/progress/feature-catalog.seed.json
  - scripts/jarvis-ops.sh
  - scripts/jarvis-reconcile-stale-andy-requests.sh
- Tests (1):
  - src/jarvis-reconcile-stale-andy-requests.test.ts
- Shared Files:
  - .claude/progress/feature-catalog.seed.json
  - scripts/jarvis-ops.sh
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/jarvis-reconcile-stale-andy-requests.test.ts

### architecture-boundary-governance - Architecture Boundary Governance
- Risk: high
- Summary: Hard boundary contract and deterministic checks that keep upstream NanoClaw core separate from Jarvis extension logic.
- Keywords: architecture boundary, core vs extension, governance, enforcement, agent guardrails, jarvis customization
- Files (8):
  - .claude/progress/feature-catalog.seed.json
  - AGENTS.md
  - CLAUDE.md
  - DOCS.md
  - docs/ARCHITECTURE.md
  - docs/README.md
  - scripts/check-architecture-boundary.sh
  - scripts/check-workflow-contracts.sh
- Tests (0):
  - none
- Shared Files:
  - .claude/progress/feature-catalog.seed.json
- Suggested Verify:
  - npm run typecheck

### reliability-e2e - Reliability E2E Harness
- Risk: medium
- Summary: End-to-end reliability scripts for Andy and worker lanes.
- Keywords: reliability, e2e, smoke, journey
- Files (3):
  - scripts/test-andy-full-user-journey-e2e.ts
  - scripts/test-andy-user-e2e.ts
  - scripts/test-worker-e2e.ts
- Tests (0):
  - none
- Shared Files:
  - scripts/test-andy-user-e2e.ts
- Suggested Verify:
  - npm run typecheck

### observability-logging - Observability and Logging
- Risk: medium
- Summary: Structured logging and timeline/status tooling for debugging runtime behavior.
- Keywords: logger, timeline, status, trace, watch
- Files (6):
  - scripts/jarvis-hi-timeline.sh
  - scripts/jarvis-message-timeline.sh
  - scripts/jarvis-status.sh
  - scripts/jarvis-trace.sh
  - scripts/jarvis-watch.sh
  - src/logger.ts
- Tests (0):
  - none
- Suggested Verify:
  - npm run typecheck

### ops-reliability-tooling - Ops and Reliability Tooling
- Risk: high
- Summary: Operational scripts for preflight checks, incident lifecycle, reliability probes, and recovery.
- Keywords: ops, reliability, incident, preflight, recover, smoke, timeout, not-responding, andy
- Files (13):
  - scripts/jarvis-db-doctor.sh
  - scripts/jarvis-dispatch-lint.sh
  - scripts/jarvis-happiness-gate.sh
  - scripts/jarvis-hotspots.sh
  - scripts/jarvis-incident-bundle.sh
  - scripts/jarvis-incident.sh
  - scripts/jarvis-ops.sh
  - scripts/jarvis-preflight.sh
  - scripts/jarvis-recover.sh
  - scripts/jarvis-reliability.sh
  - scripts/jarvis-smoke.sh
  - scripts/jarvis-verify-worker-connectivity.sh
  - scripts/jarvis-worker-probe.sh
- Tests (0):
  - none
- Shared Files:
  - scripts/jarvis-happiness-gate.sh
  - scripts/jarvis-incident.sh
  - scripts/jarvis-ops.sh
  - scripts/jarvis-preflight.sh
  - scripts/jarvis-reliability.sh
  - scripts/jarvis-worker-probe.sh
- Suggested Verify:
  - npm run typecheck

### skills-engine-lifecycle - Skills Engine Lifecycle
- Risk: high
- Summary: Deterministic apply/rebase/update/uninstall pipeline for skill-based customization.
- Keywords: skills, apply, rebase, update, drift, manifest
- Files (16):
  - scripts/apply-skill.ts
  - scripts/fix-skill-drift.ts
  - scripts/post-update.ts
  - scripts/rebase.ts
  - scripts/run-migrations.ts
  - scripts/uninstall-skill.ts
  - scripts/update-core.ts
  - scripts/validate-all-skills.ts
  - skills-engine/apply.ts
  - skills-engine/index.ts
  - skills-engine/manifest.ts
  - skills-engine/rebase.ts
  - skills-engine/state.ts
  - skills-engine/types.ts
  - skills-engine/uninstall.ts
  - skills-engine/update.ts
- Tests (4):
  - skills-engine/__tests__/apply.test.ts
  - skills-engine/__tests__/rebase.test.ts
  - skills-engine/__tests__/uninstall.test.ts
  - skills-engine/__tests__/update.test.ts
- Validation Warnings:
  - missing file: scripts/post-update.ts
  - missing file: scripts/rebase.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run skills-engine/__tests__/apply.test.ts skills-engine/__tests__/rebase.test.ts skills-engine/__tests__/uninstall.test.ts skills-engine/__tests__/update.test.ts

### agent-runner-mcp - Agent Runner and MCP Bridge
- Risk: high
- Summary: In-container Claude runner and nanoclaw MCP bridge for IPC tools, streaming, and task calls.
- Keywords: agent-runner, mcp, ipc, container, tools
- Files (4):
  - container/agent-runner/src/index.ts
  - container/agent-runner/src/ipc-mcp-stdio.ts
  - container/build.sh
  - container/Dockerfile
- Tests (0):
  - none
- Suggested Verify:
  - npm run typecheck

### worker-runtime-lane - Worker Runtime Lane
- Risk: high
- Summary: Worker container runtime and runner logic for jarvis worker execution lane.
- Keywords: worker, container, runner, jarvis-worker
- Files (4):
  - container/worker/build.sh
  - container/worker/Dockerfile
  - container/worker/runner/src/index.ts
  - container/worker/runner/src/lib.ts
- Tests (1):
  - container/worker/runner/src/lib.test.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run container/worker/runner/src/lib.test.ts

### core-skill-workflows - Core Skill Workflows
- Risk: medium
- Summary: Primary local skills that drive setup, customization, debugging, updates, and incident workflows.
- Keywords: skills, setup, customize, debug, update, incident
- Files (8):
  - .claude/skills/convert-to-apple-container/SKILL.md
  - .claude/skills/customize/SKILL.md
  - .claude/skills/debug/SKILL.md
  - .claude/skills/get-qodo-rules/SKILL.md
  - .claude/skills/incident-debugger/SKILL.md
  - .claude/skills/qodo-pr-resolver/SKILL.md
  - .claude/skills/setup/SKILL.md
  - .claude/skills/update/SKILL.md
- Tests (0):
  - none
- Validation Warnings:
  - missing file: .claude/skills/incident-debugger/SKILL.md
- Suggested Verify:
  - npm run typecheck

### feature-tracking-pipeline - Feature Tracking Pipeline
- Risk: high
- Summary: Feature ownership catalog build/validation/query scripts that prevent duplicate implementation paths.
- Keywords: feature tracking, ownership, touch set, catalog, duplication, scope
- Files (7):
  - .claude/progress/feature-catalog.seed.json
  - .claude/skills/feature-tracking/scripts/audit-feature-coverage.ts
  - .claude/skills/feature-tracking/scripts/build-feature-catalog.ts
  - .claude/skills/feature-tracking/scripts/check-touch-set.ts
  - .claude/skills/feature-tracking/scripts/locate-feature.ts
  - .claude/skills/feature-tracking/scripts/validate-feature-catalog.ts
  - .claude/skills/feature-tracking/SKILL.md
- Tests (0):
  - none
- Shared Files:
  - .claude/progress/feature-catalog.seed.json
- Suggested Verify:
  - npm run typecheck

### project-skill-delivery-pipeline - Project Skill Delivery Pipeline
- Risk: high
- Summary: Project-specific orchestrator, implementation, and testing skills with auditable work-item and validation flow.
- Keywords: orchestrator, implementation, testing, workflow, happiness gate, evidence
- Files (8):
  - .claude/skills/nanoclaw-implementation/SKILL.md
  - .claude/skills/nanoclaw-orchestrator/scripts/work-item.ts
  - .claude/skills/nanoclaw-orchestrator/SKILL.md
  - .claude/skills/nanoclaw-testing/scripts/run-feature-tests.ts
  - .claude/skills/nanoclaw-testing/SKILL.md
  - docs/workflow/nanoclaw-andy-user-happiness-gate.md
  - scripts/jarvis-happiness-gate.sh
  - scripts/test-andy-user-e2e.ts
- Tests (0):
  - none
- Shared Files:
  - scripts/jarvis-happiness-gate.sh
  - scripts/test-andy-user-e2e.ts
- Suggested Verify:
  - npm run typecheck

### channel-extension-skills - Channel and Integration Extension Skills
- Risk: medium
- Summary: Optional upstream capabilities delivered as skills (Telegram, Slack, Discord, Gmail, X, voice, parallel).
- Keywords: telegram, slack, discord, gmail, x, voice, parallel, skills
- Files (8):
  - .claude/skills/add-discord/SKILL.md
  - .claude/skills/add-gmail/SKILL.md
  - .claude/skills/add-parallel/SKILL.md
  - .claude/skills/add-slack/SKILL.md
  - .claude/skills/add-telegram-swarm/SKILL.md
  - .claude/skills/add-telegram/SKILL.md
  - .claude/skills/add-voice-transcription/SKILL.md
  - .claude/skills/x-integration/SKILL.md
- Tests (5):
  - .claude/skills/add-discord/tests/discord.test.ts
  - .claude/skills/add-gmail/tests/gmail.test.ts
  - .claude/skills/add-slack/tests/slack.test.ts
  - .claude/skills/add-telegram/tests/telegram.test.ts
  - .claude/skills/add-voice-transcription/tests/voice-transcription.test.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run .claude/skills/add-discord/tests/discord.test.ts .claude/skills/add-gmail/tests/gmail.test.ts .claude/skills/add-slack/tests/slack.test.ts .claude/skills/add-telegram/tests/telegram.test.ts .claude/skills/add-voice-transcription/tests/voice-transcription.test.ts

## Usage

- Build catalog: `npx tsx .claude/skills/feature-tracking/scripts/build-feature-catalog.ts`
- Validate catalog: `npx tsx .claude/skills/feature-tracking/scripts/validate-feature-catalog.ts`
- Locate feature: `npx tsx .claude/skills/feature-tracking/scripts/locate-feature.ts "<query>"`
