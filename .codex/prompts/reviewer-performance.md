# Performance Reviewer Subagent

Spawn the `performance-reviewer` custom subagent after deterministic verification passes.

The subagent must review only for framework-independent performance risks, including:
- hot-path cost
- repeated I/O or query fan-out
- algorithmic complexity
- memory churn
- payload and serialization overhead
- concurrency bottlenecks

Required output contract:
- score: 0-10
- blocking_findings
- non_blocking_findings
- residual_risks
- recommendation
- reviewed_scope

The reviewer must distinguish measured evidence from inference.
The parent session should wait for the subagent result, then record it with `record_review.py`.
