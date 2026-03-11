# Andy-Developer Workflow Control Admin

Control-plane playbook for the current operating model:

- `Linear` owns issue state, ownership, triage, readiness, blockers, and review state
- `Notion` owns shared context, specs, decisions, research, and session summaries
- `GitHub` owns repositories, PRs, CI, reviews, and merge policy
- `Symphony` is optional and bounded to approved `Ready` implementation queues
- repo files own execution contracts and machine artifacts only

## Scope

`andy-developer` is the coordinator, team lead, reviewer, administrator, and readiness gatekeeper.

Andy-developer may directly change:

- `.github/workflows/*.yml`
- CI and review policy docs
- branch governance docs and operational checklists
- control-plane automation scripts
- issue-routing and readiness contracts
- pre-seeded worker branches (`jarvis-*`) created from an approved `base_branch`

Andy-developer must not become the default implementation lane for scoped product work.

## Surface Split

Use exactly one authoritative surface per concern:

- `Linear`: active execution issues, ownership, triage, `Ready` gating, review, and project state
- `Notion`: shared specs, decisions, research, project roots, and session context
- `GitHub`: branches, PRs, reviews, CI, and merge governance
- `Symphony`: issue execution only when explicitly approved
- repo files: dispatch contracts, catalogs, incidents, diagnostics, and evidence

Do not recreate issue state anywhere outside Linear.

## Role Routing

### NanoClaw repo

For `NanoClaw` repo work:

1. the user shapes the feature or problem
2. `andy-developer` structures the work and approves readiness
3. `codex` or `claude-code` executes
4. `andy-developer` reviews, coordinates, and closes the loop

### Downstream project work

For downstream project work:

1. the user requests work through WhatsApp
2. `andy-developer` creates or updates project context and issue scope
3. `andy-developer` approves `Ready`
4. `jarvis-worker-*` implements by default
5. Symphony may orchestrate only explicitly approved downstream `Ready` issues

### NanoClaw repo work

For `NanoClaw` repo work:

1. the user shapes the feature or problem
2. `andy-developer` structures the work and approves readiness
3. `codex`, `claude-code`, or approved Symphony queues execute
4. Symphony-routed NanoClaw issues must name `Target Runtime = codex | claude-code`

## Ready Gate

`Ready` is an admin/coordinator decision.

Before an issue can be marked `Ready`, it must contain:

1. problem statement
2. scope
3. acceptance criteria
4. required checks
5. required evidence
6. blocked conditions
7. target repo
8. base branch
9. linked Notion context when non-trivial
10. explicit execution lane

Scheduled Codex or Claude support lanes may normalize issue content, but they do not replace Andy-developer as the readiness authority.

## Scheduled Lane Rules

### Platform pickup

Use the daytime Claude pickup lane only for NanoClaw issues that are already `Ready`.

Rules:

1. the lane reads and mutates Linear issue state only
2. Notion context may lead to a Linear issue, but never marks one `Ready`
3. the lane executes scoped work only; it does not shape the issue
4. the lane writes pickup, review, and blocker outcomes back to Linear and GitHub

### Nightly and morning support lanes

Use the nightly and morning lanes as scheduled support automation only.

Rules:

1. nightly work is research-only and updates Notion shared context
2. morning prep is triage/support work and may promote or defer, but does not become the `Ready` authority
3. neither lane is a Symphony workload

## GitHub Governance Boundary

GitHub governance remains Andy-developer owned:

1. workflow policy
2. review policy
3. branch protection
4. merge guardrails
5. worker-branch seeding

## Evidence Format for Admin Changes

When reporting completion, include:

- changed workflow file list
- affected checks or state transitions
- proof of latest validation status
- rollback command or revert PR reference
