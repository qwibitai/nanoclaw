# Intent: src/channels/discord.ts

## What Changed
- Added `import path from 'path'`
- Added `GROUPS_DIR` to the config import
- Added `import { processImage } from '../image.js'`
- Moved attachment handling block from before the group check to **after** the registered-group guard
- For `image/` content-type attachments: fetch from Discord CDN (`fetch(att.url)`), convert to Buffer, call `processImage(buffer, groupDir, '')`, store as `[Image: attachments/img-xxx.jpg]` so `parseImageReferences()` picks it up
- Falls back to the old `[Image: filename]` placeholder on download or processing failure
- Added `if (!content) return;` guard after attachment processing (matches WhatsApp channel pattern)

## Key Sections
- **Imports** (top of file): New `path`, `GROUPS_DIR`, and `processImage` imports
- **MessageCreate handler** (inside `connect()`): Attachment block moved after `registeredGroups()` check, image download + processImage call added, fallback preserved, content guard added

## Invariants (must-keep)
- DiscordChannel class structure and all existing methods
- `registerChannel('discord', ...)` factory at the bottom
- Connection lifecycle (connect, ClientReady, disconnect)
- Bot message filter (`if (message.author.bot) return`)
- @mention translation to TRIGGER_PATTERN format
- Reply context (`[Reply to Author]` prefix)
- `onChatMetadata` call always fires (even for unregistered channels) so discovery works
- Non-image attachment types (video, audio, file) continue to use text placeholders
- sendMessage 2000-char splitting
- setTyping behaviour
- ownsJid dc: prefix check
