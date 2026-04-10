---
name: cloud-coding-agent
description: Run long-running coding tasks in cloud environments (Claude Code or Codex), with session teleporting and automatic PR creation.
user-invocable: true
metadata: {"clawdbot":{"emoji":"☁️","requires":{"anyBins":["claude","codex"]}}}
---

# Cloud Coding Agent Skill

Patterns for running coding tasks in **cloud environments** using Claude Code and Codex, with session teleporting and PR workflows.

## Routing: Cloud vs Local

**Use THIS skill (cloud-coding-agent) when:**
- Task will take 30+ minutes (offload to cloud)
- User wants to disconnect while task runs
- Need to create PR directly from cloud
- Running multiple parallel cloud tasks
- User explicitly says "cloud", "remote", or "background in cloud"

**Use `coding-agent` skill instead when:**
- Task is quick (< 30 minutes)
- Need PTY mode for interactive terminal (`pty:true`)
- Using Clawdbot's bash/process tools directly
- Need `--yolo` mode for Codex
- Reviewing PRs locally
- Using OpenCode or Pi Coding Agent
- User explicitly says "local", "here", or "on this machine"

> **For local execution patterns**, see the `coding-agent` skill which covers:
> - PTY mode (`pty:true`) for interactive CLIs
> - Bash tool parameters (workdir, background, timeout)
> - Process tool actions (list, poll, log, write, submit, kill)
> - Git worktree patterns for parallel local work
> - Progress updates and auto-notify patterns

---

## Claude Code Local Sessions

For local Claude Code sessions with PTY support (recommended for interactive CLI):

### Quick One-Shot Task

```bash
# Simple task with --print mode (non-interactive)
claude --print "Add error handling to the API calls in src/api.ts"

# In a git repo (required for context)
cd ~/project && claude --print "Refactor the database queries"
```

### Background Session with tmux (Recommended)

```bash
# Create persistent tmux session
SESSION="claude-task-$(date +%s)"
tmux new-session -d -s "$SESSION" -c ~/project "bash"

# Run claude in the tmux session
tmux send-keys -t "$SESSION" "claude --print 'Your long-running task here' 2>&1 | tee task.log" C-m

# Monitor progress
tmux attach -t "$SESSION"
# Or check log: tail -f ~/project/task.log
```

### Resume Previous Session

```bash
# Resume most recent session in current directory
claude --continue

# Resume specific session by ID
claude --resume <session-id>
```

## Claude Code Cloud

Claude Code on the web runs tasks asynchronously on Anthropic's secure cloud infrastructure.

