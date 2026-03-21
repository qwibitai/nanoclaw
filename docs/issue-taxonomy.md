# Issue Taxonomy & Epic Lifecycle

*"A good taxonomy of the problem outlasts any solution."*

This document defines how kaizen issues are labeled, how epics are managed, and when to update issue bodies vs add comments. It is the authoritative reference for issue hygiene in the [Garsson-io/kaizen](https://github.com/Garsson-io/kaizen) repo.

## Required Labels

Every issue MUST have at minimum three labels:

| Category | Required? | Labels | Purpose |
|----------|-----------|--------|---------|
| **Type** | Yes | `kaizen`, `bug`, `enhancement`, `documentation` | What kind of issue |
| **Level** | Yes | `level-1`, `level-2`, `level-2.5`, `level-3` | Fix enforcement level |
| **Area** | Yes | `area/hooks`, `area/skills`, `area/cases`, `area/deploy`, `area/testing`, `area/container`, `area/worktree` | Which subsystem |
| **Horizon** | Recommended | `horizon/autonomous-kaizen`, `horizon/incident-kaizen`, `horizon/testability`, `horizon/deployment`, `horizon/observability`, `horizon/state-integrity`, `horizon/resilience`, `horizon/cost-governance`, `horizon/worktree-infra`, `horizon/security`, `horizon/human-agent-interface`, `horizon/extensibility` | Which maturity dimension |
| **Status** | Auto-synced | `status:active`, `status:done`, `status:has-pr`, `status:backlog`, `status:blocked`, `status:suggested` | Lifecycle state (managed by case backend) |
| **Structure** | When applicable | `epic`, `prd` | Multi-phase initiatives or specs |
| **Case type** | Auto-synced | `type:dev`, `type:work` | Set by case backend |
| **Priority** | When applicable | `priority:critical`, `priority:high` | Urgency signal for `/pick-work` and `/make-a-dent` |

**Priority labels** — Use when urgency matters beyond the standard level/area scoring:
- `priority:critical` — Blocks humans, blocks multiple PRs, or 3+ incidents. `/pick-work` surfaces these first.
- `priority:high` — Has 1-2 incidents, unblocks downstream work, or fixes human-visible problems.
- Issues without a priority label default to normal priority. No `priority:medium` or `priority:low` label needed.

**Filing rule:** If you create an issue without `kaizen` + level + area, you're making it invisible to `/pick-work` and `/gap-analysis`.

## Issue Title Convention

```
[L{level}] Brief description
```

Examples:
- `[L2] check-dirty-files.sh checks CWD not push target`
- `[L1] Agents must display URLs when filing kaizen issues`
- `[Horizon] Deployment Automation — track deploy maturity L0-L5`
- `[Spec] Session-based dev agents with clone-inside-container`
- `[Epic] Issue taxonomy enforcement — required labels, epic lifecycle`

## Epic Lifecycle

### Epics are directions, not deliverables

An epic tracks a **direction** — a multi-phase initiative or horizon progression. It stays open until the direction is fully realized or explicitly abandoned.

A **spec issue** (tagged `prd` or titled `[Spec]`) tracks a specific deliverable. It closes when the deliverable ships.

| Issue type | When to close | Example |
|-----------|---------------|---------|
| Epic / Horizon tracker | Direction achieved (all levels reached) or abandoned | `[Horizon] Incident-Driven Kaizen` — open until L4+ |
| Spec / PRD | Deliverable shipped (doc written, code merged) | `PRD: Hook language boundaries` — closed when spec done |
| Bug / Feature | Fix merged and verified | `[L2] check-dirty-files false positive` |

**Anti-pattern:** Closing an epic when its first deliverable ships. The deliverable is Phase 1 — the epic tracks Phases 1 through N.

### Epic body structure

Epic bodies are living documents. They should always reflect current truth.

```markdown
## Problem
[Why this direction matters — concrete evidence, not abstract]

## Current State
**Level:** L{N} — {description}
**Next step:** {concrete, actionable next move}

## Progress
- [x] #124 — Horizon taxonomy + L1 spec (closed 2026-03-19)
- [ ] #NNN — L2 search-before-file enforcement
- [ ] (not filed) — L3 structured incidents + auto-labels

## Related Issues
- #NNN — description
- #NNN — description

## Last Updated: YYYY-MM-DD
```

### Horizon tracker epics

Each active horizon should have exactly one open epic that tracks its progression. The horizon doc (`docs/horizons/X.md`) is the taxonomy and design; the epic issue is the living tracker with a progress checklist.

## Body vs Comment Convention

The body is **current truth**. Comments are the **audit trail**.

| Action | Where | Why |
|--------|-------|-----|
| Update progress (check off sub-issue) | Body | Body = current state |
| Record an incident | Comment | Incidents are timestamped events |
| Change scope or direction | Body + comment explaining why | Body stays current; comment explains the delta |
| Note a related discovery | Comment | Doesn't change the current plan |
| Link a new sub-issue | Body (add to checklist) | Body = current list of work |
| Record a decision | Comment | Body is what was decided; comment is when and why |
| Update current level assessment | Body | Body = where we are now |

**Rule of thumb:** If you want to know "where are we now?" — read the body. If you want to know "how did we get here?" — read the comments.

## Incident Recording

When an agent encounters friction that matches an existing open issue, it MUST record an incident comment — not file a new issue.

### Incident format

```markdown
## Incident (YYYY-MM-DD)
**PR/Context:** #NNN or description
**Impact:** [time wasted | blocked | wrong output | human notified]
**Details:** What happened, what agent was doing, how resolved
```

### Why incidents matter

- **Prioritization:** `/pick-work` can weight issues by incident count and recency
- **Level escalation:** 3+ incidents at L1 is a signal to escalate to L2
- **Duplicate prevention:** Adding to an existing issue is more valuable than filing a new one
- **Pattern detection:** Incident clusters reveal root cause categories

### Filing flow

```
Encountered friction?
  |
  v
Search existing issues: gh issue list --repo Garsson-io/kaizen --search "<keywords>"
  |
  v
Match found? ──YES──> Add incident comment to existing issue
  |
  NO
  |
  v
File new issue with required labels (kaizen + level + area)
```

## Zen Labels

The `zen:*` labels (e.g., `zen:enforcement-point`, `zen:no-promises-without-mechanisms`) connect issues to philosophical principles from the [Zen of Kaizen](../.claude/kaizen/zen.md). They are optional — apply them when the connection is clear and useful for pattern queries.

## Related

- [Horizons README](horizons/README.md) — maturity dimensions index
- [Kaizen Skill](../.claude/skills/kaizen/SKILL.md) — reflection engine
- [kAIzen README](../.claude/kaizen/README.md) — enforcement system
- [Incident-Driven Kaizen horizon](horizons/incident-driven-kaizen.md) — incident recording taxonomy
