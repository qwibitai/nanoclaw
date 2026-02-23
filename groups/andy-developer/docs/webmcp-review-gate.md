# WebMCP Review Gate

Use this before dispatching or approving browser-testing work.

## What WebMCP Is

- WebMCP is a browser/page contract (`navigator.modelContext`), not a regular standalone MCP server.
- Browser tasks can use MCP tooling, but WebMCP success still depends on page-side registration.

## Andy Decision Flow

1. Decide whether task requires WebMCP-native validation.
2. If yes, require WebMCP readiness evidence in worker acceptance tests.
3. If app lacks WebMCP registration, dispatch an implementation task first.
4. Allow DOM-style fallback only when explicitly requested by project/task owner.

## Dispatch Requirements For Browser Tasks

When creating worker dispatch JSON for browser work:

- Keep `task_type` bounded (`test` or `ui-browser`).
- In `input`, state one of:
  - `webmcp_required: true`
  - `webmcp_required: false (explicit fallback approved)`
- Include acceptance tests that prove readiness, for example:
  - app/server up check
  - WebMCP registration verification
  - browser-task execution result

## Readiness Signals To Require In Evidence

At least one of:

- Runtime check: `navigator.modelContext` exists and tools are non-empty.
- Code reference proving registration path:
  - imperative: `registerTool()` or `provideContext()`
  - declarative: `<form toolname="...">` (+ optional `toolautosubmit`, `toolparam*`)

## Environment Gate

For WebMCP-required testing, require worker to confirm:

- Chrome 146+ capability with WebMCP testing flag enabled (`chrome://flags/#enable-webmcp-testing`)
- or report explicit environment blocker if unavailable

Do not approve "passed browser tests" without environment evidence when WebMCP is required.

## Review Outcomes

- Approve: readiness evidence + expected browser behavior + required checks pass.
- Rework: missing WebMCP evidence, ambiguous fallback use, or unbounded browser claims.
