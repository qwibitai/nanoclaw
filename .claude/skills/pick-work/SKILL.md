---
name: pick-work
description: Intelligently select the next kaizen issue to work on. Filters out claimed issues, balances epic momentum vs topic diversity, and flows into /accept-case. Triggers on "pick work", "what's next", "choose issue", "next kaizen", "pick an issue", "what should I work on", "pick a kaizen", "find work", "pick a high value kaizen".
---

# Pick Work — Intelligent Issue Selection

**Role:** The selector. Chooses WHICH issue to work on next from the kaizen backlog. Avoids collisions with other agents, balances momentum against diversity. Feeds into `/accept-case` — never skips straight to implementation.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — *"Compound interest is the greatest force in the universe. Small improvements compound."*

Select the highest-value next issue from the kaizen backlog, avoiding collisions with other agents and balancing epic momentum against topic diversity.

**When to use:**
- The user asks "what's next", "pick a kaizen", "what should I work on"
- Starting a new dev session and need to choose work
- Finished a case and looking for the next one
- The user wants to see what's available in the backlog

## The Process

### Step 1: Gather the landscape

Run these in parallel to understand the current state:

**High-priority issues (check FIRST — these override normal scoring):**
```bash
gh issue list --repo Garsson-io/kaizen --state open --label "priority:critical" --json number,title,labels
gh issue list --repo Garsson-io/kaizen --state open --label "priority:high" --json number,title,labels
```

**Open issues:**
```bash
gh issue list --repo Garsson-io/kaizen --state open --limit 50 --json number,title,labels,body,createdAt,updatedAt
```

**Currently claimed (filter these OUT):**
```bash
# Issues with status:active or status:backlog labels — an agent is working on them
gh issue list --repo Garsson-io/kaizen --state open --label "status:active" --json number,title
gh issue list --repo Garsson-io/kaizen --state open --label "status:backlog" --json number,title
```

**Active cases (cross-reference):**
```bash
# Check active cases in the database for github_issue linkage (via domain model CLI)
npx tsx src/cli-kaizen.ts case-list --status active,backlog,blocked
```

**Active worktrees (detect implicit WIP — other agents may be working without labeled issues):**
```bash
git worktree list
# Cross-reference branch names: case/* and fix/* branches indicate active work
# Extract kaizen issue numbers from branch names (e.g., k90, k226) to identify which issues are in-flight
# NEVER assume a worktree is stale — other Claude instances may be actively using it
```

**Open PRs (may indicate partial work):**
```bash
gh pr list --repo Garsson-io/nanoclaw --state open --json number,title,headRefName,labels
```

**Recent completed work (for momentum/diversity scoring):**
```bash
# Recently closed issues — what topics were just worked on?
gh issue list --repo Garsson-io/kaizen --state closed --limit 10 --json number,title,labels,closedAt
```

### Step 2: Filter out unavailable issues and identify active domains

Remove from consideration:
- Issues with `status:active`, `status:backlog`, or `status:blocked` labels (another agent is working on them)
- Issues linked to active cases (from the database cross-reference)
- Issues that have open PRs already addressing them

**Map active domains from WIP (complementarity check):**
From the worktrees, cases, and open PRs, identify which *areas* are being worked on — not just which issues. For example, if there's a worktree on `case/260320-auto-deploy`, the entire **deployment** domain is occupied. If there's a PR for hook language boundaries, the **hooks infrastructure** domain has active work.

Build a short "occupied domains" list:
```
OCCUPIED: deployment (case k90), hooks infra (case hook-language-boundaries), worktree mgmt (PR #189, #15)
AVAILABLE: CI quality, kaizen skills, testing infra, case routing, security, observability
```

Prefer issues in AVAILABLE domains. Issues in OCCUPIED domains are not just collision risks — even if they don't overlap on the specific issue, working in the same area creates merge conflicts, invalidated assumptions, and duplicated context-loading.

If an issue is partially addressed (PR exists but not merged), note this — it may be "pick up where someone left off" rather than "start fresh."

### Step 3: Score and rank

For each remaining issue, consider these factors. **Use your judgment — this is reasoning, not arithmetic.**

**Complementarity (avoid occupied domains):**
- Issues in AVAILABLE domains get a strong boost — no collision risk, no merge conflicts, no duplicated context-loading.
- Issues in OCCUPIED domains get a strong penalty. Even if the specific issue doesn't overlap, working in the same domain as another agent creates friction: merge conflicts, invalidated assumptions, competing scope decisions.
- Exception: if the occupied work is nearly complete (PR in review, case nearly done), the domain penalty is reduced.

