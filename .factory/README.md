# Factory Runtime State

This directory stores machine-readable state for one active implementation run.

Artifacts:
- `run.json` — phase and status summary
- `decomposition.json` — planner-owned task graph
- `verify.json` — deterministic verify output
- `tests.json` — automated and functional testing artifacts
- `reviews/*.json` — quality, performance, and security review artifacts
- `validation-report.json` — combined output from `python3 .codex/scripts/validate_work.py`
