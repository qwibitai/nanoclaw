# Changelog

Tracks only the latest upstream sync outcome.
Previous entries must be moved to `docs/archives/CHANGELOG-YYYY-MM-DD.md`.

## 2026-02-26

- Synced from: `upstream/main` into `andy-developer-optimization`
- Merge commit: `upstream/main` (version 1.1.3)

### Bug Fixes

- CI workflow improvements from upstream.
- Various codebase formatting fixes (Prettier).

### Features

- Added `/add-slack` skill (new Slack channel integration).
- New GitHub Actions: `skill-drift.yml`, `skill-pr.yml`.
- Updated skills engine with improved reliability.

### Functionality/Behavior

- Removed queue disk persistence (upstream removed this feature).
- 2 tests skipped for removed queue persistence functionality.

### Docs/Infra

- Added CONTRIBUTORS.md.
- Updated `.github/workflows` naming (test.yml → ci.yml).

### Conflict Notes

- `src/container-runtime.ts` - Kept Apple Container (local requirement).
- `src/container-runner.ts` - Kept worker mount paths (local requirement).
- `src/index.ts`, `src/ipc.ts` - Kept worker dispatch system (local requirement).
- `src/db.ts` - Kept worker_runs table (local requirement).
- `src/channels/whatsapp.ts` - Accepted upstream version (queue persistence removed upstream).
