---
name: add-whatsapp-image-understanding
description: Add WhatsApp image understanding to NanoClaw. Downloads WhatsApp images, saves them to group folders, and prompts the agent to read them using the Read tool.
---

# Add WhatsApp Image Understanding

This skill adds image understanding to NanoClaw's WhatsApp channel. When an image arrives,
it is downloaded via Baileys, saved to the group's images/ folder, and the agent receives
a prompt like `[Image — view it by reading: /workspace/group/images/file.jpg]` so it can
use the Read tool to view the image.

## Phase 1: Pre-flight

### Check if already applied
Read `.nanoclaw/state.yaml`. If `image-understanding` is in `applied_skills`, skip to Phase 3.

### Prerequisites
- No additional API keys needed (uses Baileys' built-in media download)
- Works with or without the voice-transcription skill

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)
```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill
```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp-image-understanding
```

This deterministically:
- Adds `src/image-handler.ts` (image download + save functions)
- Adds `src/image-cleanup.ts` (weekly cleanup of old images)
- Three-way merges image handling into `src/channels/whatsapp.ts`
- Three-way merges image tests into `src/channels/whatsapp.test.ts`
- Three-way merges cleanup timer into `src/index.ts`
- Adds image instructions to `groups/global/CLAUDE.md`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/whatsapp.ts.intent.md`
- `modify/src/channels/whatsapp.test.ts.intent.md`
- `modify/src/index.ts.intent.md`
- `modify/groups/global/CLAUDE.md.intent.md`

### Validate code changes
```bash
npm test
npm run build
```

## Phase 3: Configure

No configuration needed. Image understanding uses Baileys' built-in media download — no API key required.

### Sender allowlist (optional)
By default, images from all senders are processed. To restrict which senders can send images,
configure `sender-allowlist.json` (same file used for message allowlisting).

### Build and restart
```bash
npm run build
```

## Phase 4: Verify

### Test with an image
Send an image in any registered WhatsApp chat. The agent should receive it as
`[Image — view it by reading: /workspace/group/images/...]` and describe what it sees.

### Check logs if needed
```bash
tail -f logs/nanoclaw.log | grep -i image
```

Look for:
- `Downloaded and saved image` — successful download with size + mimetype
- `Image download error` — media download failure
- `Deleted old image` — cleanup running correctly

## Troubleshooting

### Agent says "Image - download failed"
1. Check logs for the specific error
2. Verify Baileys is connected (WhatsApp web session active)
3. Media download may time out on slow connections — retry

### Images not cleaned up
1. Check logs for `Image cleanup` entries
2. Cleanup runs at startup + every 7 days
3. Only deletes images older than 30 days

### Agent doesn't respond to images at all
1. Verify the chat is registered
2. Check sender-allowlist.json if configured
3. Verify `groups/global/CLAUDE.md` contains the Images section
