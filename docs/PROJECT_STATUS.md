# NanoClaw Project Status

This document describes the current implementation state of NanoClaw as of April 2026.

## Runtime Reality

NanoClaw currently runs agent work in tmux sessions on the host.

- The default execution path is `src/container-runner.ts` -> `src/session-settings.ts` -> `src/runtime-adapter.ts`.
- The runtime descriptor is truthful now: `tmux-host`, not Docker, Apple Container, or micro-VM isolation.
- The codebase has a runtime adapter so isolated runtimes can be added later without rewriting orchestration again.

## Shipped Core

| Area               | Status              | Notes                                                                              |
| ------------------ | ------------------- | ---------------------------------------------------------------------------------- |
| Message routing    | Production          | SQLite-backed routing, sender allowlists, per-group isolation.                     |
| tmux runtime       | Production          | Host-exec via tmux sessions; validated by `npm run smoke:runtime`.                 |
| Credential proxy   | Production          | Real Anthropic credentials stay on the host and are injected at request time.      |
| Session commands   | Production          | `/compact` and `/clear` are implemented in core.                                   |
| Task scheduler     | Production          | Scheduled tasks, run history, and per-group context are active.                    |
| Agency HQ dispatch | Internal production | Parallel slot dispatch, stall detection, worktrees, and recovery logic are active. |
| Health surface     | Production          | `GET /health` served by the same process as `GET /skills`.                         |

## Channel Scope

The core repo currently includes Telegram channel code.

- Additional channels belong in skills or downstream forks.
- README and contributor guidance should describe channel support as installation-specific, not universally bundled.

## Experimental Or Internal Subsystems

| Subsystem            | Status       | Notes                                                                               |
| -------------------- | ------------ | ----------------------------------------------------------------------------------- |
| Remote control       | Experimental | Available on demand from the main group only.                                       |
| Uptime monitor       | Internal     | Operator-facing service watchdog, not end-user product surface.                     |
| Host exec watcher    | Internal     | Allowlisted host-side admin path, not a general sandbox escape hatch.               |
| Transcript archiver  | Internal     | Used during `/clear` archival flows.                                                |
| Agent teams / swarms | Experimental | Claude Code capability is enabled, but NanoClaw does not ship a dedicated swarm UX. |

## Dormant Or Historical

| Subsystem            | Status               | Notes                                                               |
| -------------------- | -------------------- | ------------------------------------------------------------------- |
| Sprint retro watcher | Dormant              | Disabled at startup; scheduled-task workflows replaced it.          |
| Meeting engine       | Dormant experimental | Types and tests exist, but the subsystem is not wired into startup. |
| Docker sandbox docs  | Historical           | Keep for reference only; they are not the current default runtime.  |

## Core Vs Skills Boundary

Core should stay focused on:

- correctness
- operational safety
- scheduler reliability
- observability
- security controls
- session lifecycle behavior

Skills or downstream forks should own:

- additional channels
- vertical workflows
- calendar or meeting features
- richer Telegram or Slack product UX
- alternative model providers beyond what the credential proxy already supports
- runtime replacement work that is optional for most users
