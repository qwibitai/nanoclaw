# Changelog

All notable changes to NanoClaw will be documented in this file.

## [2.0.0] - 2026-04-16

### Added
- Mission control system: create, approve, stop, and track multi-role specialist missions from Telegram
- SQLite-backed mission state: missions, mission_roles, and mission_events tables replace file-based state
- Bridge HTTP callback: NanoClaw notifies bridge service when role containers complete
- Callback spool persistence: write-ahead to disk when bridge is temporarily down
- Grammy inline keyboard support: one-tap approve/reject buttons for mission proposals
- Natural language mission detection: main group agent proposes missions from conversation
- CEO sender auth: dangerous Telegram commands gated by TELEGRAM_CEO_USER_ID
- Dispatch JID resolver: bridge logical names (dispatch:atlas_gpg) map to real Telegram group JIDs
- Mission history and show commands for Telegram replay of completed missions

### Changed
- ~/.atlas mounted read-only in containers (security: prevents control-plane modification)
- Separate writable mounts for governance state and host-tasks delegation
- Mission/template paths updated for three-repo split (ATLAS_OPS_DIR)
- Config: added ATLAS_OPS_DIR, BRIDGE_CALLBACK_PORT, TELEGRAM_CEO_USER_ID

### Removed
- Codex toggle system (/codex command, readCodexToggle, writeCodexToggle) — dead since v11 rescope
- File-based mission approval queue (replaced by SQLite)

## [1.2.18] - 2026-04-11

### Fixed
- Containers now always route through the credential proxy — closed direct-auth escape hatch where mounted `.credentials.json` could bypass proxy isolation
- Stale credential files removed from group `.claude/` before container launch with TOCTOU-safe error handling

### Changed
- Prettier formatting applied to commands.ts

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
