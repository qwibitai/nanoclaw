# Container Browser Testing

Default browser-testing gate for UI-impacting work.

Run browser validation inside the same container where the app server is started.
Do not rely on host-browser checks for worker completion.

## Default Trigger (Mandatory)

Run this workflow by default when any of the following are true:

- dispatched `task_type` is `ui-browser` or `test`
- dispatch/input includes `browser_required: true`
- task changes UI paths (`src/app`, `src/components`, `pages`, `public`, `*.css`, layout/theme/navigation code)

If trigger conditions are met, do not skip browser validation.

## Runtime Requirements

1. In-container Chromium runtime at `/usr/bin/chromium`
2. `chrome-devtools` MCP available
3. App server running and reachable on `127.0.0.1` route(s) inside the container
4. Browser session started only after readiness probe passes

## Server Requirement

Before browser checks:

1. Start server (`npm run dev` or project equivalent) in background
2. Probe readiness (`curl -f http://127.0.0.1:<port>/<route>`)
3. Keep server running during tool execution
4. Stop server process before completion output

## Browser Assertion Execution (Mandatory)

Run at least one task-relevant `chrome-devtools` MCP action after readiness:

- navigate to target route
- verify expected UI state
- inspect console/network if task requires it

Use task-specific assertions, not generic smoke-only checks.

## Evidence Required In Completion

Include a compact browser evidence block with:

1. server start command + readiness probe result
2. route(s) tested (127.0.0.1 URL)
3. `chrome-devtools` tool calls executed (name + key output)
4. pass/fail decision tied to expected behavior

No "browser pass" claims without MCP tool execution evidence.

## Fallback Policy

If browser runtime/tooling is unavailable:

1. report exact blocker with command output
2. do not mark browser checks as passed
3. escalate to Andy-Developer for rework/unblock
