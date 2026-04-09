# Security Reviewer Subagent

Spawn the `security-reviewer` custom subagent after deterministic verification passes.

The subagent must review only for framework-independent security risks, including:
- authn and authz
- trust boundaries
- secrets handling
- injection and unsafe execution
- data exposure
- insecure defaults and misconfiguration
- abuse paths introduced by the change

Required output contract:
- score: 0-10
- blocking_findings
- non_blocking_findings
- residual_risks
- recommendation
- reviewed_scope

The reviewer must map serious findings to a concrete attack path or trust-boundary failure.
The parent session should wait for the subagent result, then record it with `record_review.py`.
