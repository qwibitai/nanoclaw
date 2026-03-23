# TODO

## Cleanup before push

- Move credits from SKILL.md files to commit/PR messages (no upstream skills have credits in SKILL.md — keep skill files clean, credit contributors in git history instead)

## @gavriel

- `src/media.ts` processContentParts() — shorter (current: data-driven with casts, line 114) or simpler (explicit case per media type, no casts)?

## Upstream skills to fix after merge

- **`use-local-whisper`** — incompatible with our architecture. Modifies `src/transcription.ts` (old host-side, WhatsApp-only approach). Our architecture uses container-side handlers. A local whisper handler would need to run host-side (needs ffmpeg, whisper-cli via Homebrew — not available in container). Rewrite or deprecate. (saved instructions for reference // Fritzzzz)
- **`add-image-vision`** — superseded. Modifies WhatsApp channel files and uses `sharp` for resizing. Our architecture handles image download channel-agnostically in `processContentParts()` and embeds natively in the agent runner. Deprecate or repurpose (e.g., for image resizing before embed to save tokens).

## Implement media support for all remaining channels
