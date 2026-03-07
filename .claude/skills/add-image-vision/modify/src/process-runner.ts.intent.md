# Intent: src/process-runner.ts modifications

## What changed
Added `imageAttachments` optional field to `ContainerInput` interface so image data can be passed to the agent-runner subprocess.

## Key sections

### ContainerInput interface
- Added: `imageAttachments?: Array<{ relativePath: string; mediaType: string }>` — relative paths to resized images in the group directory, with their MIME types

## Invariants
- All other fields in `ContainerInput` and `ContainerOutput` are unchanged
- `buildEnv()`, `runProcessAgent()`, and all other functions are untouched
- The `imageAttachments` field is read by `container/agent-runner/src/index.ts` to load and send images as multimodal content blocks
