# WebMCP Testing

Default browser-testing gate for UI-impacting work.

WebMCP is a browser/page capability (`navigator.modelContext`), not a standalone MCP server entry.

## Default Trigger (Mandatory)

Run this workflow by default when any of the following are true:

- dispatched `task_type` is `ui-browser` or `test`
- dispatch/input includes `webmcp_required: true`
- task changes UI paths (`src/app`, `src/components`, `pages`, `public`, `*.css`, layout/theme/navigation code)

If trigger conditions are met, do not skip browser validation.

## Environment Requirements

1. Chrome 146+ runtime with `chrome://flags/#enable-webmcp-testing` enabled
2. Non-headless browsing context available
3. App server running and reachable on the target route
4. App registers WebMCP tools (imperative or declarative)

Optional for manual debugging: Model Context Tool Inspector extension.

## Server Requirement

Before browser checks:

1. Start server (`npm run dev` or project equivalent)
2. Probe readiness (`curl` on expected route or health endpoint)
3. Keep server running during tool execution

## WebMCP API + Registration Verification (Mandatory)

Use runtime checks before assertions:

```javascript
if (!navigator.modelContext || !navigator.modelContextTesting) {
  throw new Error("WebMCP API unavailable in current browser runtime");
}
const tools = await navigator.modelContextTesting.listTools();
if (!Array.isArray(tools) || tools.length === 0) {
  throw new Error("App missing WebMCP registration - cannot test");
}
```

## Task Assertion Execution (Mandatory)

Execute at least one task-relevant tool:

```javascript
const raw = await navigator.modelContextTesting.executeTool(
  "check_sidebar_contrast",
  "{}"
);
```

Notes:

- `executeTool` input arguments must be a JSON string
- choose tool/assertion based on task objective, not generic smoke only

## Evidence Required In Completion

Include a compact WebMCP evidence block with:

1. browser runtime/version evidence
2. API availability (`modelContext` + `modelContextTesting`)
3. tool discovery result (`listTools` count + names)
4. executed tool name(s), input JSON string, and output
5. pass/fail decision tied to expected behavior

No "browser pass" claims without tool execution evidence.

## Fallback Policy

DOM/screenshot fallback is allowed only when dispatch explicitly sets:

- `webmcp_required: false`
- or `fallback_allowed: true`

Otherwise, report blocker and escalate to Andy-Developer.
