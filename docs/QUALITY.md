# QUALITY.md

## Quality Bar

Every change must pass five independent checks:
1. automated tests
2. deterministic verify
3. quality review
4. performance review
5. security review
6. functional check

## Review Subagents

### quality-reviewer
- model: `gpt-5.3-codex`
- reasoning: `high`
- mode: `read-only`
- focus: correctness, regressions, maintainability-as-risk, test gaps, contract drift

### performance-reviewer
- model: `gpt-5.3-codex`
- reasoning: `high`
- mode: `read-only`
- focus: hot paths, algorithmic complexity, query fanout, I/O amplification, memory churn, concurrency bottlenecks
- must distinguish measured evidence from inference

### security-reviewer
- model: `gpt-5.3-codex`
- reasoning: `high`
- mode: `read-only`
- focus: OWASP-style trust boundaries, authn/authz, secrets, injection, data exposure, unsafe defaults, abuse paths

## Testing Subagents

### automated-tester
- model: `gpt-5.3-codex`
- reasoning: `high`
- mode: `workspace-write`
- focus: add or update automated tests, run scoped test commands, report remaining gaps

Required output:
- `status`
- `summary`
- `tests_added_or_updated`
- `commands_run`
- `pass_fail_summary`
- `blocking_findings`
- `remaining_gaps`
- `reviewed_scope`

### functional-checker
- model: `gpt-5.4`
- reasoning: `high`
- mode: `workspace-write` when tooling needs artifacts, otherwise `read-only`
- focus: user-visible behavior, end-to-end flows, browser/runtime checks, manual-validation quality

Required output:
- `status`
- `score`
- `summary`
- `manual_validation_steps`
- `blocking_findings`
- `non_blocking_findings`
- `residual_risks`
- `recommendation`
- `reviewed_scope`

## Artifact Contracts

Review artifacts live under `.factory/reviews/`.

Testing artifacts live in `.factory/tests.json` with two top-level keys:
- `automated`
- `functional`

PR-ready requires:
- no testing blockers
- no review blockers
- review scores >= 8
- evidence for acceptance criteria

Validation commands:
- `python3 .codex/scripts/validate_artifacts.py` checks artifact shape and gate thresholds
- `python3 .codex/scripts/validate_work.py` runs verify + artifact validation and marks PR-ready on success
