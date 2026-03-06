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
| `request_id` | Yes | Coordinator request tracking id, no whitespace, max 64 chars |
| `task_type` | Yes | `analyze`, `implement`, `fix`, `refactor`, `test`, `release`, `research`, `code` |
| `context_intent` | Yes | `fresh` for new context, `continue` for follow-up context |
| `input` | Yes | Exact task objective |
| `repo` | Yes | `owner/repo` format |
| `base_branch` | No | Base branch used for seeding (default `main` when omitted) |
| `branch` | Yes | Must start with `jarvis-` |
| `acceptance_tests` | Yes | Non-empty array of exact verification commands |
| `session_id` | Conditional | Optional explicit session for `continue`; forbidden for `fresh` |
| `parent_run_id` | No | Optional run lineage pointer for follow-up tasks |
| `output_contract.required_fields` | Yes | Must include run completion fields |
| `priority` | No | `low`, `normal`, `high` |

No-screenshot policy:
- Do not request screenshot capture/analysis in `input` or `acceptance_tests`.
- Use text-based browser evidence only (`evaluate_script`, console/network output, curl probes).

## Session Intent Policy

1. Use `context_intent: "continue"` only when follow-up work needs previous context.
2. For continue runs:
   - Either pass explicit `session_id`, or let validator auto-reuse latest session for same worker + repo + branch.
   - Add `session_id` to `output_contract.required_fields`.
3. Use `context_intent: "fresh"` when task is unrelated; do not send `session_id`.
4. Never reuse a `session_id` across different worker lanes (`jarvis-worker-1` vs `jarvis-worker-2`).

## Browser Dispatch Profile (Container Chromium)

For browser-testing tasks, include explicit mode in `input`:

- `browser_required: true` by default for UI-impacting changes.
- `browser_required: false` only when fallback is explicitly approved.
- `browser_assertions: [...]` with task-relevant checks and expected pass criteria.
- `fallback_allowed: false` unless explicitly approved.

When `browser_required: true`, acceptance tests must include:

1. app/server readiness check
2. in-container route probe (`127.0.0.1:<port>`)
3. task-specific `chrome-devtools` MCP assertion(s)
4. no screenshot commands/evidence

If browser tooling prerequisites are missing, worker must return blocker evidence instead of silent fallback.

## Agreement-Sync Dispatch Profile

When Andy accepts a Jarvis workflow/policy agreement, dispatch must include a docs-sync objective.

Required outcome:

1. update affected `groups/jarvis-worker-*/docs/workflow/*`
2. update `groups/jarvis-worker-*/CLAUDE.md` Docs Index trigger lines when retrieval paths changed
3. report changed docs files in completion evidence

## Branch Seeding (Required Before Dispatch)

1. Choose `base_branch` (usually `main`).
2. Create and push remote `jarvis-<feature>` branch from `base_branch`.
3. Dispatch worker with both `base_branch` and `branch`.
4. Worker must switch to dispatched `branch` and commit there.

## Required Completion Fields

`output_contract.required_fields` must include:

- `run_id`
- `branch`
- `commit_sha`
- `files_changed`
- `test_result`
- `risk`
- one of `pr_url` or `pr_skipped_reason`
- plus `session_id` when `context_intent` is `continue`

## Recommended Push Guidance (Lightweight)

For code tasks (`implement`, `fix`, `refactor`, `release`, `code`), prefer:

- include `pr_url` in `output_contract.required_fields`
- include a push/remote check in `acceptance_tests` when practical
- ask worker to return exact blocker evidence if push/PR is blocked

Suggested checks:

- `git push -u origin <branch>`
- `git ls-remote --heads origin <branch>`

## Dispatch Example

Use `mcp__nanoclaw__send_message` with `target_group_jid`:

```json
{
  "target_group_jid": "jarvis-worker-1@nanoclaw",
  "text": "{\"run_id\":\"task-20260222-001\",\"request_id\":\"req-20260302-001\",\"task_type\":\"implement\",\"context_intent\":\"fresh\",\"input\":\"Implement strict dispatch validation for worker runs\",\"repo\":\"openclaw-gurusharan/nanoclaw\",\"base_branch\":\"main\",\"branch\":\"jarvis-dispatch-contract\",\"acceptance_tests\":[\"npm run build\",\"npm test\"],\"output_contract\":{\"required_fields\":[\"run_id\",\"branch\",\"commit_sha\",\"files_changed\",\"test_result\",\"risk\",\"pr_url\"]},\"priority\":\"high\"}"
}
```

## When Dispatch Is Blocked

- Validator blocks are expected guardrails, not worker failures.
- Read the policy reason and resend corrected dispatch from `andy-developer`.
- If policy/rules conflict with requested workflow, escalate that conflict to the user immediately.

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

If no PR is opened, provide `pr_skipped_reason` instead of `pr_url` with a short blocker reason and next step.
For follow-up runs (`context_intent=continue`), completion must include `"session_id": "<current-session-id>"`.

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
