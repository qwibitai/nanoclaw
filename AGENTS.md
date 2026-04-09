# NanoClaw

## What This Repo Is

NanoClaw is a single-process Node.js personal assistant runtime with skill-based channels.  
Messages are ingested from channels, persisted in SQLite, then routed to Codex agents (container-first, optional host runtime).

Primary surfaces:
- `src/index.ts`: orchestrator loop and runtime wiring
- `src/group-queue.ts`: per-group queue and retry behavior
- `src/container-runner.ts`: container execution path
- `src/container-runtime.ts`: host/container runtime selection and health checks
- `src/session-commands.ts`: host-managed slash commands (`/compact`, `/new`, `/model`)
- `src/db.ts`: persistence for groups/messages/tasks/sessions

## Mandatory Read Order

1. [README.md](README.md)
2. [WORKFLOW.md](WORKFLOW.md)
3. [docs/FACTORY.md](docs/FACTORY.md)
4. [docs/QUALITY.md](docs/QUALITY.md)
5. [CONTRIBUTING.md](CONTRIBUTING.md)

Use `python3 .codex/scripts/stage_orchestrator.py` to get current phase commands and required artifacts.

## Runtime Modes

- `AGENT_RUNTIME=container` (default): isolated Linux container execution.
- `AGENT_RUNTIME=host`: OpenClaw-style host execution with host-level tool access.

Important constraints:
- Session reset command `/new` clears persisted session state but preserves group model override.
- Transcript archive during `/new` reset is best-effort and must not block reset success.
- Per-group memory remains isolated in `groups/<folder>/`.

## Hard Gates

Before merge or release:

1. `npm run build`
2. `npm test`
3. `python3 .codex/scripts/verify.py`
4. `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`

If running full factory mode (active run in `.factory/run.json`):

1. `python3 .codex/scripts/validate_work.py`
2. Required artifacts must exist for decomposition, testing, and review.
3. `python3 .codex/scripts/pr_ready.py` must pass.

Do not introduce Qodo dependencies or references in this repository.
