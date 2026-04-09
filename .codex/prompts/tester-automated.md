# Automated Tester Prompt

Spawn the `automated-tester` subagent after implementation and before deterministic verify.

The subagent must:
- add or update automated tests for the changed behavior
- run scoped test commands
- report remaining coverage gaps honestly

Required output contract:
- status
- summary
- tests_added_or_updated
- commands_run
- pass_fail_summary
- blocking_findings
- remaining_gaps
- reviewed_scope
