---
name: add-image-vision
description: Add image vision to NanoClaw agents. Resizes and processes WhatsApp image attachments, then sends them to Claude as multimodal content blocks.
---

# Image Vision Skill

Adds the ability for NanoClaw agents to see and understand images sent via WhatsApp. Images are downloaded, resized with sharp, saved to the group workspace, and passed to the agent as base64-encoded multimodal content blocks.

## Phase 1: Pre-flight

1. Check `.nanoclaw/state.yaml` for `add-image-vision` — skip if already applied
2. Confirm `sharp` is installable (native bindings require build tools)

## Phase 2: Apply Code Changes

1. Initialize the skills system if not already done:
   ```bash
   npx tsx -e "import { initNanoclawDir } from './skills-engine/init.ts'; initNanoclawDir();"
   ```

2. Apply the skill:
   ```bash
   npx tsx skills-engine/apply-skill.ts add-image-vision
   ```

3. Install new dependency:
   ```bash
   npm install sharp
   ```

4. Validate:
   ```bash
   npm run typecheck
   npm test
   ```

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
