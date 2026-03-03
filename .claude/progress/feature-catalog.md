# NanoClaw Feature Catalog

Generated: 2026-03-03T06:12:40.951Z
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
  - src/config.ts
  - src/types.ts
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
- Tests (2):
  - src/ipc-auth.test.ts
  - src/jarvis-worker-dispatch.test.ts
- Shared Files:
  - src/dispatch-validator.ts
  - src/ipc.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/ipc-auth.test.ts src/jarvis-worker-dispatch.test.ts

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
  - src/worker-run-supervisor.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/container-runner.test.ts src/container-runtime.test.ts src/worker-run-supervisor.test.ts

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
  - src/dispatch-validator.ts
  - src/ipc.ts
  - src/worker-run-supervisor.ts
- Suggested Verify:
  - npm run typecheck
  - npx vitest run src/jarvis-worker-dispatch.test.ts src/worker-run-supervisor.test.ts

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
