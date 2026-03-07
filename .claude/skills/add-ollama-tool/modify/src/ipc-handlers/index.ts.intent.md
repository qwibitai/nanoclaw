# Intent: src/ipc-handlers/index.ts modifications

## What changed
Added import of the Ollama IPC handler so it self-registers at startup.

## Key sections

### Imports
- Added: `import './ollama.js';`

## Invariants
- Existing `import './core.js';` is unchanged
- All core handlers continue to self-register

## Must-keep
- The `import './core.js';` line
