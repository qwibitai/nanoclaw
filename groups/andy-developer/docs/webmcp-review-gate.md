# WebMCP Review Gate

Use this before dispatching or approving browser-testing work.

## What WebMCP Is

- WebMCP is a browser/page contract (`navigator.modelContext`), not a regular standalone MCP server.
- Browser tasks can use MCP tooling, but WebMCP success still depends on page-side registration.

## Andy Decision Flow

1. Classify whether the task is UI-impacting.
2. For UI-impacting tasks, set WebMCP as default required validation.
3. If app lacks WebMCP registration, dispatch an implementation task first.
4. Allow DOM-style fallback only when explicitly requested by project/task owner.

UI-impacting examples:
- edits under `src/app`, `src/components`, `pages`, `public`
- CSS/theme/layout/navigation changes
- changes affecting form behavior, client interactions, or rendered UX

## Dispatch Requirements For Browser Tasks

When creating worker dispatch JSON for browser work:

- Keep `task_type` bounded (`test` or `ui-browser`).
- In `input`, state:
  - `webmcp_required: true` (default for UI-impacting tasks)
  - `webmcp_required: false` only when explicit fallback is approved
- Include task-specific WebMCP assertions in `input` (tool names + expected pass criteria).
- Include acceptance tests that prove readiness, for example:
  - app/server up check
  - WebMCP API + registration verification
  - tool execution result(s) for the changed behavior

## Readiness Signals To Require In Evidence

Require all of:

- Runtime check: `navigator.modelContext` and `navigator.modelContextTesting` exist.
- Runtime check: `await navigator.modelContextTesting.listTools()` is non-empty.
- Runtime check: at least one task-relevant `await navigator.modelContextTesting.executeTool("<tool>", "<json-string>")` result.
- Code reference proving registration path:
  - imperative: `registerTool()` or `provideContext()`
  - declarative: `<form toolname="...">` (+ optional `toolautosubmit`, `toolparam*`)

## Environment Gate

For WebMCP-required testing, require worker to confirm:

- Chrome 146+ capability with WebMCP testing flag enabled (`chrome://flags/#enable-webmcp-testing`)
- or report explicit environment blocker if unavailable

Do not approve "passed browser tests" without environment evidence when WebMCP is required.

## Review Outcomes

- Approve: readiness evidence + task-relevant tool execution evidence + expected browser behavior + required checks pass.
- Rework: missing WebMCP evidence, ambiguous fallback use, or unbounded browser claims.
