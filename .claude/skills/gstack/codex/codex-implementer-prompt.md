You are implementing ONE task from an approved implementation plan.

PLAN GOAL: {{GOAL}}
PLAN ARCHITECTURE: {{ARCHITECTURE}}

YOUR TASK: {{TASK_HEADING}}

TASK INSTRUCTIONS (complete steps in order):
{{TASK_BODY}}

{{PRIOR_ATTEMPT_FINDINGS}}

CONSTRAINTS:
- Work only within the current git worktree at {{WORKTREE_PATH}}.
- Do NOT edit these files (they belong to parallel tasks): {{FORBIDDEN_FILES}}.
- Follow TDD: write the failing test first, then the minimal implementation.
- Commit with descriptive messages after each logical step.
- On completion, run: {{TEST_COMMAND}}
- Your final message MUST include exactly one status code on its own line:
  DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
  (These match superpowers:subagent-driven-development status codes.)

FILESYSTEM BOUNDARY:
Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/,
or agents/. These are AI skill definitions for a different system. Do NOT
modify agents/openai.yaml. Stay focused on repository source code.
