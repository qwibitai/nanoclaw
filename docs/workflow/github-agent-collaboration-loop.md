# GitHub Agent Collaboration Loop

## Purpose
Canonical day-to-day workflow for how Claude, Codex, and humans use GitHub Discussions, Issues, and the Project board together in this repository.

## Doc Type
`workflow-loop`

## Canonical Owner
This document owns the operating workflow for active agent use of GitHub collaboration surfaces.
Do not duplicate its day-to-day execution rules in `docs/workflow/github-multi-agent-collaboration-loop.md` or `docs/workflow/nanoclaw-github-control-plane.md`.

## Use When
Use this before agents create, update, promote, or close GitHub Discussions, Issues, or Project items for collaboration work.

## Do Not Use When
- You are bootstrapping the GitHub governance stack itself; use `docs/workflow/github-multi-agent-collaboration-loop.md`.
- You are changing workflow auth, Actions, or review policy; use `docs/workflow/nanoclaw-github-control-plane.md`.
- You are changing branch/ruleset/security offload boundaries; use `docs/workflow/github-offload-boundary-loop.md`.

## Verification
- `bash scripts/check-workflow-contracts.sh`
- `bash scripts/check-claude-codex-mirror.sh`
- `bash scripts/check-tooling-governance.sh`
- `gh project field-list 1 --owner ingpoc --format json`
- `gh api graphql -f query='query { repository(owner: "ingpoc", name: "nanoclaw") { discussionCategories(first: 10) { nodes { name slug } } } }'`

## Related Docs
- `docs/workflow/github-multi-agent-collaboration-loop.md`
- `docs/workflow/nanoclaw-github-control-plane.md`
- `docs/workflow/github-offload-boundary-loop.md`
- `docs/operations/workflow-setup-responsibility-map.md`

## Precedence
1. This doc governs ongoing agent use of GitHub collaboration surfaces in this repository.
2. `docs/workflow/github-multi-agent-collaboration-loop.md` governs initial setup shape, Project schema, and portable rollout.
3. `docs/workflow/nanoclaw-github-control-plane.md` governs workflow auth, review automation, and GitHub-hosted control-plane policy.
4. If there is conflict, `CLAUDE.md` trigger routing decides which doc to read first, then this doc controls day-to-day Project/Discussion behavior.

## Phases

### Phase 1: Start in the right GitHub surface

Use exactly one starting surface based on work maturity:

1. Discussion:
   - workflow/process ideas
   - mission-aligned feature ideas
   - upstream NanoClaw evaluation
   - Claude/Codex collaboration design
   - SDK/tooling opportunity review
2. Issue:
   - committed work with scope, owner, and deterministic acceptance criteria
3. Project:
   - execution state only for an existing Issue

Hard rule:

1. Do not create Project cards directly from an idea.
2. Do not use Discussions as execution tracking.
3. Do not use PRs as first-class Project cards.

### Phase 2: Operate the three-layer model

Use GitHub with this exact separation of purpose:

1. Discussions = exploration and durable context
2. Issues = committed work
3. Project = execution state

Current live Discussion taxonomy:

1. `Workflow / Operating Model`
2. `Feature Ideas`
3. `Upstream NanoClaw Sync`
4. `Claude/Codex Collaboration`
5. `SDK / Tooling Opportunities`

Project rules:

1. Issue cards only
2. Use `Linked pull requests` to expose PR state from the Issue card
3. Keep the Project as the execution system of record

### Phase 3: Apply the agent ownership contract

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

### Phase 4: Use CLI vs API vs human-admin boundaries correctly

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

### Phase 5: Promote and close work cleanly

Promotion from Discussion to Issue:

1. create the Issue when there is a concrete next action
2. add deterministic acceptance criteria
3. add the Issue to the Project
4. set `Source=discussion`
5. assign one owner in `Agent`

Execution status flow:

1. `Backlog`: accepted but not active
2. `Ready`: scoped and unblocked
3. `In Progress`: one owner is executing
4. `Review`: PR open or review lane active
5. `Blocked`: waiting on dependency or decision
6. `Done`: Issue closed and acceptance met

Default state transitions:

1. new committed Issue -> `Backlog`
2. claimed scoped work -> `In Progress`
3. linked active PR -> `Review`
4. blocked work -> `Blocked`
5. merged/closed complete work -> `Done`

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
