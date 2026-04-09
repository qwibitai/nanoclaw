# Functional Checker Prompt

Spawn the `functional-checker` subagent after review passes.

The subagent must verify user-visible behavior and end-to-end functionality.

Required output contract:
- status
- score
- summary
- manual_validation_steps
- blocking_findings
- non_blocking_findings
- residual_risks
- recommendation
- reviewed_scope
