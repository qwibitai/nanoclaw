# Intent: src/router.ts

## What Changed

- `stripInternalTags` now also removes leaked thinking XML blocks and function_calls XML blocks from outbound messages

## Key Sections

- **stripInternalTags**: Additional regex replacements chained after existing internal tag strip

## Invariants (must-keep)

- formatMessages function (message formatting pipeline)
- findChannel function
- formatOutbound function
- stripInternalTags existing behavior (internal tag removal)
