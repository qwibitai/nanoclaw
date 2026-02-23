# Local Review Handoff

Mandatory whenever the user asks to test locally, or when reporting "ready for user review".

## Goal

Prepare the app in `NanoClawWorkspace` and provide a runnable handoff so the user can test without recloning.

## Required Steps

1. Validate worker evidence
- Completion contract is present and valid (`run_id`, branch, commit, tests, risk).
- Andy review decision is `approve` before starting user handoff.
- If evidence is incomplete, return `rework` instead of handoff.

2. Stage review workspace
- Use path `/workspace/extra/repos/<repo-name>` (host path: `~/Documents/remote-claude/NanoClawWorkspace/<repo-name>`).
- If repository is missing in `NanoClawWorkspace`, clone it before preflight checks.
- Ensure branch and commit match the approved worker output.
- Never run preflight or handoff from a different branch than the one containing the approved fix under test.
- Sync explicitly from remote before checks (`git fetch`, checkout approved branch/commit, `git pull --ff-only` when applicable).
- Do not author new product feature code during handoff prep.

3. Prepare run instructions
- Derive exact install/start command from repository scripts.
- Prefer deterministic commands (`npm ci` over `npm install` when lockfile exists).
- Provide exact commands the user should run locally (install/start/health/stop).
- Provide stop command.

4. Preflight verification (mandatory)
- Run install/build checks in the staged workspace and record result.
- Run a short server start smoke test and a health/readiness probe.
- Verify container lane is not duplicated before declaring readiness:
  - `container ls -a | rg "nanoclaw-andy-developer|nanoclaw-jarvis"`
  - If duplicate same-lane containers are unexpectedly `running`, run recovery from `docs/troubleshooting/DEBUG_CHECKLIST.md` and re-check.
- If build fails or server does not start, do not mark ready; send blocker details and delegate fix.

5. Readiness gate
- Do not say "ready for user review" unless the handoff block below is included.
- Do this by default whenever review readiness is claimed; do not wait for user reminders.
- If runtime limits prevent persistent server hosting in Andy lane, state that clearly and provide the host-run commands.

## Mandatory Handoff Block

Use this structure in the user-facing response:

```text
Local Review Handoff
- Repo path: ~/Documents/remote-claude/NanoClawWorkspace/<repo-name>
- Branch: <branch>
- Commit: <sha>
- Build check: <passed/failed + command>
- Server start check: <passed/failed + command/probe>
- Install: <exact command>
- User start: <exact command user runs locally>
- Health: <exact command>
- Stop: <exact command>
- Notes: <env vars, seed data, known limitations, route to open (e.g. /dashboard)>
```

## Prohibited

- Claiming review readiness without verified startup checks and user-run commands.
- Asking the user to clone the repository again when it is already staged in `NanoClawWorkspace`.
