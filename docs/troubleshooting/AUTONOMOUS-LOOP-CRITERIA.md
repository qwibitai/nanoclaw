# Autonomous Loop Criteria

Template for evaluating whether a workflow failure should become autonomous.

## Decision Matrix

| Parameter | Description | Score (1-5) | Weight |
|-----------|-------------|--------------|--------|
| **Frequency** | How often does this failure occur? | 1=rare, 5=daily | x2 |
| **Determinism** | Is the fix always the same? | 1=varies, 5=same | x3 |
| **Cost of Failure** | Blast radius when it fails | 1=local, 5=remote | x2 |
| **Repeatability** | Same failure across users? | 1=unique, 5=common | x1 |
| **Reversibility** | Easy to undo if wrong? | 1=hard, 5=easy | x1 |

**Total Score = (Frequency × 2) + (Determinism × 3) + (Cost × 2) + (Repeatability × 1) + (Reversibility × 1)**

| Score | Action |
|-------|--------|
| **≥15** | ✅ Auto-fix - implement autonomous handler |
| **10-14** | ⚠️ Partial autonomy - auto-detect, manual fix |
| **<10** | ❌ Keep manual - requires human judgment |

## Required Properties for Autonomy

All must be true:

- [ ] **Deterministic fix** - Same input always produces same output
- [ ] **Safe** - Cannot break production, delete data, or cause data loss
- [ ] **Reversible** - Easy to undo if fix is incorrect
- [ ] **Observable** - Can verify success/failure programmatically
- [ ] **No judgment needed** - Doesn't require understanding context

## Evaluation Questions

Before creating an autonomous handler, answer:

1. Does the fix always work the same way?
2. What happens if the fix is wrong?
3. Can we detect if it worked?
4. Does it need human judgment?
5. Is the failure mode consistent across users/sessions?

## Handler Template

For each autonomous handler, document:

```markdown
### [Failure Type]

**Trigger**: [What causes this - CI check name, error message, etc.]
**Score**: [Total from matrix above]

**Auto-fix**:
```bash
[Commands to fix]
```

**Verification**: [How to confirm fix worked]

**Rollback**: [If wrong, how to undo]

**Fallback**: [If fix fails → notify user with message]

**Test cases**:

- [ ] Test 1
- [ ] Test 2

```

## Current Scorecard

| Failure Type | Freq | Det | Cost | Rep | Rev | Total | Status |
|-------------|------|-----|------|-----|-----|-------|--------|
| Format fail | 5 | 5 | 3 | 5 | 5 | 36 | ✅ Auto |
| Tooling budget | 3 | 4 | 3 | 4 | 4 | 31 | ✅ Auto |
| PR body missing | 4 | 4 | 3 | 3 | 3 | 28 | ✅ Auto |
| Pre-push format | 5 | 5 | 1 | 5 | 5 | 34 | ✅ Auto |
| Conflict resolve | 3 | 1 | 5 | 2 | 1 | 16 | ❌ Manual |
| Review ack (trivial) | 4 | 3 | 2 | 3 | 4 | 27 | ⚠️ Partial |

## Usage

### Trigger 1: CI Failure

When CI fails or workflow requires intervention:

1. **Diagnose** the failure type
2. **Score** using the matrix above
3. **Decide** → Auto-fix / Partial / Manual
4. **Implement** → Add handler to relevant skill
5. **Test** → Verify it works
6. **Document** → Add to scorecard

### Trigger 2: Session Recall (Proactive)

During session introspection (end of session), evaluate workflow friction:

1. **Identify** friction points from the session
2. **Score** each friction using the matrix
3. **Flag** any with score ≥15 as automation candidates
4. **Log** to `docs/troubleshooting/AUTONOMOUS-LOOP-CANDIDATES.md` for tracking
5. **Review** candidates in next session or weekly review

**Why session recall?**
- Fresh context - session friction is still in memory
- Quantifiable - count frequency from session alone
- Cumulative - multiple sessions with same issue = higher frequency score
- Creates continuous improvement loop

## Candidate Log

Store automation candidates discovered during session recall:

```markdown
### [Friction Description]

**Session**: [date/session-ref]
**Trigger**: Session recall
**Score**: [total]
**Proposed Handler**: [what the autonomous fix would do]

- [ ] Reviewed
- [ ] Implemented
- [ ] Rejected (reason: )
```

## Haiku Subagent Implementation Pattern

For autonomous handlers that run in background, use Haiku subagents for cost efficiency:

### Pattern: Parallel Monitoring + Auto-Fix

```markdown
## [Monitor Name] Haiku

**Trigger**: Score ≥15 autonomous handler

**Implementation**:
agent:Haiku
description: [What this monitors]
prompt: |
  Monitor [target] every [interval].
  Use: [command to check]
  If [failure condition]:
    - [auto-fix command]
    - [report action]
  If [success condition]: report [status]
  Stop when [stop condition].
model: haiku
run_in_background: true
```

### Smart Spawning Logic

Decide when to spawn vs skip:

```bash
# Check if parallel monitoring is worthwhile
file_count=$(git diff --name-only HEAD~1 | wc -l)
if [ "$file_count" -gt [THRESHOLD] ]; then
  # Spawn parallel Haiku agents
else
  # Skip, run sequential
fi
```

### When to Kill

- PR merged → kill all monitors
- Any critical failure → kill others, keep fixing
- User requests stop → kill all
- Blocked (conflict) → keep conflict monitor, kill others

### Cost Efficiency

- Haiku: ~68K tokens/tick
- Use for: monitoring loops, periodic checks
- Don't use for: one-off commands (use direct execution)
