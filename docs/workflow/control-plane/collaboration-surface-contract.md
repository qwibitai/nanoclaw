# Collaboration Surface Contract

## Purpose

Canonical day-to-day workflow for how WhatsApp, Notion, Linear, Symphony, GitHub, and repo-local artifacts work together without creating duplicate trackers.

## Doc Type

`workflow-loop`

## Canonical Owner

This document owns collaboration-surface usage and boundary rules.
It does not own execution-lane routing, GitHub governance, or worker runtime behavior.

## Use When

- deciding where a new request should start
- deciding when context becomes committed execution work
- deciding what belongs in Linear vs Notion vs GitHub
- changing cross-surface operating agreements

## Do Not Use When

- changing which lane executes work; use `docs/workflow/control-plane/execution-lane-routing-contract.md`
- changing GitHub review or merge policy; use `docs/workflow/github/github-delivery-governance.md`
- deciding GitHub-vs-local automation placement; use `docs/workflow/github/github-offload-boundary-loop.md`

## Verification

- `bash scripts/check-workflow-contracts.sh`
- `bash scripts/check-claude-codex-mirror.sh`
- `bash scripts/check-tooling-governance.sh`
- `zsh -lc 'set -a; source .env; set +a; node scripts/workflow/work-control-plane.js'`
- `zsh -lc 'set -a; source .env; set +a; node scripts/workflow/linear-work-sweep.js --agent codex'`

## Related Docs

- `docs/workflow/control-plane/execution-lane-routing-contract.md`
- `docs/workflow/github/github-delivery-governance.md`
- `docs/workflow/github/github-offload-boundary-loop.md`
- `docs/operations/workflow-setup-responsibility-map.md`

## Precedence

1. this document governs where collaboration work lives
2. `docs/workflow/control-plane/execution-lane-routing-contract.md` governs who executes it
3. `docs/workflow/github/github-delivery-governance.md` governs how GitHub-hosted delivery policy works

## Surface Split

Use exactly one authoritative surface per concern:

- `WhatsApp`: request entrypoint and clarification loop only
- `Notion`: shared context, specs, decisions, research, runbooks, session summaries
- `Linear`: committed work, ownership, triage, readiness, blockers, review, done state
- `Symphony`: bounded orchestration for selected `Ready` implementation work
- `GitHub`: repositories, branches, PRs, reviews, CI, merge policy
- repo files: execution contracts and machine artifacts only

Hard rules:

1. WhatsApp is never the system of record
2. Notion is never the execution-state tracker
3. GitHub is never the planning or context system
4. repo-local markdown/json files do not track active work state

## Intake Workflow

When a request arrives, start in the least-committed surface that still matches the maturity of the idea.

### Context-first requests

Start in Notion when the request is:

1. vague or exploratory
2. project-level without clear first scope
3. architectural, research, or multi-session
4. decision-heavy and not yet executable

Required output:

1. a `Session Context` or `Knowledge` page
2. a recommendation to promote, defer, reject, or refine

### Execution-ready requests

Start in Linear when the request is:

1. concrete enough to scope
2. actionable within one primary execution flow
3. ready to assign to one owner and one execution lane

Required output:

1. one Linear issue
2. explicit owner
3. explicit execution lane
4. linked Notion context when non-trivial

### Project-level requests

For requests like “work on Aadhar Chain”:

1. create or find the Linear project
2. create or find the Notion root `Knowledge` page
3. create or confirm the target GitHub repo
4. shape the first concrete issues before any execution starts

## Notion Contract

Notion is the shared context system.

Use exactly two primary databases:

### `Session Context`

For:

1. handoffs
2. nightly findings
3. morning prep summaries
4. active cross-session context
5. project intake notes

### `Knowledge`

For:

1. project root pages
2. specs
3. decisions
4. research
5. runbooks
6. operating docs

Notion rules:

1. Notion pages explain work; they do not carry live task truth
2. every non-trivial execution issue should link to a Notion page
3. Notion session summaries are distilled, not raw transcripts
4. if a Notion page changes execution behavior, the repo-local execution contract must be updated in the same change

## Linear Contract

Linear is the only execution system of record.

It owns:

1. issue ownership
2. triage
3. readiness
4. blockers
5. review status
6. done/canceled state

Linear must not store:

1. long-form research
2. detailed design rationale
3. durable operating docs
4. raw session history

Every active issue should have:

1. one owner
2. one execution lane
3. one work class
4. one linked repo
5. one linked Notion context page when non-trivial

## GitHub Contract

GitHub is the delivery surface only.

It owns:

1. repositories
2. branches
3. PRs
4. CI
5. reviews
6. merge policy

GitHub must not become:

1. a task board
2. a context wiki for active planning
3. a substitute for Linear ownership

## Symphony Contract

Symphony is a bounded execution orchestrator, not a general workflow engine for this repository.

Use it only when:

1. the issue is already `Ready`
2. the issue is explicitly routed to Symphony
3. the work is implementation work approved for Symphony under project policy

Do not use it for:

1. nightly research
2. morning prep
3. project shaping
4. context summarization
5. governance/admin work

## Secret and Access Model

Secrets are provisioned centrally and injected by scope. They are never stored in Notion, Linear, or repo-tracked documents.

Use three levels only:

1. `global workspace secrets`: shared integrations such as Linear, Notion, GitHub, OpenAI
2. `project secrets`: repo- or project-specific credentials used only by that project
3. `lane-scoped credentials`: separate identities only when a lane truly needs its own account or permission boundary

Rules:

1. agents read secrets from one runtime-managed source, not from memory notes
2. Notion and Linear may store setup references or env var names, never raw tokens
3. repos may store env var names and setup contracts, never credential values
4. Symphony receives only the subset of secrets required for the specific project queue, workspace, and target runtime
5. changing credentials, scopes, or secret layout is human-admin work

## Shared Operating Invariants

1. start vague work in Notion, not Linear
2. move to Linear only when work is committed and routable
3. keep one owner and one execution lane per issue
4. keep GitHub limited to code delivery
5. keep Notion limited to shared context
6. keep repository files limited to execution contracts and machine artifacts

## Exit Criteria

This contract is operating correctly when all are true:

1. no active work exists only in WhatsApp or only in Notion
2. no GitHub surface is acting as a second task tracker
3. every non-trivial issue links context in Notion and execution in Linear
4. Symphony is used only for bounded implementation queues approved by project policy
