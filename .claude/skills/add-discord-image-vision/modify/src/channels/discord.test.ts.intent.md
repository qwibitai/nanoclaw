# Intent: src/channels/discord.test.ts (add-discord-image-vision)

## What changed

Added mocks for the image module and fetch, updated existing image attachment test,
and added 2 new fallback test cases.

## New mocks (added before imports)

```typescript
vi.mock('../image.js', () => ({
  processImage: vi.fn().mockResolvedValue({
    content: '[Image: attachments/img-123.jpg]',
    relativePath: 'attachments/img-123.jpg',
  }),
}));
```

## New imports (after mocks)

```typescript
import { processImage } from '../image.js';
```

## Config mock update

Added `GROUPS_DIR: '/mock/groups'` to the existing config mock.

## beforeEach / afterEach

Added global fetch mock in `beforeEach`:
```typescript
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
}));
```

Added `vi.unstubAllGlobals()` in `afterEach`.

## Attachment test changes

- Updated attachment objects to include `url` field (needed for fetch)
- Changed: `'stores image attachment with placeholder'`
  → `'processes image attachment via processImage'`
  → expects `[Image: attachments/img-123.jpg]`
- Changed: `'includes text content with attachments'`
  → expects `'Check this out\n[Image: attachments/img-123.jpg]'`
- Changed: `'handles multiple attachments'`
  → expects `'[Image: attachments/img-123.jpg]\n[File: b.txt]'`
- Added: `'falls back to placeholder when processImage returns null'`
- Added: `'falls back to placeholder when image fetch fails'`

## Invariants (must preserve)

- All non-image attachment tests (video, file) keep same expectations
- All connection, sendMessage, ownsJid, setTyping tests unchanged
- @mention translation tests unchanged
- Reply context test unchanged
