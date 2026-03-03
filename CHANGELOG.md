# Changelog

All notable changes to NanoClaw will be documented in this file.

## [1.3.0]

[BREAKING] File-based IPC replaced with Unix sockets. Migration: delete all `data/sessions/*/agent-runner-src/` directories (they regenerate on next container start with socket-based code), clean up old `data/ipc/*/messages/`, `tasks/`, `input/` subdirs, and rebuild the container image with `./container/build.sh`. Skills that modified the agent-runner (e.g., Gmail) should be re-applied.

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
