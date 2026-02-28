# What this skill adds

- Adds MCP tool `update_canvas` to forward json-render SpecStream JSONL updates through IPC and await structured responses.
- Adds response polling helper for synchronous tool UX.

# Key sections

- `RESPONSES_DIR` constant.
- `waitForCanvasResponse(requestId, timeoutMs)` helper.
- JSONL helpers (`normalizeJsonl`, `operationsToJsonl`).
- New `server.tool('update_canvas', ...)`.

# Invariants

- Existing MCP tools (`send_message`, task tools, register_group) must keep behavior.
- Existing IPC file write pattern must remain atomic.
- Non-main authorization guard must be enforced before writing restricted requests.

# Must-keep sections

- `writeIpcFile` helper.
- Existing `server.tool(...)` registrations and stdio transport boot.
