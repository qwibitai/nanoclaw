# GitHub Agent Collaboration Loop

## Purpose

Canonical day-to-day workflow for how Claude, Codex, and humans use GitHub Discussions, Issues, and the Project board together in this repository.
This is the operator-facing playbook for deciding where collaboration starts, when it becomes committed work, and how execution state is recorded without creating duplicate trackers.

## Owns

This document owns daily operation of the GitHub collaboration surfaces in this repository:

1. where work should start
2. when a Discussion becomes an Issue
3. how ownership is assigned
4. how the Project board should be used during execution

## Does Not Own

This document does not own:

1. initial board/category/template/workflow rollout
2. workflow auth, merge policy, or review automation setup
3. GitHub-vs-local placement decisions

Use instead:

1. `docs/workflow/github/github-multi-agent-collaboration-loop.md` for rollout/setup
2. `docs/workflow/github/nanoclaw-github-control-plane.md` for governance workflow policy
3. `docs/workflow/github/github-offload-boundary-loop.md` for placement decisions

## Doc Type

`workflow-loop`

## Canonical Owner

This document owns the operating workflow for active agent use of GitHub collaboration surfaces.
Do not duplicate its day-to-day execution rules in `docs/workflow/github/github-multi-agent-collaboration-loop.md` or `docs/workflow/github/nanoclaw-github-control-plane.md`.

## Use When

Use this before agents create, update, promote, or close GitHub Discussions, Issues, or Project items for collaboration work.

## Do Not Use When

- You are bootstrapping the GitHub governance stack itself; use `docs/workflow/github/github-multi-agent-collaboration-loop.md`.
- You are changing workflow auth, Actions, or review policy; use `docs/workflow/github/nanoclaw-github-control-plane.md`.
- You are changing branch/ruleset/security offload boundaries; use `docs/workflow/github/github-offload-boundary-loop.md`.

## Verification

- `bash scripts/check-workflow-contracts.sh`
- `bash scripts/check-claude-codex-mirror.sh`
- `bash scripts/check-tooling-governance.sh`
- `gh project field-list 1 --owner ingpoc --format json`
- `gh project field-list 2 --owner openclaw-gurusharan --format json`
- `gh api graphql -f query='query { repository(owner: "ingpoc", name: "nanoclaw") { discussionCategories(first: 10) { nodes { name slug } } } }'`

## Related Docs

- `docs/workflow/github/github-multi-agent-collaboration-loop.md`
- `docs/workflow/github/nanoclaw-github-control-plane.md`
- `docs/workflow/github/github-offload-boundary-loop.md`
- `docs/operations/workflow-setup-responsibility-map.md`

## Precedence

1. This doc governs ongoing agent use of GitHub collaboration surfaces in this repository.
2. `docs/workflow/github/github-multi-agent-collaboration-loop.md` governs initial setup shape, Project schema, and portable rollout.
3. `docs/workflow/github/nanoclaw-github-control-plane.md` governs workflow auth, review automation, and GitHub-hosted control-plane policy.
4. If there is conflict, `CLAUDE.md` trigger routing decides which doc to read first, then this doc controls day-to-day Project/Discussion behavior.

## Operating Invariants

1. Start work in the least-committed surface that still matches the current maturity of the idea.
2. Use GitHub Discussions for exploration, GitHub Issues for committed work, and the Project board for execution state only.
3. Every active execution Issue has exactly one primary owner in `Agent`.
4. The Project never becomes a second discussion thread; reasoning stays in Discussions, Issues, or PR comments.
5. One class of state gets one source of truth. Do not maintain the same execution state in both GitHub and local files as co-equal trackers.

## Start Surface Selector

1. Discussion:
   - Use for workflow/process ideas, mission-aligned feature ideas, upstream NanoClaw evaluation, Claude/Codex collaboration design, and SDK/tooling opportunity review.
   - Use when there is still uncertainty about scope, ownership, or whether any work should be committed at all.
