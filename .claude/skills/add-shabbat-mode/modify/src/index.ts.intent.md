# Intent: src/index.ts modifications

## What changed
Added Shabbat/Yom Tov guards, candle lighting notifications, and post-Shabbat catch-up logic.

## Key sections

### Imports (top of file)
- Added: `initShabbatSchedule`, `isShabbatOrYomTov`, `startCandleLightingNotifier`, `stopCandleLightingNotifier` from `./shabbat.js`

### notifyMainGroup() helper
- New function to send system messages to the main group
- Used by `sendPostShabbatSummary()`

### sendPostShabbatSummary()
- New function called on Shabbat-to-weekday transition
- Sends "Shavua Tov!" greeting with per-group pending message counts
- Returns list of JIDs with pending messages so the caller can re-queue them

### processGroupMessages()
- Added: early return `if (isShabbatOrYomTov())` after group existence check
- Returns `true` (success) to prevent retries, but does NOT advance `lastAgentTimestamp`
- Messages remain unprocessed and queue naturally for post-Shabbat pickup

### startMessageLoop()
- Added: `wasShabbat` tracking variable initialized from `isShabbatOrYomTov()`
- Added: `currentlyShabbat` check each iteration
- Added: post-Shabbat catch-up logic: when `wasShabbat && !currentlyShabbat`, sends summary and re-queues pending groups
- Added: `if (!currentlyShabbat)` guard wrapping the message dedup and processing block
- The "seen" cursor (`lastTimestamp`) still advances to prevent re-logging
- The per-group cursor (`lastAgentTimestamp`) stays un-advanced so messages queue

### main() function
- Added: `initShabbatSchedule()` call after `loadState()` to load the schedule at startup
- Added: `stopCandleLightingNotifier()` in graceful shutdown handler
- Added: candle lighting notifier startup after channel connect — sends reminders to main group user

## Invariants (must-keep)
- All existing message handling, trigger logic, piping to active containers unchanged
- Connection lifecycle unchanged
- State save/load unchanged
- Recovery logic unchanged
- GroupQueue interaction unchanged
