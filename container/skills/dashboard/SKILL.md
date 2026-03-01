---
name: dashboard
description: Rebuild and restart the Next.js web dashboard after editing files in /workspace/dashboard. Use after making changes to dashboard source code.
allowed-tools: Bash(restart-dashboard:*)
---

# Dashboard Management

The dashboard runs on the host as a separate Next.js app (port 3000). Source files are mounted at `/workspace/dashboard` and can be edited directly, but building and restarting must happen on the host via IPC.

## After editing dashboard files

Run the restart script to rebuild and restart the dashboard service:

```bash
/workspace/skills/dashboard/restart-dashboard.sh
```

The script sends a rebuild request via IPC, waits for the host to run `npm run build` and restart the launchd service, then prints the build output. It exits 0 on success, 1 on failure.
