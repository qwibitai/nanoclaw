# Intent: src/index.ts modifications

## What changed
Added Shabbat/Yom Tov guards to prevent message processing and agent invocation during restricted times.

## Key sections

### Imports (top of file)
- Added: `initShabbatSchedule`, `isShabbatOrYomTov` from `./shabbat.js`

### main() function
- Added: `initShabbatSchedule()` call after `loadState()` to load the schedule at startup

### processGroupMessages()
- Added: early return `if (isShabbatOrYomTov())` after group existence check
- Returns `true` (success) to prevent retries, but does NOT advance `lastAgentTimestamp`
- Messages remain unprocessed and queue naturally for post-Shabbat pickup

### startMessageLoop()
- Added: `if (!isShabbatOrYomTov())` guard wrapping the message dedup and processing block
- The "seen" cursor (`lastTimestamp`) still advances to prevent re-logging
- The per-group cursor (`lastAgentTimestamp`) stays un-advanced so messages queue

## Invariants (must-keep)
- All existing message handling, trigger logic, piping to active containers unchanged
- Connection lifecycle unchanged
- State save/load unchanged
- Recovery logic unchanged
- GroupQueue interaction unchanged
