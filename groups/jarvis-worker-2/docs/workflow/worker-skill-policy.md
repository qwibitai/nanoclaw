# Worker Skill Policy

Default operating policy for Jarvis workers.

## Modes

| Mode | Default | Use When |
|------|---------|----------|
| Task mode | Yes | Standard Andy-Developer dispatch (`run_id` task) |
| Autonomous lifecycle mode | No | Explicit request to bootstrap/run full INIT->IMPLEMENT->TEST cycle |

Task mode is the normal path. Do not enter autonomous lifecycle mode unless the instruction explicitly asks for it.

## Upstream Roles

- `Andy-bot`: observation/research lane (including GitHub research context).
- `Andy-developer`: only dispatcher/reviewer lane for worker tasks.

Worker tasks must come from Andy-developer dispatch contract, not direct Andy-bot control.

## Task Mode: Required Steps

1. Parse task contract (`run_id`, objective, repo, branch, scope, verification).
2. Select only required skills from the routing table below.
3. Execute in bounded scope.
4. Run required verification commands.
5. For Andy-approved workflow/policy agreements, run `/workspace/group/docs/workflow/agreement-sync.md`.
6. Return the completion contract.

## Skill Routing (Task Mode)

| Task Type | Primary Skills | Optional Skills |
|-----------|----------------|-----------------|
| `code` / `fix` / `refactor` | `implementation`, `testing` | `token-efficient`, `react-best-practices` |
| `test` | `testing` | `browser-testing`, `agent-browser` |
| `research` | `research-evaluator` | `token-efficient` |
| `parallel` | `worktree-orchestrator` | `testing`, `react-best-practices` |
| `ui-browser` | `browser-testing` | `agent-browser` |

For `test` and `ui-browser` tasks, apply `/workspace/group/docs/workflow/webmcp-testing.md` first.

## Skills Available But Not Default

These are available, but must be explicitly requested by task context:

- `initialization`
- `orchestrator`
- `global-hook-setup`
- `project-hook-setup`
- `context-graph`
- `testing-tracker`
- `mcp-setup`

Rationale: they are powerful lifecycle/setup skills and can create broad changes if used by default.

## Skills Usually Out Of Scope For Coding Runs

Use only when explicitly requested:

- `claude-md-creator`
- `pdf`
- `pptx`
- `xlsx`
- `tufte-slide-design`

## Completion Contract (Mandatory)

Every non-trivial task must end with:

```xml
<completion>
{
  "run_id": "...",
  "branch": "jarvis-<feature>",
  "commit_sha": "...",
  "files_changed": ["path/a", "path/b"],
  "test_result": "...",
  "pr_url": "https://github.com/...",
  "pr_skipped_reason": null,
  "risk": "low|medium|high",
  "blockers": []
}
</completion>
```

Use `pr_skipped_reason` when no PR is opened.

## Safety Rules

- Keep changes inside declared scope paths.
- Use same `run_id` for rework on the same logical task.
- Escalate to Andy-Developer instead of guessing when requirements are ambiguous.
- Prefer deterministic verification over prose claims.
- Do not silently downgrade WebMCP-required tasks to DOM scraping.
