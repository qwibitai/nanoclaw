# Intent: src/channels/discord.test.ts

## What Changed
- Added `import path from 'path'` for path-agnostic groupDir assertion
- Added `vi.mock('../config.js', ...)` extended with `GROUPS_DIR: '/tmp/test-groups'`
- Added `vi.mock('../image.js', ...)` mocking `processImage` to return a predictable test result
- Added `vi.stubGlobal('fetch', mockFetch)` for Discord CDN download mocking
- Added `import { processImage } from '../image.js'` to inspect calls
- Added `beforeEach` restoration of `mockFetch` and `processImage` mock implementations after `vi.clearAllMocks()`
- Renamed/restructured the `attachments` describe block:
  - Extracted `image attachments` (vision-specific) as its own describe block
  - Kept `non-image attachments` as a separate describe block for video/audio/file
- Old test `'stores image attachment with placeholder'` → replaced by `'downloads and processes image attachments'`
- Old test `'includes text content with attachments'` → updated to expect processed path `attachments/img-test.jpg`
- Old test `'handles multiple attachments'` → updated to `'handles multiple attachments (image processed, file as placeholder)'`
- Added new image tests:
  - `'falls back to placeholder on image download failure'`
  - `'falls back to placeholder when processImage returns null'`
  - `'does not download images for unregistered channels'`
  - `'does not call fetch for non-image attachments'`

## Invariants (must-keep)
- All original non-image test sections preserved: connection lifecycle, text message handling, @mention translation, reply context, sendMessage, ownsJid, setTyping, channel properties
- MockClient and helper function structures (`createTestOpts`, `createMessage`, `triggerMessage`) preserved
- discord.js mock structure unchanged
- `createTestOpts` default registered group folder remains `'test-server'`