2. Issue:
   - Use for committed work with scope, one owner, and deterministic acceptance criteria.
   - Do not open an execution Issue until the next action is concrete enough to test or close.
3. Project:
   - Use only as the execution state layer for an existing Issue.
   - Do not create standalone Project cards for ideas, PRs, or discussion topics.

Default tie-breaker:

1. If the topic is ambiguous, start in Discussions.
2. If the work is actionable but not yet claimed, use an Issue.
3. If the work is already claimed or being reviewed, reflect that in the Project.

## Three-Layer Model

Use GitHub with this exact separation of purpose:

1. Discussions = exploration and durable context
2. Issues = committed work
3. Project = execution state

Execution boards in this repository are split by domain, not by agent identity:

1. `NanoClaw Platform` board:
   - platform/runtime features
   - SDK/tooling adoption
   - dispatch/review contracts
   - worker/runtime reliability
   - governance/control-plane changes
2. `Andy/Jarvis Delivery` board:
   - user-provided project work
   - delivery tasks, experiments, and follow-ups for the active project
   - implementation items executed by Andy/Jarvis lanes for that project

Board invariant:

1. one execution item lives on one board only
2. if delivery work depends on platform work, create a separate platform Issue and cross-link it instead of duplicating state across boards

Current live Discussion taxonomy:

1. `Workflow / Operating Model`
2. `Feature Ideas`
3. `Upstream NanoClaw Sync`
4. `Claude/Codex Collaboration`
5. `SDK / Tooling Opportunities`

`SDK / Tooling Opportunities` is the required start surface for:

1. Claude Code changelog review
2. Claude Agent SDK changelog review
3. OpenCode changelog review
4. cross-system feature adoption ideas that affect NanoClaw lane behavior, autonomy, or operator workflow

Project rules:

1. Issue cards only
2. Use `Linked pull requests` to expose PR state from the Issue card
3. Keep the Project as the execution system of record
4. Keep design debate, tradeoff analysis, and research notes out of Project field updates
5. pick the board by domain:
   - `NanoClaw Platform` for platform/runtime/governance items
   - `Andy/Jarvis Delivery` for user-project execution items

## Discussion Contract

Use a Discussion when the goal is to think, compare, align, or evaluate.

Expected outputs from a Discussion:

1. `accepted -> create Issue`
2. `deferred`
3. `rejected`
4. `reference only`

For `SDK / Tooling Opportunities`, use this stricter decision contract:

1. one comment from Claude with an explicit `Agent Label: Claude Code` line plus `accept`, `pilot`, `defer`, or `reject`
2. one comment from Codex with an explicit `Agent Label: Codex` line plus `accept`, `pilot`, `defer`, or `reject`
3. before either agent decides, review the upstream changelog first and then the corresponding implementation/usage docs for the feature under discussion
4. promote to an Issue and add that Issue to the correct board only if both agents choose `accept` or `pilot`
5. before promotion, check whether the Discussion already has an open promoted execution Issue; if it does, update that Issue/Project item instead of creating a duplicate
6. after promotion, leave one summary comment in the Discussion listing the execution Issue numbers and stating which board they were added to
7. if agents disagree, keep the work in Discussion until a human resolves the tie
8. if promoted, run one pilot at a time rather than bundling multiple tooling changes

Do not use a Discussion to:

1. represent active execution state
2. substitute for assigning an owner
3. collect final acceptance evidence for completed code work

## Issue Contract

Every execution Issue should include:

1. the problem being solved
2. the scope boundary
3. deterministic acceptance criteria
4. one primary owner
5. the work source (`user`, `discussion`, `upstream-nanoclaw`, `claude-update`, `codex-observation`, or equivalent current taxonomy)

Promotion from Discussion to Issue:

1. create the Issue when there is a concrete next action
2. first check whether the Discussion already has an open execution Issue for the same candidate; if yes, reuse it instead of creating a duplicate
3. copy only the essential context from the Discussion
4. set `Source=discussion`
5. choose the execution board by domain:
   - `NanoClaw Platform` for platform/runtime/tooling/governance work
   - `Andy/Jarvis Delivery` for user-project execution work
