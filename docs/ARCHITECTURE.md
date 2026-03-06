# Architecture Boundary Contract

## Purpose
Define the hard boundary between upstream-aligned NanoClaw core and fork-owned Jarvis customization so agents know where behavior belongs before editing code.

## Doc Type
`contract`

## Canonical Owner
`docs/ARCHITECTURE.md` owns core-vs-extension ownership rules.

Adjacent docs that must not duplicate this ownership contract:
- `docs/architecture/nanoclaw-system-architecture.md` owns topology and runtime layers.
- `docs/architecture/nanoclaw-jarvis.md` owns Jarvis runtime behavior and lane semantics.
- `docs/reference/REQUIREMENTS.md` owns baseline core constraints.

## Use When
- Before editing `src/index.ts`, `src/ipc.ts`, `src/db.ts`, `src/container-runner.ts`, `src/container-runtime.ts`, or `src/dispatch-validator.ts`
- Before adding new Jarvis behavior, worker-lane logic, Andy request semantics, or synthetic `@nanoclaw` routing
- Before deciding whether a change belongs in core files or `src/extensions/jarvis/*`

## Do Not Use When
- You are changing feature-specific worker contract fields or completion schema details only.
- You are debugging a live incident and need the execution runbook first.
- You are making a purely upstream NanoClaw sync with no Jarvis behavior change.

## Requirements

### Core Principle
NanoClaw core stays small, generic, and upstream-aligned. Jarvis behavior is an extension layer, not an alternative architecture inside the core runtime.

### Architecture Tiers

| Tier | Ownership Rule | Default Change Policy |
|------|----------------|-----------------------|
| Frozen core | Must not gain Jarvis-specific business logic | Only generic runtime, security, performance, or upstream-alignment changes |
| Shared integration seams | May call into Jarvis extension, persist shared state, or expose hooks | Keep logic thin; do not re-implement Jarvis policy inline |
| Jarvis extension | Owns Jarvis-specific policy and orchestration semantics | Preferred home for new Jarvis behavior |

### Frozen Core
These files must not accumulate new Jarvis-specific nouns, routing policy, or worker-lane behavior:

- `src/group-queue.ts`
- `src/router.ts`
- `src/group-folder.ts`
- `src/channels/*`

Allowed changes in frozen core:
- upstream sync compatibility
- generic channel/runtime fixes
- generic security, performance, and reliability work

Disallowed changes in frozen core:
- adding `andy-developer`, `jarvis-worker-*`, or `@nanoclaw` behavior
- request intake/status heuristics
- worker dispatch ownership rules
- synthetic worker JID mapping
- request-to-run linkage policy

### Shared Integration Seams
These files are allowed to integrate with the Jarvis extension, but they must stay thin and generic:

- `src/index.ts`
- `src/ipc.ts`
- `src/db.ts`
- `src/types.ts`
- `src/container-runner.ts`
- `src/container-runtime.ts`
- `src/dispatch-validator.ts`

Rules for shared seams:
- Prefer delegation into `src/extensions/jarvis/*`.
- Keep only glue code, shared persistence primitives, and generic runtime hooks here.
- Do not duplicate Jarvis logic already owned by the extension layer.

### Jarvis Extension
These surfaces are the default home for Jarvis-specific behavior:

- `src/extensions/jarvis/*`
- `scripts/jarvis-*`
- `scripts/test-andy-*`
- `src/ipc-auth.test.ts`
- `src/jarvis-worker-dispatch.test.ts`
- `groups/*`
- Jarvis workflow and architecture docs

If a change introduces any of the following, it belongs in the Jarvis extension layer by default:
- `andy-developer`
- `jarvis-worker-*`
- synthetic `@nanoclaw` routing
- Andy intake/status behavior
- worker lane authorization
- request/linkage semantics

## Field Rules

### Allowed Core-to-Extension Direction
- Shared seam files may import from `src/extensions/jarvis/*`.
- Frozen core files must not import from `src/extensions/jarvis/*`.

### Core Schema Rule
- `src/db.ts` may store Jarvis-backed fields and tables, but state transition policy must live in `src/extensions/jarvis/*`.

### Extension Exception Rule
- If a Jarvis change must touch a shared seam file, the work item must explain why the seam change could not live entirely in the extension layer.

## Validation Gates
- `bash scripts/check-architecture-boundary.sh`
- `bash scripts/check-workflow-contracts.sh`
- `bash scripts/check-claude-codex-mirror.sh`
- `bash scripts/check-tooling-governance.sh`

## Exit Criteria
- The change places new Jarvis behavior in `src/extensions/jarvis/*` unless a seam exception is justified.
- No frozen core file gains new Jarvis-specific markers.
- `CLAUDE.md` and `AGENTS.md` both point to this contract before risky edits.
- The deterministic boundary check passes.

## Related Docs
- `docs/architecture/nanoclaw-system-architecture.md`
- `docs/architecture/nanoclaw-jarvis.md`
- `docs/reference/REQUIREMENTS.md`
- `docs/workflow/nanoclaw-development-loop.md`
