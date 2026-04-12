---
name: add-image-vision
description: Add image vision to NanoClaw agents. Resizes and processes WhatsApp image attachments, then sends them to Codex as multimodal content blocks.
---

# Image Vision Skill

Adds the ability for NanoClaw agents to see and understand images sent via WhatsApp. Images are downloaded, resized with sharp, saved to the group workspace, and passed to the agent as base64-encoded multimodal content blocks.

## Phase 1: Pre-flight

1. Check if `src/image.ts` exists — skip to Phase 3 if already applied
2. Confirm `sharp` is installable (native bindings require build tools)

**Prerequisite:** WhatsApp must be installed first (`skill/whatsapp` merged). This skill modifies WhatsApp channel files.

## Phase 2: Apply Code Changes

### Ensure WhatsApp fork remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp skill/image-vision
git merge whatsapp/skill/image-vision || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/image.ts` (image download, resize via sharp, base64 encoding)
- `src/image.test.ts` (8 unit tests)
- Image attachment handling in `src/channels/whatsapp.ts`
- Image passing to agent in `src/index.ts` and `src/container-runner.ts`
- Image content block support in `container/agent-runner/src/index.ts`
- `sharp` npm dependency in `package.json`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/image.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

1. Rebuild the container (agent-runner changes need a rebuild):
   ```bash
   ./container/build.sh
   ```

2. Sync agent-runner source to group caches:
   ```bash
   for dir in data/sessions/*/agent-runner-src/; do
     cp container/agent-runner/src/*.ts "$dir"
   done
   ```

3. Restart the service:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```

## Phase 4: Verify

1. Send an image in a registered WhatsApp group
2. Check the agent responds with understanding of the image content
3. Check logs for "Processed image attachment":
   ```bash
   tail -50 groups/*/logs/container-*.log
   ```

## Troubleshooting

- **"Image - download failed"**: Check WhatsApp connection stability. The download may timeout on slow connections.
- **"Image - processing failed"**: Sharp may not be installed correctly. Run `npm ls sharp` to verify.
- **Agent doesn't mention image content**: Check container logs for "Loaded image" messages. If missing, ensure agent-runner source was synced to group caches.
