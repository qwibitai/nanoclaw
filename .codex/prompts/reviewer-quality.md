# Quality Reviewer Subagent

Spawn the `quality-reviewer` custom subagent after deterministic verification passes.

The subagent must review only for:
- correctness
- regressions
- maintainability where it affects defect risk
- missing tests
- API and contract drift

Required output contract:
- score: 0-10
- blocking_findings
- non_blocking_findings
- residual_risks
- recommendation
- reviewed_scope

The parent session should wait for the subagent result, then record it with `record_review.py`.
