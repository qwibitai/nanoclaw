---
name: refresh-oauth
description: Request the host to refresh the Claude OAuth token. Use when you encounter auth errors mid-session (e.g., a subagent fails with 401/expired token). For container startup auth failures, the host retries automatically — this skill is for errors that happen while you're already running.
---

# Refresh OAuth Token

## When to use

Use this when you're already running and hit an auth error — for example, a subagent spawn fails with 401 or "token expired". You don't need this for startup failures; the host handles those automatically.

## How to trigger

Write a JSON file to the IPC tasks directory:

```bash
echo '{"type":"refresh_oauth"}' > /workspace/ipc/tasks/refresh-oauth-$(date +%s).json
```

The host picks this up within a few seconds. If the token is still fresh, it syncs it from `~/.claude/.credentials.json` into `.env`. If expired, it invokes the Claude CLI to refresh the token first, then syncs the new one. See `scripts/oauth/README.md` for details.

## After triggering

Wait ~5 seconds for the host to process the IPC file and update `.env`, then retry the failed operation.

## If refresh doesn't help

The user may need to re-authenticate with `claude login`.
