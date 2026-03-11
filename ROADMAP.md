# Roadmap

Last updated: 2026-03-11

Status labels:

- `implemented`: in this fork today
- `planned`: intended next work
- `exploratory`: direction under evaluation

## Implemented

- `implemented` OAuth auth-circuit breaker with cooldown/reset behavior
- `implemented` Auto-pause for scheduled tasks on auth failures
- `implemented` Duplicate error suppression (message dedup)
- `implemented` Long-lived token preference (`claude setup-token`) over short-lived login credentials
- `implemented` Admin Discord commands (`!restart`, `!purge`) gated by admin user ID
- `implemented` Toolchain modernization (`pnpm`, `tsgo`, `oxfmt`, `oxlint`, `vitest`, `turbo`, `knip`)
- `implemented` Credential proxy and mount hardening for container isolation
- `implemented` File-based IPC support for coordinator-style external worker orchestration

## Near-Term

- `planned` Publish stronger code/config separation starter templates
- `planned` Architect-group template with explicit security-audit workflow
- `planned` Better scheduled-task failure classification and retry policy docs
- `planned` Status data endpoint for dashboard/reporting consumers

## Medium-Term

- `exploratory` Centralized credential handling model for shared team deployments
- `exploratory` Web dashboard integration (workflow status, task history, cost visibility)
- `planned` Additional channel support (for example Slack/web-first variants)
- `exploratory` Voice-channel workflows (speech-in, speech-out)

## Long-Term

- `exploratory` Purpose-built management UI as an alternative to chat-only operations
- `exploratory` Home-automation oriented group/channel integration patterns
- `exploratory` Mobile companion flows for operational visibility and approvals

## Notes

- This roadmap tracks fork-specific direction.
- Broad platform changes should still be proposed upstream when applicable; see [CONTRIBUTING.md](./CONTRIBUTING.md).
