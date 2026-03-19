# Horizons — Maturity Dimensions for NanoClaw

*"Map the territory before you move through it."*

A **horizon** is a dimension of quality that's an infinite game — you never "solve" it, you just get better. Each horizon has a taxonomy (L0→L6+), a "You Are Here" marker, and progressive detail: dense for the current level, sketched for the next, open beyond that.

**Enforcement (L1→L2→L3) is not a horizon** — it's a cross-cutting framework that applies within every horizon. Each horizon has both a capability level (its own taxonomy) and an enforcement level (how reliably that capability is guaranteed).

For the full framework design, see [`docs/horizons-framework-spec.md`](../horizons-framework-spec.md).

## Active Horizons

### Process (how the system works on itself)

| # | Horizon | Current | Next Step | Doc |
|---|---------|---------|-----------|-----|
| 1 | **Autonomous Kaizen** | L3-4 (enforced + actionable reflection) | L5 meta-reflection enforcement | [kaizen.md](kaizen.md) |
| 2 | **Incident-Driven Kaizen** | L0→L1 (manual recording) | L2 search-before-file enforcement | [incident-driven-kaizen.md](incident-driven-kaizen.md) |

### Quality (how well the output is)

| # | Horizon | Current | Next Step | Doc |
|---|---------|---------|-----------|-----|
| 3 | **Testability** | L0-5 solid, L6+ gap | L6 host pipeline smoke | [test-ladder-spec.md](../test-ladder-spec.md) |
| 4 | **Observability** | L1 (output logs) | L2 structured telemetry | [observability.md](observability.md) |
| 5 | **State Integrity** | L1 (collision detection) | L2 freshness guarantees | [state-integrity.md](state-integrity.md) |

### Operational (how the system stays healthy)

| # | Horizon | Current | Next Step | Doc |
|---|---------|---------|-----------|-----|
| 6 | **Resilience** | L1 (failure detection) | L2 state preservation | [resilience.md](resilience.md) |
| 7 | **Cost Governance** | L1 (tracking) | L2 per-case budgets | [cost-governance.md](cost-governance.md) |
| 8 | **Worktree-First Infrastructure** | L0→L1 (ad-hoc fixes) | L2 shared `git-paths.ts` resolver | [worktree-first-infrastructure.md](worktree-first-infrastructure.md) |

### Trust (who can do what, who sees what)

| # | Horizon | Current | Next Step | Doc |
|---|---------|---------|-----------|-----|
| 9 | **Security** | L1-2 (least privilege + credential proxy) | L3 input sanitization | [security.md](security.md) |
| 10 | **Human-Agent Interface** | L0 (raw output) | L1 plain-language summaries | [human-agent-interface.md](human-agent-interface.md) |

### Platform (how the system grows)

| # | Horizon | Current | Next Step | Doc |
|---|---------|---------|-----------|-----|
| 11 | **Extensibility** | L1-2 (documented extension points) | L3 validated integration | [extensibility.md](extensibility.md) |

## Dormant Horizons

| # | Horizon | Activation Signal | Doc |
|---|---------|-------------------|-----|
| 12 | **Scalability** | 3+ active verticals | [scalability.md](scalability.md) |

## Meta

| # | Horizon | Current | Doc |
|---|---------|---------|-----|
| meta | **Horizon Completeness** | L0→L1 (this index) | [horizon-completeness.md](horizon-completeness.md) |

## Horizon Discovery Tower

How horizons themselves are discovered and maintained. Three levels, self-referential at the top.

**Level A — Move along known horizons** (every reflection)
: For each impediment, ask: "which horizon does this touch? Where are we on that horizon? Should we move up?"

**Level B — Discover new horizons** (every reflection, one question)
: "Does this friction reveal a quality dimension not in our horizons? If yes, file a horizon-discovery kaizen issue."

**Level C — Review the horizon set** (periodic, every ~10 cases)
: "Are there issue clusters that don't map to any horizon? Is any horizon stale? Should two merge?"

There is no Level D. Level C reviews Level B's output. Level B reviews Level A's coverage. The recursion terminates because all levels produce the same artifacts: horizon documents and kaizen issues.

## Relationship Map

```
Observability → feeds → Incident-Driven Kaizen → feeds → Autonomous Kaizen
                                                              │
                                              drives improvement across all
                                                              │
            ┌────────────┬──────────────┬─────────────────────┤
            ▼            ▼              ▼                     ▼
       Testability   Security    Cost Governance         Resilience
                         │                                    ▲
                         ▼                                    │
                    Extensibility                    State Integrity

Human-Agent Interface → gates → Autonomous Kaizen L7 (auto-merge needs trust)
Worktree-First Infra  → prerequisite → Autonomous Kaizen L6+ (agents always in worktrees)
Horizon Completeness  → discovers → new horizons across all categories
```