6. assign one owner in `Agent`
7. add the Issue to the chosen board immediately so the unanimous decision becomes visible in execution tracking
8. leave a promotion summary comment in the Discussion with the surviving Issue numbers and board target

For changelog- or research-driven tooling work:

1. link the source Discussion in the Issue body
2. preserve the unanimous agent decision in the Issue summary
3. default the board target to `NanoClaw Platform` unless the result is explicitly scoped to a user-project delivery workflow
4. scope the first Issue as a pilot when the change affects workflow or lane behavior

Do not open an Issue for:

1. unresolved brainstorming
2. unowned collaboration notes
3. vague “keep in mind later” items

## Ownership Contract

Use a single active owner for every execution Issue:

1. `Agent` is the primary owner: `claude`, `codex`, or `human`
2. `Review Lane` is the optional second lane: `none`, `claude`, `codex`, or `human`

Allowed:

1. `Agent=codex`, `Review Lane=claude`
2. `Agent=claude`, `Review Lane=codex`
3. `Agent=human`, `Review Lane=claude` or `codex`

Not allowed:

1. Claude and Codex both acting as active co-owners of one Issue
2. Active work with no owner
3. A discussion acting as a substitute for ownership assignment

Recommended default:

1. one implementation owner
2. one optional review lane
3. one linked PR per primary Issue unless the split is explicitly intentional

## Project Contract

The Project answers only one question: what is the current execution state of committed work?

Board selection rules:

1. choose `NanoClaw Platform` when the work changes NanoClaw itself, its runtime, its worker contracts, or GitHub governance
2. choose `Andy/Jarvis Delivery` when the work delivers user-requested project outcomes
3. if one domain blocks the other, track each domain on its own board and cross-link the Issues
4. do not mirror one execution item across both boards

Delivery-board execution tracking:

1. `Andy/Jarvis Delivery` may use a `Worker` field to show `none`, `andy-developer`, `jarvis-worker-1`, or `jarvis-worker-2`
2. live delivery state is host-managed from `andy_requests` + `worker_runs`, not from worker-authored issue edits
3. workers contribute execution evidence only; they do not manually manage board workflow state
4. issue/PR lifecycle still initializes cards, but runtime transitions own delivery execution status after intake

Platform-board automation tracking:

1. `NanoClaw Platform` uses the `ingpoc` board and the stock GitHub `Status` values `Backlog`, `Ready`, `In Progress`, `Review`, `Blocked`, and `Done`
2. the dedicated Claude `/loop` lane picks only one `Ready` issue at a time and marks the claimed item `In Progress` with `Agent=claude`
3. discussion promotion is not enough for `Ready`; Codex must first write or normalize the scope, acceptance, checks, evidence, blocked conditions, and `Ready Checklist` on the Issue
4. platform automation confirms the active local GitHub account is `ingpoc` before board reads or writes
5. if `Request ID`, `Run ID`, and `Next Decision` text fields are present, platform automation populates them for handoff clarity
6. platform items stay issue-first: design reasoning remains in the Issue body, Discussion, or PR comments

Execution status flow:

1. `Triage`: request accepted and awaiting Andy scoping
2. `Architecture`: Andy is actively planning or coordinating
3. `Ready`: worker dispatch is queued and unblocked
4. `Worker Running`: active Jarvis execution
5. `Review`: worker completion returned to Andy
6. `Blocked`: waiting on dependency or decision
7. `Done`: Issue closed and acceptance met

Platform `/loop` status flow:

1. `Backlog`: newly promoted or newly opened platform work awaiting scope lock
2. `Ready`: issue is decision-complete and eligible for Claude pickup
3. `In Progress`: Claude `/loop` owns active implementation and `Agent=claude`
4. `Review`: PR/evidence is ready for Codex review
5. `Blocked`: waiting on dependency, missing scope, or failed required checks
6. `Done`: merged/closed complete work

Default state transitions:

