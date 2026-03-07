# Intent: src/channels/whatsapp.test.ts modifications

## What changed
Added mocks for downloadMediaMessage and normalizeMessageContent, and test cases for PDF attachment handling.

## Key sections

### Mocks (top of file)
- Modified: config mock to export `GROUPS_DIR: '/tmp/test-groups'`
- Modified: `fs` mock to include `writeFileSync` as vi.fn()
- Modified: Baileys mock to export `downloadMediaMessage`, `normalizeMessageContent`
- Modified: fake socket factory to include `updateMediaMessage`

### Test cases (inside "message handling" describe block)
- "downloads and injects PDF attachment path" — verifies PDF download, save, and content replacement
- "handles PDF download failure gracefully" — verifies error handling (message skipped since content remains empty)

## Invariants (must-keep)
- All existing test cases unchanged
- All existing mocks unchanged (only additive changes)
- All existing test helpers unchanged
- All describe blocks preserved
