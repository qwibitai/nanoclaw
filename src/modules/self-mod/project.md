# Self-mod module

Optional-tier module that gives agents admin-gated self-modification:
installing OS/npm packages and registering new MCP servers. Both paths go
through the approvals module's request primitive — no unapproved changes
ever land. The rebuild+restart (or restart-only) follow-up is bundled into
the approval handler itself — there is no separate "request rebuild" step.

## What this module adds

- Two delivery actions (`install_packages`, `add_mcp_server`) that the
  container's self-mod MCP tools write into outbound.db. On the host, each
  handler validates input and queues an approval via
  `approvals.requestApproval()`.
- Two matching approval handlers that run on approve:
  - `install_packages` → update `container.json`, rebuild the image via
    `buildAgentGroupImage`, and kill the container so the host sweep
    respawns it on the new image. Also schedules a verify-and-report
    follow-up prompt ~5 s after kill.
  - `add_mcp_server` → update `container.json` and kill the container.
    No image rebuild — bun runs TS directly, so the new MCP wiring is
    picked up on the next container start.

## Dependency

Self-mod depends on the approvals default module for:
- `requestApproval()` to enqueue admin confirmation cards
- `registerApprovalHandler(action, handler)` to run orchestration on approve
- `notifyAgent()` to send failure feedback back to the requesting agent

It also calls core's `buildAgentGroupImage`, `killContainer`, and
`updateContainerConfig`.

## Removing the module

Delete `src/modules/self-mod/` and its import line in `src/modules/index.ts`.
The container's self-mod MCP tools will still write outbound system messages,
but core delivery will log `"Unknown system action"` and drop them — no
admin card, no container mutation.
