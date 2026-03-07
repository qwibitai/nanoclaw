# NanoClaw Jarvis Dispatch Contract

Canonical contract for `jarvis-worker-*` dispatch and completion validation.

## Dispatch Requirements

Worker dispatch must be a JSON object (plain text is rejected).
Screenshot capture/analysis is prohibited in worker dispatch and completion evidence.

```json
{
  "run_id": "task-20260222-001",
  "request_id": "req-20260302-001",
  "task_type": "implement",
  "context_intent": "fresh",
  "ui_impacting": true,
  "input": "Implement strict worker dispatch validation",
  "repo": "openclaw-gurusharan/nanoclaw",
  "base_branch": "main",
  "branch": "jarvis-dispatch-contract",
  "acceptance_tests": [
    "npm run build",
    "npm test"
  ],
  "output_contract": {
    "browser_evidence_required": true,
    "required_fields": [
      "run_id",
      "branch",
      "commit_sha",
      "files_changed",
      "test_result",
      "risk",
      "pr_url",
      "browser_evidence"
    ]
  },
  "parent_run_id": "task-20260221-009",
  "priority": "high"
}
```

## Field Rules

| Field | Rule |
|-------|------|
| `run_id` | required, max 64 chars, no whitespace |
| `request_id` | required tracking id, max 64 chars, no whitespace |
| `task_type` | one of `analyze`, `implement`, `fix`, `refactor`, `test`, `release`, `research`, `code` |
| `context_intent` | required; `fresh` (new context) or `continue` (resume related context) |
| `input` | required non-empty string |
| `repo` | required in `owner/repo` format |
| `base_branch` | optional branch name used for branch seeding |
| `branch` | required and must match `jarvis-<feature>` |
| `acceptance_tests` | required non-empty string array |
| `input` + `acceptance_tests` | must not request screenshot capture/analysis; use text-based browser assertions |
| `ui_impacting` | optional boolean; when true browser evidence is required |
| `session_id` | optional for explicit continuation targeting; must be omitted when `context_intent=fresh` |
| `parent_run_id` | optional lineage link to previous related run |
| `output_contract.required_fields` | required non-empty array containing completion fields |
| `output_contract.browser_evidence_required` | optional boolean override for browser evidence requirement |

### Session Continuity Rules

- `context_intent=fresh`: dispatch must not include `session_id`; runner starts a fresh session.
- `context_intent=continue`:
  - dispatch may include explicit `session_id`, or rely on auto-selection from latest successful run for same worker + repo + branch.
  - `output_contract.required_fields` must include `session_id`.
  - cross-worker explicit `session_id` reuse is blocked by validator.

## Branch Seeding Rule

Before dispatching worker execution:

1. `andy-developer` selects `base_branch` (default `main`).
2. `andy-developer` pre-creates and pushes remote `jarvis-<feature>` branch.
3. worker is dispatched to that pre-seeded `branch` and must commit there.

## Completion Requirements

Worker output must include a completion block:

```text
<completion>
{
  "run_id": "task-20260222-001",
  "branch": "jarvis-dispatch-contract",
  "commit_sha": "abc1234",
  "files_changed": ["src/index.ts", "src/dispatch-validator.ts"],
  "test_result": "npm run build && npm test passed",
  "risk": "low - isolated to worker dispatch path",
  "pr_url": "https://github.com/...",
  "browser_evidence": {
    "base_url": "http://127.0.0.1:3000/dashboard",
    "tools_listed": ["chrome-devtools"],
    "execute_tool_evidence": [
      "listTools -> chrome-devtools present",
      "executeTool navigate /dashboard -> sidebar rendered"
    ]
  }
}
</completion>
```

`pr_skipped_reason` may be used instead of `pr_url`.
When dispatch requires session continuity (`context_intent=continue`), completion must include `"session_id": "<current-session-id>"`.

## Push/PR Guidance (Non-Blocking)

To keep workflow flexible but reliable:

- For code tasks (`implement`, `fix`, `refactor`, `release`, `code`), prefer returning `pr_url`.
- Use `pr_skipped_reason` for no-code runs or clear push/PR blockers.
- When practical, include lightweight remote confirmation in acceptance tests:
  - `git push -u origin <branch>`
  - `git ls-remote --heads origin <branch>`

### `commit_sha` Expectations

- Default rule: `commit_sha` must be a real git SHA (6-40 hex chars) from the worker branch used for the run.
- Placeholder values (`n/a`, `none`) are accepted only for no-code operational runs with `run_id` prefix:
  - `ping-`
  - `smoke-`
  - `health-`
  - `sync-`
- For all feature/fix/implement tasks, placeholder commit values must fail contract validation.

## Validation Gates

A worker run transitions to `review_requested` only when:

1. completion block is parseable JSON
2. completion includes all required artifacts
3. completion `run_id` matches dispatch `run_id`
4. completion `branch` matches dispatch `branch`
5. when required by dispatch fields, completion includes valid `session_id`
6. when browser evidence is required, completion includes valid `browser_evidence`:
   - `base_url` must be `http(s)://127.0.0.1:<port>/...`
   - `tools_listed` must be non-empty
   - `execute_tool_evidence` must be non-empty
   - `execute_tool_evidence` must not reference screenshot capture/analysis

Otherwise the run transitions to `failed_contract`.

If dispatch is blocked before run creation, classify it as policy-blocked dispatch (lane/rule violation), not worker runtime failure.

## Retry Semantics

| Existing status for `run_id` | Behavior |
|------------------------------|----------|
| `failed` | retry allowed, `retry_count` incremented |
| `failed_contract` | retry allowed, `retry_count` incremented |
| `running` | duplicate blocked |
| `review_requested` | duplicate blocked |
| `done` | duplicate blocked |

After a run reaches `review_requested`, follow-up rework must use a new child `run_id` with the same `request_id` and `parent_run_id` set to the reviewed run. Do not reuse the reviewed `run_id`.

## Review Ownership

Accepted worker completion now triggers deterministic Andy review ownership:

1. host marks the linked `andy_request` as `worker_review_requested`
2. host injects a synthetic `<review_request>` message into `andy-developer`
3. Andy must choose one outcome:
   - approve
   - bounded direct patch on the same worker branch
   - rework dispatch to Jarvis with a new child `run_id`

When Andy changes review state, it emits hidden `<review_state_update>` blocks so the host can persist:

- `review_in_progress`
- `andy_patch_in_progress`
- `completed`
- `failed`

## Agent Routing

| Step | Agent | Mode | Notes |
|------|-------|------|-------|
| Field change decisions | opus | — | Requires contract design judgment |
| Build + test | verifier | fg | `npm run build && npm test` |
| Contract lint | verifier | fg | `bash scripts/check-workflow-contracts.sh` |
| Schema validation | verifier | fg | Dispatch/completion field checks |
