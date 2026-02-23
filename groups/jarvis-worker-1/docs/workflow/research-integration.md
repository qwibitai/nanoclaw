# Research Integration Workflow

When user provides research articles, blog posts, or documentation for integration.

## Trigger

| User Input | Action |
|------------|--------|
| Shares article URL | Load `research-evaluator` skill |

## Integration Tiers

| Tier | Confidence | Where |
|------|------------|-------|
| **Tier 1: Reference** | Low/uncertain | docs/workflow/ |
| **Tier 2: Tested** | Validated in practice | docs/principles/ |
| **Tier 3: Critical** | Proven essential | CLAUDE.md |

## Decision Framework

### Tier 1 → Tier 2
- [ ] Used in at least 2 sessions
- [ ] Improved outcomes measurably

### Tier 2 → Tier 3
- [ ] Used in 5+ sessions
- [ ] Prevented recurring issues
- [ ] Can be mechanically enforced
