# Changelog

Tracks only the latest upstream sync outcome.
Previous entries must be moved to `docs/archives/CHANGELOG-YYYY-MM-DD.md`.

## 2026-03-04

- Synced from: `upstream/main` into `andy-autonomous`
- Version: `1.1.6` -> `1.2.4`

### Bug Fixes

- Upstream worker/runtime reliability fixes landed across container runtime, container runner, IPC auth, DB, scheduler, and queue paths.
- Upstream test coverage expanded for channel registry, sender allowlist, and runtime/dispatch-adjacent flows.

### Features

- Added channel registry architecture (`src/channels/index.ts`, `src/channels/registry.ts`) replacing direct WhatsApp-only channel module wiring.
- Added sender allowlist support (`src/sender-allowlist.ts`) and associated tests.
- Added agent-runner IPC MCP stdio updates in container runner code path.

### Functionality/Behavior

- Legacy WhatsApp-specific files were removed from core (`src/channels/whatsapp.ts` and test), in favor of centralized channel registration.
- Legacy dispatch/event bridge and worker supervisor paths removed, with behavior consolidated into updated runtime/index/queue/IPC contracts.
- Core package/runtime metadata updated to `1.2.4`.

### Docs/Infra

- Container rules markdown files from old runtime paths removed in upstream core.
- Changelog archived to `docs/archives/CHANGELOG-2026-03-04.md` per sync policy.

### Conflict Notes And Local Compatibility Decisions

- Merge conflicts: none.
- Local compatibility overrides during sync: none.
- Sync applied upstream-first with no custom patch reapply failures and no skill reapply failures.