**Epic momentum (boost related work):**
- Look at the last 5-10 closed issues. Identify topic clusters.
- If recent work established context in an area (e.g., just finished test infrastructure), related issues are cheaper to do now — the mental model is loaded.
- But: if the last 3+ completed issues were all in the same area, momentum becomes tunnel vision. Apply a diversity correction.

**Topic diversity (spread across areas):**
- Identify broad topic clusters from the open backlog:
  - E2E testing & test infrastructure
  - Case isolation & routing
  - Autonomous kaizen & process improvement
  - Technical debt & refactoring
  - Security hardening
  - Work agent UX & ergonomics
  - Deploy & operations
  - Observability & telemetry
- If a cluster has been overworked recently, depress it. If a cluster has been neglected, boost it.
- The goal is not equal distribution — it's avoiding blind spots.

**Priority signals (check these FIRST — they override other scoring):**
- **`priority:critical` label** — Always pick these first. Blocks humans, blocks multiple PRs, or 3+ incidents.
- **`priority:high` label** — Strong boost. Has incidents, unblocks downstream work, or fixes human-visible problems.
- **L3 > L2 > L1** — Mechanistic fixes are more durable than instructions
- **Blocks humans > blocks agents > pure ergonomics** — Human-visible problems are higher priority
- **Has incidents > theoretical** — Issues with concrete past incidents are more valuable than speculative improvements
- **Unblocks other issues > standalone** — Issues that are prerequisites for other work get a boost
- **`needs-dev` label** — Explicitly flagged as needing development work

**Readiness:**
- Issues with clear specs, acceptance criteria, or linked PRDs are easier to start
- Issues that are just a title with no body may need `/write-prd` first
- This doesn't disqualify an issue — it changes the first step (spec vs implement)

**Staleness:**
- Very old issues (months) get a small boost — they've been neglected
- But also: if they've been open for months without anyone caring, maybe they're low value. Use judgment.

### Step 4: Present recommendations

Present the **top 3-5 issues** with:

1. **Issue number and title**
2. **Why this one** — which scoring factors put it at the top (1-2 sentences)
3. **First step** — would this go straight to `/accept-case` → `/implement-spec`, or does it need `/write-prd` first?
4. **Estimated scope** — small (< 1 PR), medium (1-2 PRs), large (needs `/plan-work`)

**Format:**
```
### Top Picks

1. **#N: Title** — [why: momentum from recent X work + unblocks Y]
   First step: /accept-case → /implement-spec | Scope: small

2. **#N: Title** — [why: security cluster neglected, has 3 past incidents]
   First step: /accept-case | Scope: medium

3. **#N: Title** — [why: oldest open issue, clear spec exists]
   First step: /accept-case → /implement-spec | Scope: small
```

Also mention:
- **Topics not represented** in the top picks and why (e.g., "No deploy/ops issues in top 5 — that cluster was recently addressed by #31")
- **Issues that were close** but didn't make the cut, with brief reasons

### Step 5: Handle "no matching issue"

If the user's interest doesn't match any existing kaizen issue:
- Acknowledge the gap: "There's no existing kaizen issue for [topic]. This looks like new work."
- Offer to create one: "Want me to file a kaizen issue for this and proceed to `/accept-case`?"
- If the user agrees, create the issue with `gh issue create` including a clear problem statement, then flow to `/accept-case`

### Step 6: Flow to accept-case

When the user selects an issue:
- Invoke `/accept-case` to evaluate it before implementation
- Pass the issue number and any context gathered during scoring

**Do NOT skip accept-case.** Even if the issue looks obviously good, the evaluation step validates assumptions and finds low-hanging fruit.

## Anti-patterns

- **Picking the "sexiest" issue.** Big architectural initiatives feel important but often have unclear next steps. Smaller, concrete issues often deliver more value per hour.
- **Ignoring the filter step.** Presenting an issue that another agent is actively working on wastes everyone's time.
- **Over-indexing on one factor.** "This is L3 so it must be top priority" — maybe, but if it has no incidents and blocks nothing, it can wait.
- **Presenting more than 5.** Analysis paralysis. The top 3-5 is enough. If the user wants to see more, they'll ask.
- **Skipping the cross-reference.** Checking GitHub labels is not enough — also check the cases database AND worktrees. Labels can be stale; the database is authoritative for active cases; worktrees reveal implicit WIP from other agents.
- **Ignoring domain-level collisions.** "Issue #X isn't claimed" doesn't mean the domain is free. If another agent has 3 worktrees in the hooks area, picking a hooks issue creates friction even if the specific issue isn't claimed.

## Integration

```
/pick-work  →  /accept-case  →  /implement-spec  →  /kaizen
  (select)      (evaluate)       (execute)           (reflect)
```

This skill is the entry point to the dev work skill chain. It replaces ad-hoc browsing of the kaizen backlog with structured, collision-aware selection.
