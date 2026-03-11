# Intent: src/channels/discord.ts (add-discord-image-vision)

## What changed

Added image vision processing for Discord image attachments. When an image arrives
in a registered channel, it is fetched from the Discord CDN, processed via
`processImage` (resize to max 1024x1024, JPEG, saved to group attachments dir),
and delivered with the relative path reference. Falls back to `[Image: filename]`
placeholder on failure.

## New imports

```typescript
import path from 'path';
import { processImage } from '../image.js';
import { GROUPS_DIR } from '../config.js';
```

## Structural change: attachment processing moved after group lookup

Attachment processing was moved from BEFORE to AFTER the group lookup guard.
This is required because `processImage` needs `group.folder` for the storage path.
`onChatMetadata` still fires BEFORE the guard (for channel discovery).

New handler order:
1. Extract fields (unchanged)
2. @mention translation (unchanged)
3. Reply context (moved before onChatMetadata — does not affect it)
4. `onChatMetadata` (unchanged — fires for all channels)
5. Group lookup + early return (unchanged)
6. Attachment processing (NEW position)
7. `onMessage` (unchanged)

## Attachment changes

- `image/*` → `fetch(att.url)` → buffer → `processImage(buffer, groupDir, caption)`
  - Success: use `result.content` (e.g. `[Image: attachments/img-xxx.jpg]`)
  - Null or error: fallback to `[Image: att.name]`
- `video/*`, other → unchanged placeholders

## Invariants (must preserve)

- `onChatMetadata` fires before the group guard for ALL messages
- Unregistered channels return early after `onChatMetadata` — no change
- `sendMessage`, `setTyping`, `connect`, `disconnect`, `ownsJid` — all unchanged
- Bot message filtering unchanged
- @mention translation unchanged
- 2000-char message splitting unchanged
