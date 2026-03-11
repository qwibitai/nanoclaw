# Execution Lane Routing Contract

## Purpose

Canonical routing contract for deciding which lane executes work, who may mark work `Ready`, and where Symphony is allowed to orchestrate execution.

## Doc Type

`contract`

## Canonical Owner

This document owns execution-lane routing for NanoClaw and downstream project work.
It does not own shared-context placement, GitHub governance, or worker runtime internals.

## Use When

- changing which lane executes NanoClaw repo work
- changing which lane executes downstream project work
- changing `Ready` authority
- changing whether Symphony is allowed for a class of work
- changing Linear `Execution Lane` or `Work Class` conventions

## Do Not Use When

- changing the Linear/Notion/GitHub surface split only; use `docs/workflow/control-plane/collaboration-surface-contract.md`
- changing GitHub review or merge policy; use `docs/workflow/github/github-delivery-governance.md`
- changing worker runtime/container behavior; use `docs/workflow/runtime/nanoclaw-jarvis-worker-runtime.md`

## Verification

- `bash scripts/check-workflow-contracts.sh`
- `bash scripts/check-claude-codex-mirror.sh`
- `npm test -- src/platform-loop.test.ts src/platform-loop-sync.test.ts src/extensions/jarvis/frontdesk-service.test.ts src/ipc-auth.test.ts src/db.test.ts`
- `node scripts/workflow/platform-loop.js next`

## Related Docs

- `docs/workflow/control-plane/collaboration-surface-contract.md`
- `docs/operations/roles-classification.md`
- `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md`
- `docs/workflow/delivery/platform-claude-pickup-lane.md`

## Requirements

### Core role model

Use these roles consistently:

- `you`: product shaper and prioritizer
- `andy-developer`: coordinator, team lead, reviewer, administrator, readiness gatekeeper
- `codex`: NanoClaw execution lane and review/repair lane
- `claude-code`: NanoClaw execution lane and scheduled automation lane
- `jarvis-worker-*`: downstream project implementation lanes
- `symphony`: optional orchestrator for selected `Ready` implementation work

### Work classes

Every committed Linear issue must have exactly one `Work Class`:

- `nanoclaw-core`
- `downstream-project`
- `governance`
- `research`

Every committed Linear issue must have exactly one `Execution Lane`:

- `codex`
- `claude-code`
- `jarvis-worker`
- `symphony`
- `human`

### Ready authority

`Ready` is a coordination decision, not an execution-lane self-assignment.

Rules:

1. only `andy-developer` may approve or set `Ready`
2. execution lanes may propose readiness gaps or recommendations
3. execution lanes may not self-upgrade vague or incomplete work into `Ready`
4. scheduled support lanes may normalize issue content, but they do not become the readiness authority

Required `Ready` fields:

1. problem statement
2. scope
3. acceptance criteria
4. required checks
5. required evidence
6. blocked conditions
7. target repo
8. base branch
9. linked Notion context for non-trivial work
10. explicit execution lane

## Routing Rules

### NanoClaw repo work

For any issue with `Work Class = nanoclaw-core`:

- default execution lane is `codex` or `claude-code`
- `jarvis-worker-*` do not implement NanoClaw repo work by default
- `symphony` may orchestrate selected NanoClaw issues only when explicitly enabled
- `andy-developer` coordinates, reviews, and governs

Typical split:

- `codex`: issue normalization support, implementation, review/repair, morning prep support
- `claude-code`: scheduled execution, bounded implementation pickup, reliability/debug loops
- `symphony`: optional orchestrator for selected `codex` or `claude-code` NanoClaw implementation work

### Downstream project work

For any issue with `Work Class = downstream-project`:

- `andy-developer` shapes and approves readiness
- `jarvis-worker-*` are the default implementation lanes
- `symphony` may orchestrate execution only when the issue is explicitly eligible
- target GitHub repo is the downstream project repo, not NanoClaw

### Governance work

For any issue with `Work Class = governance`:

- owner is typically `andy-developer`
- execution lane is `human`, `codex`, or `claude-code`
- `jarvis-worker-*` are not used unless the governance task explicitly belongs to a downstream project repo

### Research work

For any issue with `Work Class = research`:

- use `human`, `codex`, or `claude-code`
- do not route to `jarvis-worker-*`
- do not route to `symphony`

## Symphony Boundary

### Allowed

Symphony may be used only for selected implementation issues when all are true:

1. `Work Class = nanoclaw-core` or `downstream-project`
2. `Execution Lane = symphony`
3. issue state is `Ready`
4. `andy-developer` approved the issue for execution
5. repo, branch, acceptance, and evidence contract are complete

### Forbidden

Symphony must not be used for:

1. NanoClaw feature shaping
2. nightly research
3. morning prep
4. session summarization
5. governance/admin work
6. vague project intake

## Transition Rules

Allowed execution-lane transitions:

1. `Ready -> In Progress`
2. `In Progress -> Review`
3. `In Progress -> Blocked`
4. `Review -> Done` only with the review/evidence contract satisfied

Blocked transitions:

1. any execution lane setting `Ready` on its own work
2. `jarvis-worker-*` executing NanoClaw repo tasks by default
3. `symphony` consuming any work outside explicitly approved project queues

## Exit Criteria

This contract is implemented correctly when all are true:

1. every Linear issue has one `Work Class` and one `Execution Lane`
2. `Ready` is owned by the coordination layer, not by execution lanes
3. NanoClaw repo issues route to `codex`, `claude-code`, or approved Symphony queues
4. Symphony-routed NanoClaw issues always target `codex` or `claude-code`
5. downstream project issues route to `jarvis-worker-*` or approved Symphony queues
6. nightly and morning support lanes remain outside Symphony
