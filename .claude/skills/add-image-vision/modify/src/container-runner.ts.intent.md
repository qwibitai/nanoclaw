# Intent: src/container-runner.ts

## What Changed

- Added `imageAttachments?` optional field to `ContainerInput` interface

## Key Sections

- **ContainerInput interface**: imageAttachments optional field (`Array<{ relativePath: string; mediaType: string }>`)

## Invariants (must-keep)

- ContainerOutput interface unchanged
- buildContainerArgs structure (run, -i, --rm, --name, mounts, image)
- runContainerAgent with streaming output parsing (OUTPUT_START/END markers)
- writeTasksSnapshot, writeGroupsSnapshot functions
- Additional mounts via validateAdditionalMounts
- Mount security validation against external allowlist
