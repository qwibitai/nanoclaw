---
name: add-discord-image-vision
description: Add image vision to NanoClaw's Discord channel. When a user sends an image, it is downloaded from the Discord CDN, resized, saved to the group's attachments folder, and delivered to the agent as `[Image: attachments/img-xxx.jpg]` so Claude can actually see it.
---

# Add Discord Image Vision

This skill adds image processing to NanoClaw's Discord channel using the same `processImage` pipeline already used by WhatsApp. When an image attachment arrives in a registered Discord channel, it is fetched, resized via sharp, stored locally, and delivered with a relative path reference the agent can read.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `discord-image-vision` is in `applied_skills`, skip to Phase 3 (Verify). The code changes are already in place.

### Check prerequisites

This skill requires the `discord` skill to be applied first. Confirm `discord` is in `applied_skills`.

## Phase 2: Apply Code Changes

### Install sharp (if not already installed)

```bash
npm install sharp
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-discord-image-vision
```

This deterministically:
- Adds `src/image.ts` (image processing module using sharp)
- Three-way merges image handling into `src/channels/discord.ts` (fetch → processImage, with fallback)
- Three-way merges image tests into `src/channels/discord.test.ts` (fetch mock, processImage mock, 3 test cases)
- Records the application in `.nanoclaw/state.yaml`

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Verify

### Test with an image

Send an image in any registered Discord channel. The agent should receive it as `[Image: attachments/img-xxx.jpg]` and be able to describe what's in the image.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i image
```

Look for:
- `Discord message stored` — message delivered with image reference
- `Discord image processing failed` — download or sharp error (check network, disk space)

## Troubleshooting

### Images show `[Image: filename.jpg]` instead of the processed path

The fallback placeholder is shown when processImage returns null (empty buffer) or when fetch fails. Check that the Discord CDN URL is reachable and that the `attachments/` directory is writable.

### sharp installation fails

On macOS: `brew install vips` then `npm install sharp`
On Linux: `apt-get install libvips-dev` then `npm install sharp`
