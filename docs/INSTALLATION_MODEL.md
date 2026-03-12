# Installation Model

This guide explains the recommended structure for long-lived NanoClaw installations on this fork.

## Core Principle: Separate Code From Personal Config

Keep two repos/directories:

- **Fork code repo (public):** NanoClaw runtime code, docs, templates
- **Assistant config repo (private):** group definitions, memory files, schedules, sensitive local conventions

This fork does not track live `groups/` contents in git. Group folders and `CLAUDE.md` files are installation-specific runtime state.

Benefits:

- Pull upstream and fork updates with less conflict risk
- Keep assistant identity, task prompts, and personal context private
- Rebuild or migrate runtime code without losing assistant state design

## Suggested Layout

```text
nanoclaw/                          # Fork code repo (public)
├── src/
├── docs/
├── config-examples/
└── ...

your-assistant-config/             # Private config repo
├── groups/
│   ├── global/
│   │   └── CLAUDE.md              # Shared identity + global rules
│   ├── main/
│   │   ├── CLAUDE.md              # Coordinator behavior
│   │   └── scheduled-tasks/
│   ├── architect/
│   │   └── CLAUDE.md              # System evolution context
│   └── meal-planning/
│       ├── CLAUDE.md
│       └── data/
├── .env                           # Credentials (gitignored)
└── runtime-overrides/             # Optional platform/channel mappings
```

### Runtime Wiring (Required)

NanoClaw runtime still starts from the code repo directory, but config can be loaded from elsewhere.

- Default behavior: `.env` and `groups/` are loaded from the code repo root (`process.cwd()`).
- External config behavior: set `NANOCLAW_CONFIG_ROOT=/absolute/path/to/your-assistant-config`.
  - `.env` is loaded from `${NANOCLAW_CONFIG_ROOT}/.env`
  - groups are loaded from `${NANOCLAW_CONFIG_ROOT}/groups`

Example:

```bash
cd ~/nanoclaw
NANOCLAW_CONFIG_ROOT=~/your-assistant-config pnpm run start
```

If you use launchd/systemd, set `NANOCLAW_CONFIG_ROOT` in the service environment so restarts keep the same config root.

## Group Model

- **Main group (`isMain: true`)**: coordinator, global visibility, cross-group task management
- **Non-main groups**: scoped contexts for domain tasks, shared channels, or social workflows
- **Global identity (`<config-root>/groups/global/CLAUDE.md`)**: shared voice and baseline policy, read-only in non-main groups

For trust boundaries and permissions, see [SECURITY.md](./SECURITY.md).

## Example: Household Planning Group

A non-main group can run a weekly planning loop with:

- `CLAUDE.md` for household constraints (preferences, budget, dietary rules)
- scheduled prompts for weekly planning and reminders
- persistent files under the group folder for history and decisions

The workflow remains chat-first: gather input, propose plan, revise, finalize, and send status updates.

## Credential Model (Current Fork Behavior)

- Real provider credentials remain on host side.
- Containers call the host credential proxy via `ANTHROPIC_BASE_URL`.
- `.env` long-lived token (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) is preferred.
- Fallback to `~/.claude/.credentials.json` is available when needed.

See [SECURITY.md](./SECURITY.md) and [SPEC.md](./SPEC.md#claude-authentication).

### Household vs Team Usage

- **Household/friends chat**: only the assistant runtime needs provider credentials; participants just message the channel.
- **Developer team workflows**: each developer typically runs their own instance today for credential separation.
- **Centralized shared-credential models** are tracked as future work in [ROADMAP.md](../ROADMAP.md).

## External Worker Orchestration Pattern

This fork documents an optional coordinator-to-worker pattern using file-based IPC:

- dispatch files: coordinator -> worker manager
- result files: worker manager -> coordinator
- nudge/heartbeat files: liveness and completion signaling

This is an operating pattern, not a hard dependency for core NanoClaw runtime.
See [ARCHITECTURE.md](./ARCHITECTURE.md#6-code-orchestration-supervisor).

## Related Docs

- [START_HERE.md](./START_HERE.md)
- [SPEC.md](./SPEC.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [SECURITY.md](./SECURITY.md)
- [ROADMAP.md](../ROADMAP.md)
