# Intent: src/container-runner.ts

## What Changed
- Added `imageAttachments?` optional field to `ContainerInput` interface

## Key Sections
- **ContainerInput interface**: imageAttachments optional field (`Array<{ relativePath: string; mediaType: string }>`)

## Invariants (must-keep)
- JSON-RPC over stdio (JSONRPCServerAndClient, RPC_PREFIX framing)
- ContainerOutput interface unchanged
- buildContainerArgs structure (run, -i, --rm, --name, mounts, image)
- runContainerAgent with 6-param signature (group, input, onProcess, onOutput, deps, onReady)
- JSON-RPC initialize/input/close/output protocol
- rpc.request('initialize', input) for sending ContainerInput
- rpc.rejectAllPendingRequests on container exit
- Additional mounts via validateAdditionalMounts
- Mount security validation against external allowlist
- No writeTasksSnapshot/writeGroupsSnapshot (removed in stdio IPC migration)
