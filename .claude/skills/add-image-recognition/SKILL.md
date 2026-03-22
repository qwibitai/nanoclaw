---
name: add-image-recognition
description: Add WhatsApp image recognition so Claude can see images users send. Downloads images, passes base64 content blocks to Claude Agent SDK.
---

# Add Image Recognition

This skill adds WhatsApp image support to NanoClaw. When a user sends an image, it is downloaded, stored, and passed to the Claude agent as a multimodal content block (base64-encoded). The agent can then describe, analyze, or answer questions about the image.

No external API keys or dependencies are required — this uses Claude's native vision capabilities.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `image-recognition` is in `applied_skills`, skip to Phase 3 (Build & Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

Run the skills engine to apply all code changes:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-image-recognition
```

This deterministically:

- Three-way merges `image_path` field into `src/types.ts` (NewMessage interface)
- Three-way merges image_path migration, INSERT updates, and SELECT query changes into `src/db.ts`
- Three-way merges `imagePathTransformer` parameter into `src/router.ts` (formatMessages)
- Three-way merges image download logic into `src/channels/whatsapp.ts` (downloadMediaMessage, crypto, DATA_DIR)
- Three-way merges `hostToContainerImagePath` and DATA_DIR import into `src/index.ts`
- Three-way merges images directory mount into `src/container-runner.ts`
- Three-way merges `ContentBlock` type, `buildContentBlocks()`, and multimodal support into `container/agent-runner/src/index.ts`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:

- `modify/src/db.ts.intent.md` — DB schema and query changes
- `modify/src/router.ts.intent.md` — formatMessages signature change
- `modify/src/channels/whatsapp.ts.intent.md` — image download logic
- `modify/src/index.ts.intent.md` — path transformer and DATA_DIR
- `modify/src/container-runner.ts.intent.md` — images volume mount
- `modify/container/agent-runner/src/index.ts.intent.md` — multimodal content blocks

## Phase 3: Build & Verify

```bash
npm run build
```

Build must be clean before proceeding. Common issues:
- If `downloadMediaMessage` is not found in Baileys, check the import name (some versions export it differently)
- If the `ContentBlock[]` type causes issues with the SDK's `content` type, cast as needed

## Phase 4: Deploy & Test

### Deploy

Clear the per-group agent-runner cache so containers pick up the new code, then restart the service:

```bash
# Clear cached agent-runner source (will be re-copied on next container start)
rm -rf data/sessions/*/agent-runner-src/

# Restart the service
# Linux (systemd):
systemctl --user restart nanoclaw
# macOS (launchd):
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Manual Test

Tell the user:

> Send an image (with or without caption) to any registered WhatsApp group. The agent should be able to describe the image content.
>
> Try these tests:
> 1. Image with caption: Send a photo with text "What is this?"
> 2. Image without caption: Send just a photo — the agent should still process it
> 3. Large image (>5MB): Should be skipped with a warning in logs

### Check logs if issues

```bash
# Check for image download logs
grep -i "image" groups/*/logs/container-*.log | tail -20

# Check agent-runner output for content block creation
grep -i "content block\|image file" groups/*/logs/container-*.log | tail -10
```

## Troubleshooting

### Agent ignores images

1. Check DB schema: `sqlite3 store/messages.db ".schema messages"` — should include `image_path TEXT`
2. Check if images are being stored: `ls -la data/images/`
3. Verify the message was stored with image_path: `sqlite3 store/messages.db "SELECT id, image_path FROM messages WHERE image_path IS NOT NULL LIMIT 5"`

### Image download fails

1. Check WhatsApp connection is stable
2. Look for `Failed to download image` in logs
3. Verify Baileys `downloadMediaMessage` is available: `grep downloadMediaMessage node_modules/@whiskeysockets/baileys/lib/index.d.ts`

### Agent can't see the image (gets text but no image)

1. Check container mounts include `/workspace/images`: look in container log for mount configuration
2. Rebuild the container: `./container/build.sh`
3. Clear per-group agent-runner cache: `rm -rf data/sessions/*/agent-runner-src/` — it will be re-copied on next container start
4. Verify the image file exists at the path shown in the XML

### Build errors in agent-runner

The agent-runner TypeScript is compiled inside the container on startup. If it fails:
1. Clear the cached source: `rm -rf data/sessions/*/agent-runner-src/`
2. The next container start will copy fresh source from `container/agent-runner/src/`

## Removal

To remove image recognition support, revert changes in this order:

1. `container/agent-runner/src/index.ts` — remove `ContentBlock` type, `buildContentBlocks()`, revert `MessageStream.push` and `runQuery` changes
2. `src/container-runner.ts` — remove images directory mount
3. `src/index.ts` — remove `hostToContainerImagePath`, remove second argument from `formatMessages` calls, remove `DATA_DIR` import
4. `src/channels/whatsapp.ts` — remove image download block, revert skip condition, remove `image_path` from onMessage, remove `downloadMediaMessage`/`crypto`/`DATA_DIR` imports
5. `src/router.ts` — revert `formatMessages` to original signature
6. `src/db.ts` — remove image_path from INSERT statements and SELECT queries (the ALTER TABLE migration can stay, SQLite cannot drop columns)
7. `src/types.ts` — remove `image_path` from `NewMessage`
8. Clean up images: `rm -rf data/images/`
9. Rebuild: `npm run build && ./container/build.sh`
