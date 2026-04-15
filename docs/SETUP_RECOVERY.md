# Setup Recovery Guide

Use this guide when NanoClaw installs partially, starts but does not route work, or drifts after an upgrade.

## Fast Health Checks

From the repo root:

```bash
npm run smoke:runtime
npm run smoke:health
```

If `smoke:runtime` fails, fix tmux before troubleshooting anything else.

## Rebuild The Executables

```bash
npm ci
npm --prefix container/agent-runner ci
npm run build:core
npm run build:agent-runner
```

## Service Restart

Linux:

```bash
systemctl --user restart nanoclaw
```

macOS:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

After restart, verify:

```bash
npm run smoke:health
```

## Common Failure Modes

### tmux missing

- Install `tmux`.
- Re-run `npm run smoke:runtime`.

### Agent-runner stale or missing

- Re-run `npm --prefix container/agent-runner ci`.
- Re-run `npm run build:agent-runner`.

### Service is up but degraded

- Check `GET /health` output for `degradedReasons`.
- Confirm at least one channel is instantiated and connected.
- Confirm Agency HQ dependencies are reachable if dispatch features are enabled.

### Dispatch blocked after repeated failures

If a task is stuck behind `dispatch_blocked_until`, clear it in Agency HQ and set the task back to `ready`.

## Minimal Validation Set

```bash
npm run format:check
npm run lint
npm run lint:migrations
npm run typecheck
npm run test
```

## Historical Docs

Some older docs in `docs/` still describe Docker or Apple Container paths. Treat them as reference material unless they explicitly say they match the tmux runtime.
