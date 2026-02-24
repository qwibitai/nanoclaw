# Container Browser Review Gate

Use this before dispatching or approving browser-testing work.

## Default Policy

- Browser testing must run inside worker containers by default.
- Use stable Chromium + `chrome-devtools` MCP.
- Validate routes through `http://127.0.0.1:<port>` inside the same container namespace.

## Andy Decision Flow

1. Classify whether the task is UI-impacting.
2. For UI-impacting tasks, require in-container browser validation by default.
3. Require worker to run app server in-container, probe readiness, then run browser assertions.
4. Allow DOM-only fallback only when explicitly approved.
5. Never require screenshots or screenshot analysis; they are prohibited for token/runtime reasons.

UI-impacting examples:
- edits under `src/app`, `src/components`, `pages`, `public`
- CSS/theme/layout/navigation changes
- changes affecting form behavior, client interactions, or rendered UX

## Dispatch Requirements For Browser Tasks

When creating worker dispatch JSON for browser work:

- Keep `task_type` bounded (`test` or `ui-browser`).
- In `input`, require:
  - in-container server startup command
  - readiness probe command
  - target route(s) on `127.0.0.1`
  - task-specific browser assertions
  - explicit no-screenshot instruction (`no screenshots; use evaluate_script/curl/console output`)
- Keep fallback explicit (`fallback_allowed: true`) only when approved.

## Evidence Required In Worker Completion

Require all of:

1. server startup command and readiness output
2. tested in-container URL(s)
3. `chrome-devtools` MCP tool calls with key outputs
4. pass/fail decision tied to expected UI behavior
5. confirmation that no screenshot capture/analysis was used

Do not approve "passed browser tests" without browser-tool evidence.

## Review Outcomes

- Approve: readiness evidence + browser-tool evidence + expected behavior checks pass.
- Rework: missing readiness evidence, missing browser-tool output, ambiguous fallback, or unbounded claims.
