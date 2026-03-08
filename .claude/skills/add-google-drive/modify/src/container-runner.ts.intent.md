# Intent: container-runner.ts changes for add-google-drive

## What changed

Added `import os from 'os';` to the imports section.

Added a conditional mount for the Google Drive credentials directory
(`~/.gdrive-mcp/`) immediately after the `.claude/` sessions mount and
before the IPC mount. The mount is read-write so the MCP server can
refresh OAuth tokens automatically without manual re-authentication.

## Invariants

- The mount is conditional (`fs.existsSync(gdriveDir)`) — if the user
  has not yet run `npx -y @modelcontextprotocol/server-gdrive` to
  authorise, the directory will not exist and no mount is added.
  NanoClaw starts normally without Drive access.
- The host path is `~/.gdrive-mcp/` and the container path is
  `/home/node/.gdrive-mcp/` — matching the env vars set in the MCP
  server config in agent-runner/src/index.ts.
- All other mounts, their order, and the rest of the function are
  unchanged.
