---
name: plan-work
description: Break a large initiative into independent, sequenced PRs — one PR, one issue. Produces a dependency graph, risk assessment, and GitHub sub-issues. Use after /write-prd. Triggers on "plan work", "break into PRs", "implementation plan", "split into issues", "plan PRs", "sequence work", "one PR one issue".
---

# Plan Work — Break Large Initiatives into PRs

This skill takes a spec document (from `/write-prd` or equivalent) and breaks the implementation into independent, sequenced PRs — each with its own GitHub issue. The output is a dependency graph on the epic issue and a set of sub-issues ready for dev cases.

**Rule: One PR, one issue.** Every PR must have a corresponding issue opened before work begins. No orphan PRs. No multi-PR issues.

**When to use:**
- After `/write-prd` has produced and merged a spec document
- When a large initiative needs implementation planning
- When you look at a spec and think "this is too big for one PR"

**Prerequisite:** A spec document exists (in `docs/` or linked from an epic issue). If not, run `/write-prd` first.

## Phase 1: Understand the Scope

Read the spec document end-to-end. Identify:

1. **All new components** — things that don't exist today (new files, tables, services, MCP servers)
2. **All modified components** — existing code that needs changes
3. **All new data models** — schemas, tables, types
4. **All integration points** — where new code touches existing code
5. **All behavioral changes** — things that work differently after implementation

List these out explicitly. This is your raw material for PR decomposition.

## Phase 2: Decompose into PRs

### Principles

**Each PR should be:**
- **Independent** — mergeable on its own without breaking anything
- **Testable** — has a clear verification criterion
- **Small enough to review** — ideally under 500 lines changed, never over 1000
- **Big enough to be meaningful** — no PRs that just add a type with no consumer

**Decomposition strategy (in priority order):**

1. **Schema first.** Data models, types, DB tables, interfaces. These have zero behavior change and unblock everything else.

2. **Infrastructure second.** New services, servers, runtime changes. These provide the foundation for features.

3. **Features third.** Business logic that uses the schema and infrastructure. These are where the value lives.

4. **Integration last.** Wiring features into the existing system. These are the riskiest because they change user-facing behavior.

### How to find PR boundaries

Ask these questions for each chunk of work:

- **Can this be merged independently?** If removing it would break something else in the plan, it's a dependency — note it.
- **Can this be tested in isolation?** If testing requires another chunk to exist first, that's a dependency.
- **Does this change user-visible behavior?** If yes, it should be its own PR (behavior changes need focused review).
- **Is this a new abstraction or a new use of an existing one?** New abstractions should land before their consumers.

### Splitting large PRs further

If a PR looks too big, split along these lines:

| Original | Split into |
|----------|-----------|
| New MCP server | Schema + read API + write API |
| New agent role | Container config + session management + message handling |
| Full feature | Data layer + business logic + API/UI surface |
| Migration | Schema migration + data backfill + code that uses new schema |

## Phase 3: Map Dependencies

Build a dependency table. Every PR must list what it depends on.

```markdown
| PR | What | Depends on | Risk | Size |
|----|------|-----------|------|------|
| 1. Schema/types | Customer identity types, DB table | Nothing | Low | S |
| 2. Data layer | CRUD operations on identity table | #1 | Low | M |
| 3. MCP server | CRM MCP with access control | #1, #2 | High | L |
| 4. Integration | Wire MCP into container runner | #3 | Medium | M |
```

**Columns explained:**
- **PR** — numbered, with short name
- **What** — one line describing the deliverable
- **Depends on** — which PRs must be merged first (by number)
- **Risk** — Low (schema/types), Medium (logic changes), High (new components, integration points)
- **Size** — S (<200 lines), M (200-500), L (500-1000). If L, consider splitting further.

### Identify parallelism

PRs that share no dependencies can be worked on simultaneously. Call this out explicitly:

```
Phase 1 (parallel): PR #1, PR #4 — no shared dependencies
Phase 2 (parallel): PR #2, PR #5 — both depend on Phase 1 items only
Phase 3 (sequential): PR #3 — depends on #2
Phase 4 (sequential): PR #6 — depends on #3, #5
```

Phasing helps prioritize and shows the critical path.

## Phase 4: Create GitHub Issues

### Update the epic issue

Add the full breakdown to the epic issue (the one created by `/write-prd`). Format:

