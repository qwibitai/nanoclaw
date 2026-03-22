# Intent: src/types.ts

## What Changed

- Added `editMessage` and `sendMessageWithId` optional methods to `Channel` interface

## Key Sections

- **Channel interface**: Two new optional methods after `syncGroups`

## Invariants (must-keep)

- All existing fields on RegisteredGroup unchanged
- All existing fields on Channel unchanged
- AdditionalMount, MountAllowlist, AllowedRoot, ContainerConfig interfaces unchanged
- NewMessage, ScheduledTask, TaskRunLog interfaces unchanged
- OnInboundMessage and OnChatMetadata type aliases unchanged
