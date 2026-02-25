# Changelog

Tracks only the latest upstream sync outcome.
Previous entries must be moved to `docs/archives/CHANGELOG-YYYY-MM-DD.md`.

## 2026-02-25
- Synced from: `upstream/main` into `architecture-optmization`
- Merge commit: `1976a21`

### Bug Fixes
- WhatsApp connection reliability fixes from upstream were included:
  - WA Web version fetch now uses latest-version lookup to avoid `405` failures.
  - Added stronger error handling for WA Web version fetch.
  - QR data handling fixes in WhatsApp auth flow.
- Security hardening fixes included:
  - Group-folder path escape protections.
  - Skills file-op path/symlink escape protections.
  - Project root mounted read-only in container flow to reduce escape risk.

### Features
- Added/updated upstream update workflow support (`/update` skill and related update tooling).
- Added official Qodo skills and code intelligence integrations from upstream.
- Setup flow migrated toward cross-platform Node.js modules (replacing bash-heavy setup path).

### Functionality/Behavior
- Container runtime behavior improved with:
  - Host timezone propagation into container runtime.
  - Assistant name propagation instead of hardcoded fallback.
- Polling/message handling refinements and stricter validation improvements from upstream were integrated.

### Docs/Infra
- Upstream README/docs refresh and version bumps through `1.1.2`.
- Added `.nvmrc` (Node 22 baseline) from upstream.

### Conflict Notes
- Conflicted files were resolved with upstream-first preference for bug-fix safety.
- Local compatibility was retained where required (notably worker-run DB APIs used by existing branch tests).