```markdown
## Implementation Plan

### Dependency Graph

{paste the dependency table from Phase 3}

### Phases

**Phase 1** (can start immediately, parallelizable):
- [ ] #{issue-1} — {PR 1 title}
- [ ] #{issue-4} — {PR 4 title}

**Phase 2** (after Phase 1):
- [ ] #{issue-2} — {PR 2 title}
- [ ] #{issue-5} — {PR 5 title}

**Phase 3** (after Phase 2):
- [ ] #{issue-3} — {PR 3 title}

### Rules
- **One PR, one issue.** Open the sub-issue before starting the PR.
- **Each PR must reference the epic** in its description.
- **Each PR must be independently mergeable** — no "Part 1 of 2" that breaks without Part 2.
- **Update this checklist** as PRs are merged.
```

### Source of Truth

Three artifacts, three responsibilities — no duplication:

| Artifact | Source of truth for | Updated when |
|----------|-------------------|--------------|
| **Spec doc** (`docs/X-spec.md`) | *What* and *why* — architecture, threat model, design decisions, rationale | Design changes during implementation (new PR to spec) |
| **Epic issue** | *How it's split* — dependency table, phases, per-PR scope, completion status | PRs merge (check boxes), plan changes (rows added/removed) |
| **Sub-issues** | *Nothing original* — thin pointers to the epic row and spec sections | Rarely — they're just links |

**The epic issue is the authoritative breakdown.** It has the dependency table with per-PR descriptions, dependencies, risk, and size. If the plan changes (PRs split, merge, or reorder), the epic is where that's tracked.

**Sub-issues are minimal.** They exist so each PR has a trackable issue (one PR, one issue) and so the implementor can find the right context quickly. They do NOT duplicate content from the epic or spec — they link to it.

### Create sub-issues

Sub-issues are thin pointers. Keep them minimal:

```bash
gh issue create --repo {repo} \
  --title "{PR title}" \
  --body "$(cat <<'EOF'
Parent: #{epic-issue-number}
Spec: {link to spec doc}

See the [implementation plan](link-to-epic#implementation-plan) for scope, dependencies, and risk assessment.

**Depends on:** #{dep-1}, #{dep-2} (or "Nothing — can start immediately")
EOF
)"
```

That's it. The epic has the details. The spec has the rationale. The sub-issue is a handle for tracking.

**Why minimal sub-issues:**
- Details in sub-issues drift from the epic — now you have two conflicting sources
- Updating scope means updating the epic AND every affected sub-issue
- The implementor needs to read the spec anyway — a sub-issue summary creates a false sense of "I have enough context"
- The epic's dependency table is the single view of the whole plan — sub-issues are fragments

## Phase 5: Validate the Plan

Before declaring the plan done, check:

- [ ] **Every component from the spec has a home.** Nothing falls through the cracks. Cross-reference Phase 1's component list against the PR breakdown.
- [ ] **No circular dependencies.** If A depends on B and B depends on A, merge them or restructure.
- [ ] **Critical path is clear.** Which PR sequence is the longest? That's your bottleneck.
- [ ] **High-risk PRs are small.** If a PR is both high-risk AND large, split it further.
- [ ] **Each PR row in the epic has clear acceptance criteria.** Not "implement the thing" but specific, testable outcomes in the dependency table.
- [ ] **The first phase has no dependencies.** Someone can start working immediately.

## Cross-References

- **`/write-prd`** — Use first to create the spec document that this skill decomposes into PRs.
- **`/cases`** — Each sub-issue becomes a dev case when work begins.
- **`/kaizen`** — After each PR merge, kaizen reflections may spawn new issues.

## Anti-Patterns

| Don't | Do instead |
|-------|-----------|
| One giant PR with everything | Break into phases with clear dependencies |
| PR without an issue | Always create the issue first |
| Issue covering multiple PRs | One PR, one issue — split the issue |
| "Part 1 of 2" PRs that break alone | Each PR must be independently mergeable |
| Planning at code level (file names, function signatures) | Plan at component/capability level — implementation details belong in the PR |
| Skipping dependency analysis | Map dependencies explicitly — surprises here cause rework |
| Deferring risk assessment | High-risk items surface early so they can be split or de-risked |
| Duplicating details in sub-issues | Sub-issues are thin pointers — epic has details, spec has rationale |
| Acceptance criteria in sub-issues | Keep in epic's dependency table — one place to update |
| Planning distant levels in detail | If a spec defines a 10-level taxonomy and you're at level 3, only plan PRs for levels 3-4. Leave levels 5+ as future work on the epic. The spec defines the *problem* at all levels but solutions only for the current horizon. |
