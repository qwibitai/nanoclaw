---
name: add-discord-image-vision
description: Add image vision to NanoClaw's Discord channel. When a user sends an image, it is downloaded from the Discord CDN, resized, saved to the group's attachments folder, and delivered to the agent as `[Image: attachments/img-xxx.jpg]` so Claude can actually see it.
---

# Add Discord Image Vision

Adds the ability for NanoClaw agents to see and understand images sent via Discord. Images are downloaded from the Discord CDN, resized with sharp, saved to the group workspace, and delivered to the agent as `[Image: attachments/img-xxx.jpg]`.

## Phase 1: Pre-flight

1. Check if `src/image.ts` exists — skip to Phase 3 if already applied
2. Confirm `sharp` is installable (native bindings require build tools)

**Prerequisite:** Discord must be installed first (`discord` channel merged). This skill modifies Discord channel files.

## Phase 2: Apply Code Changes

### Ensure Discord fork remote

```bash
git remote -v
```

If `discord` is missing, add it:

```bash
git remote add discord https://github.com/qwibitai/nanoclaw-discord.git
```

### Merge the skill branch

```bash
git fetch discord skill/image-vision
git merge discord/skill/image-vision || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/image.ts` (image download, resize via sharp, local storage)
- Image attachment handling in `src/channels/discord.ts` (fetch from CDN → processImage → store in group dir)
- Image processing tests in `src/channels/discord.test.ts` (3 test cases: success, null, fetch failure)
- `sharp` npm dependency in `package.json`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/discord.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

1. Restart the service:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   # Linux: systemctl --user restart nanoclaw
   ```

## Phase 4: Verify

1. Send an image in a registered Discord channel
2. Check the agent responds with understanding of the image content
3. Check logs for image processing:
   ```bash
   tail -f logs/nanoclaw.log | grep -i image
   ```

Look for:
- `Discord message stored` — message delivered with image reference
- `Discord image processing failed` — download or sharp error

## Troubleshooting

- **Images show `[Image: filename.jpg]` instead of the processed path**: The fallback placeholder is shown when processImage returns null (empty buffer) or when fetch fails. Check that the Discord CDN URL is reachable and that the `attachments/` directory is writable.
- **sharp installation fails**: On macOS: `brew install vips` then `npm install sharp`. On Linux: `apt-get install libvips-dev` then `npm install sharp`.
- **Agent doesn't mention image content**: Check that the image was stored in `groups/<name>/attachments/`. If missing, check logs for download errors.