1. new delivery Issue or auto-created Andy intake -> `Triage`
2. Andy planning/scoping -> `Architecture`
3. accepted dispatch queued -> `Ready`
4. active worker run -> `Worker Running`
5. review handoff to Andy or active PR -> `Review`
6. blocked/cancelled/failed request -> `Blocked`
7. merged/closed complete work -> `Done`

Platform automation transitions:

1. opened/promoted platform issue -> `Backlog`
2. Codex writes or validates the full execution contract on the Issue
3. explicit dispatch readiness -> `Ready`
4. Claude `/loop` claims the item -> `In Progress`
5. PR + evidence ready -> `Review`
6. scope ambiguity/check failure/dependency -> `Blocked`
7. merged/closed complete work -> `Done`

Do not use the Project to store:

1. design rationale
2. incident investigation notes
3. long-form collaboration history
4. duplicate PR state outside the linked field

## CLI, API, and Human-Admin Boundaries

Agents may use GitHub CLI and GraphQL directly for Project work:

1. read Project fields and items
2. add an Issue to the Project
3. update Project field values
4. move status across the execution flow
5. remove accidental PR cards

Agents may use `gh api graphql` for Discussions:

1. read categories
2. read discussions
3. create/update discussion content when needed
4. comment on discussions

Human-admin only:

1. changing Discussion taxonomy/categories
2. changing repo settings
3. changing branch protection/rulesets
4. changing secrets/variables
5. changing the Project schema beyond the accepted field model

## Session Start Sweep

In addition to the normal sweep contract, agents should check whether any open `SDK / Tooling Opportunities` Discussions need a first-response decision or a second agent decision comment before starting unrelated workflow-change work.

Run this before any task work every session:

```bash
# Claude
bash scripts/workflow/gh-collab-sweep.sh --agent claude

# Codex
bash scripts/workflow/gh-collab-sweep.sh --agent codex
```

The sweep surfaces: owned Issues, items needing review, stale discussions in your affinity categories, handoff comments from the other agent, and blocked items.
Act on sweep output before starting new work. See `docs/workflow/github/github-collab-sweep.md` for the full protocol.

## Agent-Category Affinity

Each agent owns first response for a subset of Discussion categories:

| Category | First Responder |
|----------|----------------|
| Workflow / Operating Model | Claude |
| Claude/Codex Collaboration | Claude |
| Feature Ideas | Codex |
| SDK / Tooling Opportunities | Codex |
| Upstream NanoClaw Sync | Codex |

## Handoff Format

When leaving work for the other agent, post a comment on the Issue:

```
<!-- agent-handoff -->
From: claude|codex
To: claude|codex
Status: completed|blocked|needs-review|needs-input
Next: <concrete next action>
Context: <brief context>
```

## Daily Loop

1. Run session-start sweep and act on output.
2. Start in the correct surface using the selector above.
3. Keep exploratory work in Discussions until a next action is concrete.
4. Promote concrete work into an Issue with owner + acceptance criteria.
5. Add the Issue to the Project and keep status current.
6. Link the PR back to the Issue and let the Project show review state.
7. Post a handoff comment if leaving work for the other agent.
8. Close the Issue when acceptance is met; do not hide follow-up work in comments.

## Exit Criteria

This workflow is being followed correctly when all are true:

1. Every active Project item is an Issue, not a PR
2. Every active Issue has exactly one primary owner
3. Every exploratory topic starts in Discussions, not the Project
4. Every promoted discussion-driven Issue sets `Source=discussion`
5. No closed Issue remains `In Progress`
6. Discussion taxonomy and Project schema remain aligned with the accepted collaboration model

## Anti-Patterns

1. Using the Project as a brainstorming board
2. Tracking execution in Discussion comments instead of Issues/Project fields
3. Opening PR cards as duplicates of Issue cards
4. Letting two agents co-own the same active execution item
5. Creating Issues without acceptance criteria
6. Treating category/schema admin as a normal agent task instead of a human-admin task
7. Copying the same work-item state into `.claude/progress` and GitHub as two manual systems of record
