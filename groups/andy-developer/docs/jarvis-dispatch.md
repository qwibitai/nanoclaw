# Jarvis Worker Dispatch

## Available Workers

| Worker | Group JID | Capacity |
|--------|-----------|----------|
| `jarvis-worker-1` | `jarvis-worker-1@nanoclaw` | 1 task at a time |
| `jarvis-worker-2` | `jarvis-worker-2@nanoclaw` | 1 task at a time |

Run tasks in parallel by dispatching distinct `run_id` values to different workers.

## Dispatch Contract (Strict)

Worker tasks MUST be sent as a JSON object string. Plain text dispatch is rejected.

| Field | Required | Notes |
|-------|----------|-------|
| `run_id` | Yes | Canonical run identifier, no whitespace, max 64 chars |
| `task_type` | Yes | `analyze`, `implement`, `fix`, `refactor`, `test`, `release`, `research`, `code` |
| `input` | Yes | Exact task objective |
| `repo` | Yes | `owner/repo` format |
| `branch` | Yes | Must start with `jarvis-` |
| `acceptance_tests` | Yes | Non-empty array of exact verification commands |
| `output_contract.required_fields` | Yes | Must include run completion fields |
| `priority` | No | `low`, `normal`, `high` |

## Browser/WebMCP Dispatch Profile

For browser-testing tasks, include explicit mode in `input`:

- `webmcp_required: true` when task must validate WebMCP behavior.
- `webmcp_required: false` only when fallback is explicitly approved.

When `webmcp_required: true`, acceptance tests must include:

1. app/server readiness check
2. WebMCP registration check (`navigator.modelContext` + tool discovery)
3. task-specific browser assertion

If WebMCP prerequisites are missing, worker must return blocker evidence instead of silent fallback.

## Agreement-Sync Dispatch Profile

When Andy accepts a Jarvis workflow/policy agreement, dispatch must include a docs-sync objective.

Required outcome:

1. update affected `groups/jarvis-worker-*/docs/workflow/*`
2. update `groups/jarvis-worker-*/CLAUDE.md` Docs Index trigger lines when retrieval paths changed
3. report changed docs files in completion evidence

## Required Completion Fields

`output_contract.required_fields` must include:

- `run_id`
- `branch`
- `commit_sha`
- `files_changed`
- `test_result`
- `risk`
- one of `pr_url` or `pr_skipped_reason`

## Dispatch Example

Use `mcp__nanoclaw__send_message`:

```json
{
  "chat_jid": "jarvis-worker-1@nanoclaw",
  "message": "{\"run_id\":\"task-20260222-001\",\"task_type\":\"implement\",\"input\":\"Implement strict dispatch validation for worker runs\",\"repo\":\"openclaw-gurusharan/nanoclaw\",\"branch\":\"jarvis-dispatch-contract\",\"acceptance_tests\":[\"npm run build\",\"npm test\"],\"output_contract\":{\"required_fields\":[\"run_id\",\"branch\",\"commit_sha\",\"files_changed\",\"test_result\",\"risk\",\"pr_url\"]},\"priority\":\"high\"}"
}
```

## Completion Contract

Workers must end code/fix/refactor/implement tasks with:

```text
<completion>
{
  "run_id": "task-20260222-001",
  "branch": "jarvis-dispatch-contract",
  "commit_sha": "abc1234",
  "files_changed": ["src/dispatch-validator.ts", "src/index.ts"],
  "test_result": "npm run build && npm test passed",
  "risk": "low - isolated to worker dispatch path",
  "pr_url": "https://github.com/..."
}
</completion>
```

If no PR is opened, provide `pr_skipped_reason` instead of `pr_url`.

## Run State Machine

```text
queued -> running -> review_requested
               -> failed_contract
               -> failed
```

| Status | Meaning |
|--------|---------|
| `queued` | Accepted and waiting |
| `running` | Container started |
| `review_requested` | Completion contract satisfied |
| `failed_contract` | Missing/invalid completion fields |
| `failed` | Runtime/container failure |
| `done` | Review approved |

## Retry Semantics

Re-send the same `run_id` only when status is `failed` or `failed_contract`.