**Requirements:**
- Pro/Max/Team/Enterprise subscription
- GitHub repo connected at [claude.ai/code](https://claude.ai/code)
- Trust prompt acceptance on first use

### Send Task to Cloud

**From inside Claude Code (interactive session):**
```bash
# Prefix message with & to send to cloud
& Fix the authentication bug in src/auth/login.ts
```

**From command line:**
```bash
claude --remote "Fix the authentication bug in src/auth/login.ts"
```

The task runs in the cloud while you continue working locally.

### Monitor Cloud Tasks

```bash
# Inside Claude Code
/tasks           # List all background/cloud tasks
                 # Press 't' to teleport into a task

# Select which environment to use for cloud tasks
/remote-env
```

### Teleport Cloud Session to Local

**From inside Claude Code:**
```bash
/teleport        # Interactive picker of cloud sessions
/tp              # Shorthand
```

**From command line:**
```bash
claude --teleport              # Interactive picker
claude --teleport <session-id> # Specific session
```

**Requirements for teleporting:**
- Clean git state (no uncommitted changes)
- Must be in correct repository (not a fork)
- Branch must be pushed to remote
- Same Claude.ai account

### Cloud Session Workflow

```
1. Start task: & Your task description
2. Monitor: /tasks (or claude.ai/code or iOS app)
3. Cloud executes: clones repo, runs task, pushes branch
4. Review: diff view on web, iterate with comments
5. Complete: teleport back OR create PR from web
```

### Best Practices

**Plan locally, execute remotely:**
```bash
# Start in plan mode to collaborate on approach
claude --permission-mode plan

# Once plan is ready, send to cloud
& Execute the migration plan we discussed
```

**Run tasks in parallel:**
```bash
& Fix the flaky test in auth.spec.ts
& Update the API documentation
& Refactor the logger to use structured output
# Each creates independent cloud session
```

## Codex Local Sessions

For local Codex sessions (similar patterns to Claude):

### Quick One-Shot Task

```bash
# Non-interactive execution with auto-approval (--full-auto)
codex exec --full-auto "Add input validation to the form handlers"

# In a git repo
cd ~/project && codex exec --full-auto "Refactor the database layer"
```

**Note**: Use `--full-auto` for automatic file writes without confirmation prompts.

### Background Session with tmux

```bash
SESSION="codex-task-$(date +%s)"
tmux new-session -d -s "$SESSION" -c ~/project "bash"
tmux send-keys -t "$SESSION" "codex exec --full-auto 'Your long-running task' 2>&1 | tee task.log" C-m
```

### Resume Session

```bash
# Resume most recent session
codex resume --last

# Interactive picker
codex resume
```

## Codex Cloud (Experimental)

Codex has cloud execution capabilities (marked EXPERIMENTAL in v0.77.0).

### Prerequisites

```bash
# Login required for cloud features
codex login

# Browse available environments
codex cloud
```

### Submit Task to Cloud

```bash
# Submit task using repo name as environment
codex cloud exec --env owner/repo "Build REST API for user management"
# Returns: https://chatgpt.com/codex/tasks/task_e_XXXXX

# Specify branch
codex cloud exec --env owner/repo --branch feature/my-feature "Implement OAuth2"
```

### Monitor and Apply Cloud Tasks

```bash
# Check task status (use task ID from exec output)
codex cloud status task_e_XXXXX

# View diff from cloud task
codex cloud diff task_e_XXXXX

# Apply cloud task changes locally
codex cloud apply task_e_XXXXX
```

### GitHub Integration

- Comment `@codex fix this bug` on GitHub issues
- Codex creates a PR automatically (requires GitHub App setup)

## Comparison

| Feature | Claude Code | Codex |
|---------|-------------|-------|
| Local exec | `claude --print "task"` | `codex exec --full-auto "task"` |
| Resume session | `claude --continue` | `codex resume` |
| Send to cloud | `& task` or `claude --remote` | `codex cloud exec --env X` |
| Monitor cloud | `/tasks` or claude.ai/code | `codex cloud status <id>` |
| Bring to local | `claude --teleport` | `codex cloud apply <id>` |
| @mention on GitHub | `@claude` (via Action) | `@codex` |

## Recommended Workflows

### Long-Running Feature Development (Local)

```bash
# Create persistent tmux session for long task
SESSION="feature-$(date +%s)"
tmux new-session -d -s "$SESSION" -c ~/project "bash"

# Run Claude or Codex
tmux send-keys -t "$SESSION" "claude --print 'Implement user dashboard per docs/dashboard.md' 2>&1 | tee dashboard.log" C-m

# Check progress anytime
tail -f ~/project/dashboard.log
# Or attach: tmux attach -t "$SESSION"
```

### Parallel Tasks with tmux

```bash
# Create multiple sessions for parallel work
for task in "auth-tests" "db-refactor" "api-docs"; do
  SESSION="task-$task-$(date +%s)"
  tmux new-session -d -s "$SESSION" -c ~/project "bash"
done

# Start different tasks in each
tmux send-keys -t task-auth-tests-* "claude --print 'Add unit tests for auth module' | tee auth-tests.log" C-m
tmux send-keys -t task-db-refactor-* "codex exec 'Refactor database queries' | tee db-refactor.log" C-m

# Monitor all with: tmux ls
```

### Issue-Driven Development

```bash
# Fetch issue context and run task
ISSUE=$(gh issue view 789 --json title,body --jq '"\(.title)\n\n\(.body)"')
claude --print "Fix this GitHub issue: $ISSUE" 2>&1 | tee issue-789.log
```

## Environment Setup

### Codex Cloud Environments

Codex cloud requires environment setup through the web UI or API:

```bash
# Login first (required)
codex login

# Browse available environments interactively
codex cloud

# Environments are linked to GitHub repos
```

### Claude Code Setup

```bash
# Verify CLI works
claude --version

# For cloud features, visit claude.ai/code
# and connect your GitHub account
```

## Automation Scripts

Located in `scripts/` directory:

### auto-cloud-task.sh

Routes tasks to Claude or Codex based on preference:

```bash
./scripts/auto-cloud-task.sh "Your task description" [claude|codex]
```

### poll-cloud-completion.sh

Polls Codex cloud task until completion:

```bash
./scripts/poll-cloud-completion.sh <task-id> [--auto-apply]
```

### teleport-and-pr.sh

For future Claude teleport support:

```bash
./scripts/teleport-and-pr.sh [session-id] --title "PR Title"
```

## Tested Commands (v2.1.19 Claude / v0.77.0 Codex)

| Command | Status | Notes |
|---------|--------|-------|
| `claude --print "task"` | ✅ Works | Non-interactive, writes files |
| `claude --continue` | ✅ Works | Resume previous session |
| `claude --resume <id>` | ✅ Works | Resume specific session |
| `claude --remote "task"` | ✅ Works | Creates cloud session, returns URL |
| `claude --teleport` | ✅ Works | Interactive picker of cloud sessions |
| `claude --teleport <id>` | ✅ Works | Teleport specific session |
| `& task` (inside Claude) | 🔬 Untested | Send to cloud from interactive |
| `/tasks` | 🔬 Untested | Lists cloud/background tasks |
| `codex exec "task"` | ⚠️ Partial | Shows code but may not write |
| `codex exec --full-auto "task"` | ✅ Works | Auto-approves file writes |
| `codex resume` | ✅ Works | Interactive session picker |
| `codex cloud` | ✅ Works | TUI for browsing cloud tasks |
| `codex cloud exec --env owner/repo` | ✅ Works | Submits task, returns URL |
| `codex cloud status <task_id>` | ✅ Works | Shows task status |
| `codex cloud diff <task_id>` | ✅ Works | Shows task diff |
| `codex cloud apply <task_id>` | ✅ Works | Applies diff locally |

## Tips

- Use tmux for persistent background sessions
- Capture output with `| tee logfile.log`
- Include clear success criteria in task descriptions
- For complex tasks, break into smaller sessions
- Check progress with `tail -f` or tmux attach
