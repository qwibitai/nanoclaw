# Intent: src/container-runner.test.ts modifications

## What changed
Added `HOME_DIR` to the config mock so the test module satisfies the new import from container-runner.ts.

## Key sections
- **vi.mock('./config.js')**: Added `HOME_DIR: '/tmp/nanoclaw-test-home'` to the mock return object. Without this, `findClaudeMemScripts()` would fail trying to read `undefined/.claude/plugins/...`.

## Invariants
- All existing mock values are unchanged
- All existing test cases are unchanged
- The mock HOME_DIR points to a non-existent temp path, so `findClaudeMemScripts()` returns null (fs.existsSync is already mocked to return false)

## Must-keep
- All existing test cases and assertions
- The fake process factory and output marker helpers
- All other config mock values (CONTAINER_IMAGE, CONTAINER_MAX_OUTPUT_SIZE, etc.)
