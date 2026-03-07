# Update Customize Skill Design

Date: 2026-03-07

## Objective

Fix outdated file references in the customize skill's "Adding a New MCP Integration" section to reflect the switch from `container-runner.ts` to `process-runner.ts` (introduced in commit `de5dcfc`).

## Scope

**One line changed** (`SKILL.md` line 54):

| | Content |
|---|---|
| Before | `Add MCP server config to the container settings (see \`src/container-runner.ts\` for how MCP servers are mounted)` |
| After | `If the MCP server needs filesystem access, add an \`additionalMounts\` entry to the group's \`containerConfig\` in the database (see \`src/process-runner.ts\` for how mounts are passed to the agent process)` |

## Not Changed

- Key Files table
- Channel implementation reference (`src/channels/whatsapp.ts`)
- All other sections

## Rationale

- `src/container-runner.ts` was deleted in `de5dcfc` (replaced by process-based execution)
- `src/process-runner.ts` is now the correct reference for understanding how the agent process environment (including mounts) is configured
- MCP integration via `containerConfig.additionalMounts` is set at the group level in the database
