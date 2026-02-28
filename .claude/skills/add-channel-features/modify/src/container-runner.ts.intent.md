# Intent: src/container-runner.ts modifications

## What changed
Added `writeGroupMetadataSnapshot` function and `GroupMetadata` import.

## Key sections

### Import
- Added: `GroupMetadata` from `./types.js`

### writeGroupMetadataSnapshot() (new function)
- Takes `groupFolder` and optional `GroupMetadata`
- Writes metadata JSON to the group's IPC directory (`group_metadata.json`)
- Called before container invocation so the container's `get_group_info` MCP tool can read it
- Defaults to empty metadata `{ description: '', members: [], admins: [] }` when undefined

## Invariants
- All existing container runner functions unchanged (runContainerAgent, resolveGroupIpcPath, etc.)
- Mount resolution, security checks, and container lifecycle unchanged
- The function is exported but only called from index.ts
