# Intent: src/group-queue.ts

## What Changed
- Added `isActive()` public method to check if a group has an active container

## Key Sections
- **isActive** (after `closeStdin`): Simple lookup returning `state?.active === true`

## Invariants (must-keep)
- GroupState interface with all fields (active, idleWaiting, isTaskContainer, etc.)
- GroupQueue class with all existing methods
- enqueueMessageCheck, enqueueTask, registerProcess, notifyIdle, sendMessage, closeStdin
- runForGroup, runTask, scheduleRetry, drainGroup, drainWaiting
- shutdown with detached container behavior
- MAX_RETRIES, BASE_RETRY_MS constants
