# Intent: Add DingTalk Channel Import

## Change Description
Add import for the DingTalk channel to trigger self-registration.

## Files Modified
- `src/channels/index.ts`: Added `// dingtalk` comment placeholder and import

## Invariants Preserved
- The barrel file pattern is maintained: each channel import triggers registration
- Comments organize channels alphabetically
- No existing functionality is modified

## Rationale
The DingTalk channel module exports a call to `registerChannel()` that executes when imported. Adding the import here ensures the channel is available at startup if credentials are present.
