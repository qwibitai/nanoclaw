# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

[BREAKING] IPC changed from file-based to JSON-RPC over stdio. Existing per-group agent-runner source must be refreshed. Delete `data/sessions/*/agent-runner-src/` and restart — fresh copies will be created automatically on next container launch.

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
