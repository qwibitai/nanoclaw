---
name: add-discord-image-vision
description: Add image vision to Discord messages. Downloads Discord image attachments, resizes them with sharp, and passes them to Claude as multimodal content blocks — exactly like the WhatsApp image vision skill, but for Discord.
---

# Discord Image Vision Skill

Extends the Discord channel to download and process image attachments so NanoClaw agents can actually see and understand images sent in Discord channels. Images are fetched from Discord's CDN, resized with sharp, saved to the group workspace, and passed to the agent as base64-encoded multimodal content blocks.

## Prerequisites

This skill depends on two skills that must already be applied:
- **add-discord** — provides the Discord channel integration
- **add-image-vision** — provides the shared `image.ts` utilities (processImage, parseImageReferences) and multimodal agent-runner support

## Phase 1: Pre-flight

1. Check `.nanoclaw/state.yaml` for `add-discord-image-vision` — skip if already applied
2. Confirm `add-discord` and `add-image-vision` are listed in `applied_skills`
3. Confirm `sharp` is installed: `npm ls sharp`

## Phase 2: Apply Code Changes

1. Initialize the skills system if not already done:
   ```bash
   npx tsx -e "import { initNanoclawDir } from './skills-engine/init.ts'; initNanoclawDir();"
   ```

2. Apply the skill:
   ```bash
   npx tsx skills-engine/apply-skill.ts add-discord-image-vision
   ```

3. Validate:
   ```bash
   npm run typecheck
   npm test
   ```

## Phase 3: Configure

No new environment variables are required. The skill uses:
- `GROUPS_DIR` from existing config (already set)
- `sharp` npm package (already installed by `add-image-vision`)
- Node 18+ built-in `fetch` for downloading from Discord CDN

Rebuild and restart the service so the updated channel code takes effect:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

1. Send an image in a registered Discord channel
2. The agent should respond with understanding of the image content
3. Check logs for image processing:
   ```bash
   tail -50 groups/*/logs/container-*.log
   ```
   Look for `"Loaded image"` entries in the container output.

## How It Works

**Before this skill:** Discord image attachments are stored as `[Image: filename.ext]` text placeholders. The agent sees only the filename, not the image content.

**After this skill:** Discord image attachments are downloaded from Discord's CDN, resized to max 1024×1024 px (JPEG, 85% quality) using sharp, and saved to the group's `attachments/` directory. The message content becomes `[Image: attachments/img-xxx.jpg]`, which `parseImageReferences()` picks up and passes to the agent as a base64 image content block.

Non-image attachments (video, audio, files) continue to use text placeholders.

On download or processing failure, the skill falls back gracefully to the original `[Image: filename]` placeholder so the agent is at least aware an image was sent.

## Troubleshooting

- **"Discord image - download failed"**: The image URL may have expired or the network timed out. Discord CDN URLs are time-limited — older messages' image URLs may no longer be valid.
- **"Image - processing failed"**: Sharp may not be installed. Run `npm ls sharp` to verify, then `npm install sharp` if missing.
- **Agent doesn't mention image content**: Check container logs for `"Loaded image"` messages. If missing, ensure the container was rebuilt after applying this skill (`./container/build.sh`) and the agent-runner source was synced to group caches.
- **Images work in WhatsApp but not Discord**: Confirm `add-discord-image-vision` is listed in `.nanoclaw/state.yaml` under `applied_skills`.
