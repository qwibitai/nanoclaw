# Intent: src/ipc.ts modifications

## What changed
Added Shabbat/Yom Tov guard to skip IPC message processing during restricted times.

## Key sections

### Imports (top of file)
- Added: `isShabbatOrYomTov` from `./shabbat.js`

### processIpcFiles()
- Added: early return before group folder loop if `isShabbatOrYomTov()`
- IPC message files stay on disk untouched
- They get processed on the first poll after Shabbat ends

## Invariants (must-keep)
- All existing IPC message authorization unchanged
- Task IPC processing unchanged
- Group registration via IPC unchanged
- Error handling and error directory logic unchanged
