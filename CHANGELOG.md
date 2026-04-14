# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

- **fix:** Ensure `url_watch` programmatic thread spawns initialize `chats` metadata before storing synthetic messages, and only finalize spawn reservation after thread initialization succeeds.

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
