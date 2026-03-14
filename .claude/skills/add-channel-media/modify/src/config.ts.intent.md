# Intent: src/config.ts modifications

## What changed
Added media directory and size limit configuration exports.

## Key additions
- **MEDIA_DIR**: `path.resolve(DATA_DIR, 'media')` — Base directory for downloaded media files, per-group subdirectories mounted into containers.
- **MAX_MEDIA_SIZE**: Configurable via `MAX_MEDIA_SIZE` env var, defaults to 52428800 (50MB). Size limit for media transfers. Enforced in `processInboundMedia()` (rejects oversized refs) and `downloadMedia` in `index.ts` (checks buffer size after download).

## Placement
Exports are placed after `DATA_DIR` and before `CONTAINER_IMAGE`, grouping path constants together.

## Invariants
- All existing config exports remain unchanged
- New exports follow existing patterns (path.resolve for paths, parseInt for size limits)
- No changes to readEnvFile call or existing environment variables

## Must-keep
- All existing exports (ASSISTANT_NAME, STORE_DIR, DATA_DIR, GROUPS_DIR, etc.)
- The readEnvFile pattern
- The escapeRegex helper and TRIGGER_PATTERN construction
- TIMEZONE export at the end
