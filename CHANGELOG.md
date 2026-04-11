# Changelog

All notable changes to NanoClaw will be documented in this file.

## [1.2.18] - 2026-04-11

### Fixed
- Containers now always route through the credential proxy — closed direct-auth escape hatch where mounted `.credentials.json` could bypass proxy isolation
- Stale credential files removed from group `.claude/` before container launch with TOCTOU-safe error handling

### Changed
- Prettier formatting applied to commands.ts

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
