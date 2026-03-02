# Intent: src/container-runner.ts

## What Changed
- Added `imageAttachments?` optional field to `ContainerInput` interface

## Key Sections
- **ContainerInput interface**: One new optional field added at the end

## Invariants (must-keep)
- All existing ContainerInput fields (prompt, sessionId, groupFolder, chatJid, isMain, isScheduledTask, secrets)
- ContainerOutput interface unchanged
- buildVolumeMounts, buildContainerArgs, runContainerAgent functions unchanged
- readSecrets function unchanged
- writeTasksSnapshot, writeGroupsSnapshot functions unchanged
- Volume mount logic and security validation unchanged
