# NanoClaw Worker Architecture

## Worker Startup Context

At startup, each worker gets:

**From `/workspace/group/` (worker memory):**

- `CLAUDE.md` — identity, GitHub account, workspace layout
- Notes and memory from previous sessions

**From `/home/node/.claude/` (Claude runtime):**

- Previous session history (if resuming)
- `settings.json` — agent teams enabled, auto-memory on
- Skills synced from `container/skills/`
- Rules synced from `container/rules/`

**From `/workspace/ipc/`:**

- `current_tasks.json` — NanoClaw scheduled tasks
- Follow-up messages from Andy

**From `/workspace/extra/repos/`:**

- Dedicated space to clone GitHub repos

**Gap:** Workers know who they are and where repos go, but have no workflow knowledge — no git/PR patterns, no GitHub auth patterns, no execution principles. These should be baked into the container image.

---

## Persistence Zones

| What | Persists Where | Container Path |
|------|----------------|----------------|
| Worker memory, notes, docs | `groups/jarvis-worker-1/` | `/workspace/group/` |
| Claude session history | `store/sessions/jarvis-worker-1/.claude/` | `/home/node/.claude/` |
| Cloned repos, code changes | `NanoClawWorkspace/` | `/workspace/extra/repos/` |

**Gone on container exit:**

- `/tmp/` — recompiled agent-runner code
- Any files written outside mounted paths
- Installed packages, cached data

---

## Worker Capabilities Across Sessions

**Can:**

- Remember decisions and notes via `/workspace/group/`
- Resume a Claude session (same context window continuation)
- Find repos cloned in a previous session via `/workspace/extra/repos/`

**Cannot:**

- Remember anything written to `/tmp/` or the container filesystem
- Carry over installed tools (everything outside the image is gone)

---

## Workflow Docs to Bake Into Image

Source: `~/.jarvis/runtime_workflow/docs/workflow/`

- `git-pr-workflow.md`
- `github-account-isolation.md`
- `execution-loop.md`

Copy into `nanoclaw/container/` and reference from worker `CLAUDE.md` Docs Index.
