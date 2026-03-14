# Intent: src/index.ts modifications

## What changed
Added image cleanup lifecycle — starts a weekly timer that deletes images older than 30 days
from all group images/ directories. Timer is cleared on shutdown.

## Key sections

### Imports
- Added: `startImageCleanup` from `./image-cleanup.js`

### Module-level state
- Added: `let imageCleanupTimer: NodeJS.Timeout | undefined;`

### Startup (inside main(), after channels connect)
- Added: `imageCleanupTimer = startImageCleanup();` (runs cleanup once, then every 7 days)

### Shutdown handler
- Added: `if (imageCleanupTimer) clearInterval(imageCleanupTimer);`

## Invariants (must-keep)
- All existing imports unchanged
- Channel registration, message loop, container runner — all unchanged
- Task scheduler, IPC watcher — unchanged
- All other shutdown cleanup — unchanged
