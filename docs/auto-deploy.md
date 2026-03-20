# Auto-Deploy on Merge

> **Living document.** Updated as the deployment system evolves.
> Epic: [Garsson-io/kaizen#228](https://github.com/Garsson-io/kaizen/issues/228) (Deployment Automation horizon)
> Issue: [Garsson-io/kaizen#90](https://github.com/Garsson-io/kaizen/issues/90)

## How It Works

When code merges to main and an agent (or human) runs `git merge` in the main checkout, the `.husky/post-merge` hook fires and triggers `scripts/deploy.sh` in the background.

```
PR merges on GitHub
        |
Agent runs: git -C $MAIN_CHECKOUT fetch origin main && git -C $MAIN_CHECKOUT merge --ff-only origin/main
        |
.husky/post-merge fires (main checkout only, main branch only)
        |
scripts/deploy.sh runs in background:
  1. Detect what changed (src/, package.json, Dockerfile, docs-only)
  2. npm install (if package.json changed)
  3. npm run build (if source changed)
  4. ./container/build.sh (if Dockerfile changed)
  5. systemctl --user restart nanoclaw
  6. Health check (wait for service active, up to 12s)
  7. Notify on Telegram
```

## Safety Guarantees

- **Build before restart.** If the build fails, the old version keeps running.
- **Health check after restart.** If the service doesn't come up within 12s, Telegram notification fires.
- **Worktree guard.** Deploy only runs in the main checkout on the main branch. Merges in worktrees are ignored.
- **Background execution.** The post-merge hook runs deploy.sh via `nohup &` so `git merge` returns immediately.
- **Docs-only skip.** Changes to `.md` files only don't trigger build or restart.

## Failure Modes

| Failure               | Behavior                                     | Notification                          |
| --------------------- | -------------------------------------------- | ------------------------------------- |
| Build fails           | Old version keeps running                    | "Auto-deploy FAILED: build error"     |
| Container build fails | Harness restarts, agents may use stale image | "WARNING: container build failed"     |
| Restart fails         | Service may be down                          | "Auto-deploy FAILED: restart error"   |
| Health check fails    | Service started but not responding           | "FAILED: service not healthy"         |
| Docs-only merge       | No build, no restart                         | "No code changes — no restart needed" |

## Manual Usage

```bash
# Full deploy (same as post-merge hook triggers)
./scripts/deploy.sh

# Build only, no restart (useful for testing)
./scripts/deploy.sh --build-only

# Dry run — show what would happen
./scripts/deploy.sh --dry-run
```

## Environment Variables

| Variable              | Default           | Purpose                                 |
| --------------------- | ----------------- | --------------------------------------- |
| `DEPLOY_SKIP_RESTART` | unset             | Skip systemctl restart (for CI/testing) |
| `DEPLOY_SKIP_NOTIFY`  | unset             | Skip Telegram notification              |
| `DEPLOY_LOG`          | `logs/deploy.log` | Log file path                           |

## Logs

Deploy logs are written to `logs/deploy.log` (gitignored). Each deploy is timestamped:

```
[2026-03-20T19:30:00+02:00] deploy.sh starting (flags: )
[2026-03-20T19:30:00+02:00] Deploy plan: npm_install=false build=true container=false restart=true
[2026-03-20T19:30:05+02:00] build: done
[2026-03-20T19:30:07+02:00] restart: service restarted
[2026-03-20T19:30:09+02:00] health check: service is active
[2026-03-20T19:30:09+02:00] deploy.sh completed successfully
```

## Current State (Deployment Automation Horizon)

This implements **L2** of the Deployment Automation horizon:

- **L0**: Manual build + restart (no procedure)
- **L1**: Documented procedure with checklist (in CLAUDE.md)
- **L2**: Auto-build + restart on merge, human triggers git pull **<-- CURRENT**
- **L3**: Webhook listener auto-pulls on GitHub push (no agent needed)
- **L4**: Staging validation before production promotion
- **L5**: Canary deploys with automatic rollback

## Future Work

- **L3**: GitHub webhook or systemd path unit that auto-pulls when origin/main advances — removes the need for an agent to run `git merge`
- **Container build optimization**: Currently builds synchronously; could be backgrounded or cached
- **Rollback**: If health check fails, automatically revert to previous build
- **Staging**: Deploy to staging first, run smoke tests, then promote
