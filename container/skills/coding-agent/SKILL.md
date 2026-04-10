---
name: coding-agent
description: >
  Delegate coding tasks to subagents or run Claude Code/Codex in tmux sessions.
  Use the Task tool for focused multi-step coding work. Use tmux for long-running
  interactive sessions, parallel worktree-based fixes, and PR reviews. NOT for
  simple single-file edits — do those directly.
user-invocable: true
---

# /coding-agent — Delegate Coding Work

Delegate coding tasks to subagents or run Claude Code/Codex in separate tmux sessions on the host. Choose the right pattern for the job.

## When to use each pattern

| Situation | Pattern |
|-----------|---------|
| Bounded task with clear spec (fix bug, implement feature, write tests) | Task tool (subagent) |
| Long-running interactive session, needs persistence | tmux + `claude --dangerously-skip-permissions` |
| PR review — checkout and inspect | tmux + clone to `/tmp` |
| Multiple independent fixes in parallel | tmux + git worktrees |
| Claude Code capped or erroring | tmux + Codex fallback |

---

## Pattern 1: Task Tool (Primary Pattern)

Use the `Task` tool to delegate focused coding work to a subagent. The subagent runs inside the same SDK session with full tool access (Bash, Read, Write, Edit, Glob, Grep). This is the default choice for most coding tasks.

### When to use

- Implement a feature, fix a bug, write tests
- Refactor a module or file
- Analyse a codebase and produce a report
- Any multi-step work that needs tool use but doesn't require an interactive terminal

### How to invoke

```
Task({
  description: "Fix the rate-limiting bug in the API gateway",
  prompt: "..."
})
```

### Prompt template

Write the Task prompt as a complete standalone brief. The subagent has no memory of the conversation that spawned it. Include:

1. **What to do** — specific, unambiguous objective
2. **Where to work** — directory, repo, relevant files
3. **Constraints** — branch to use, things not to touch, style rules
4. **Definition of done** — what success looks like
5. **How to report back** — summarise files changed, tests run, result

```
Task({
  description: "Implement retry logic for the Slack webhook sender",
  prompt: """
    You are a backend engineer implementing retry logic for a webhook sender.

    Repository: /workspace/project
    Target file: src/channels/slack.ts — the `sendWebhook` function

    Task:
    - Add exponential backoff retry (max 3 attempts, base delay 500ms)
    - Only retry on 429 and 5xx HTTP responses
    - Preserve the existing function signature
    - Do NOT modify other files

    Constraints:
    - TypeScript strict mode is on
    - No new dependencies — use built-in fetch and setTimeout
    - Keep the existing error-logging pattern (console.error with context object)

    When done:
    - Run `npm run build` to verify compilation
    - Summarise: files changed, retry logic approach, any edge cases handled
  """
})
```

### Multi-subagent parallelism

Run independent tasks simultaneously. Do NOT chain tasks that depend on each other's output — wait for the first to complete.

```
// Run two independent fixes in parallel
Task({ description: "Fix auth timeout", prompt: "..." })
Task({ description: "Fix typos in CLAUDE.md", prompt: "..." })

// Then, once both complete, run the dependent task
Task({ description: "Integration test for auth + config", prompt: "..." })
```

---

## Pattern 2: tmux — Long-running Claude Code Session

For interactive, open-ended, or very long coding sessions that would exhaust context in a subagent. Claude Code runs on the host with full filesystem access and persistent terminal state.

### When to use

- Session expected to run for 30+ minutes
- Work requires watching logs or waiting for build pipelines
- You need to send follow-up prompts mid-session
- Persistence matters (survives network drops)

### Standard launch sequence

```bash
# 1. Generate a session name
TIMESTAMP=$(date +%s)
SESSION="agent-${TIMESTAMP}"
WORK_DIR="/path/to/repo"   # absolute path always

# 2. Create tmux session and start Claude Code
tmux new-session -d -s "$SESSION" -c "$WORK_DIR"
tmux send-keys -t "$SESSION" "claude --dangerously-skip-permissions" C-m

# 3. Wait for Claude to initialise (check for prompt, not just sleep)
sleep 3
tmux capture-pane -p -t "$SESSION" -S -30  # verify it's ready

# 4. Send the task (use -l flag for safe literal sending)
tmux send-keys -t "$SESSION" -l "Your full task description here"
tmux send-keys -t "$SESSION" C-m

# 5. Report session info back to user
echo "Session: $SESSION"
echo "Monitor: tmux attach -t $SESSION"
echo "Capture: tmux capture-pane -p -t $SESSION -S -100"
echo "Kill:    tmux kill-session -t $SESSION"
```

### Check progress without blocking

```bash
# Tail the last 50 lines of output
tmux capture-pane -p -t "$SESSION" -S -50

# Check if Claude is still working (look for spinner or output activity)
tmux capture-pane -p -t "$SESSION" -S -5
```

### Send a follow-up prompt

```bash
# Only send follow-up when the previous task is clearly done
tmux send-keys -t "$SESSION" -l "Now run the test suite and fix any failures"
tmux send-keys -t "$SESSION" C-m
```

### Headless (non-interactive) mode

For scripted work where you want output captured to a log file rather than interactive:

```bash
TIMESTAMP=$(date +%s)
SESSION="agent-${TIMESTAMP}"
WORK_DIR="/path/to/repo"
LOG="/tmp/agent-${TIMESTAMP}.log"

tmux new-session -d -s "$SESSION" -c "$WORK_DIR"
tmux send-keys -t "$SESSION" \
  "claude -p 'Your full task prompt here' --dangerously-skip-permissions 2>&1 | tee $LOG" C-m

echo "Output logged to: $LOG"
echo "Monitor: tmux attach -t $SESSION"
```

---

## Pattern 3: PR Review

Review a pull request without touching the live project. Always clone or checkout to `/tmp`.

```bash
TIMESTAMP=$(date +%s)
SESSION="pr-review-${TIMESTAMP}"
PR_NUMBER="42"
REPO="owner/repo"
WORK_DIR="/tmp/pr-review-${TIMESTAMP}"

# Clone and checkout the PR branch
git clone "https://github.com/${REPO}.git" "$WORK_DIR"
cd "$WORK_DIR"
gh pr checkout "$PR_NUMBER"

# Start Claude Code in that directory
tmux new-session -d -s "$SESSION" -c "$WORK_DIR"
tmux send-keys -t "$SESSION" "claude --dangerously-skip-permissions" C-m
sleep 3

# Send the review brief
tmux send-keys -t "$SESSION" -l \
  "Review PR #${PR_NUMBER}. Check correctness, security, test coverage, and style. Summarise findings."
tmux send-keys -t "$SESSION" C-m

echo "Review session: $SESSION"
echo "Attach: tmux attach -t $SESSION"
```

**Rules for PR reviews:**
- NEVER run the agent inside `/workspace/project` or the live NanoClaw dir
- Clone to `/tmp/pr-review-{timestamp}` — isolated, disposable
- Clean up after: `rm -rf /tmp/pr-review-${TIMESTAMP}`

---

## Pattern 4: Parallel Fixes with Git Worktrees

Work on multiple issues simultaneously without branch-switching conflicts. Each worktree is an independent checkout of the repo on its own branch.

```bash
REPO_DIR="/workspace/project"    # or wherever the main repo lives
BASE_BRANCH="main"

# Create two worktrees for two independent issues
git -C "$REPO_DIR" worktree add /tmp/fix-issue-101 -b fix/issue-101 "$BASE_BRANCH"
git -C "$REPO_DIR" worktree add /tmp/fix-issue-102 -b fix/issue-102 "$BASE_BRANCH"

# Spawn a Claude Code session per worktree
STAMP=$(date +%s)

tmux new-session -d -s "agent-101-${STAMP}" -c "/tmp/fix-issue-101"
tmux send-keys -t "agent-101-${STAMP}" "claude --dangerously-skip-permissions" C-m
sleep 3
tmux send-keys -t "agent-101-${STAMP}" -l "Fix issue #101: [description]"
tmux send-keys -t "agent-101-${STAMP}" C-m

tmux new-session -d -s "agent-102-${STAMP}" -c "/tmp/fix-issue-102"
tmux send-keys -t "agent-102-${STAMP}" "claude --dangerously-skip-permissions" C-m
sleep 3
tmux send-keys -t "agent-102-${STAMP}" -l "Fix issue #102: [description]"
tmux send-keys -t "agent-102-${STAMP}" C-m

echo "Sessions running:"
echo "  tmux attach -t agent-101-${STAMP}"
echo "  tmux attach -t agent-102-${STAMP}"
```

**Cleaning up worktrees when done:**

```bash
git -C "$REPO_DIR" worktree remove /tmp/fix-issue-101
git -C "$REPO_DIR" worktree remove /tmp/fix-issue-102
```

---

## Pattern 5: Codex Fallback

If Claude Code is rate-capped or unavailable, fall back to Codex CLI. Same tmux pattern — swap the command.

### Check availability first

```bash
# Check Claude Code
claude --version 2>/dev/null && echo "CC: available" || echo "CC: not found"

# Check Codex
which codex 2>/dev/null && echo "Codex: available" || echo "Codex: not installed"
```

### Codex session (full-auto mode)

```bash
TIMESTAMP=$(date +%s)
SESSION="codex-${TIMESTAMP}"
WORK_DIR="/path/to/repo"

tmux new-session -d -s "$SESSION" -c "$WORK_DIR"
tmux send-keys -t "$SESSION" \
  "codex exec --full-auto 'Your task description'" C-m

echo "Codex session: $SESSION"
echo "Capture: tmux capture-pane -p -t $SESSION -S -50"
```

### Codex interactive mode (yolo)

```bash
tmux new-session -d -s "$SESSION" -c "$WORK_DIR"
tmux send-keys -t "$SESSION" "codex --yolo" C-m
sleep 3
tmux send-keys -t "$SESSION" -l "Your task description"
tmux send-keys -t "$SESSION" C-m
```

### Fallback decision tree

```
Task tool → preferred for all bounded work
    ↓ Claude Code session needed (long/interactive)
tmux + claude --dangerously-skip-permissions
    ↓ CC capped or erroring after 2 retries
tmux + codex exec --full-auto
    ↓ Codex not installed
Report to user: install codex or retry later
```

---

## Session Management

### List all running agent sessions

```bash
tmux list-sessions 2>/dev/null | grep -E "^(agent|codex|pr-review)-"
```

### Kill a specific session

```bash
tmux kill-session -t "agent-${TIMESTAMP}"
```

**Never use `tmux kill-server` — it destroys all sessions across all users and projects.**

### Session naming conventions

| Prefix | Use |
|--------|-----|
| `agent-{timestamp}` | Claude Code general coding session |
| `codex-{timestamp}` | Codex fallback session |
| `pr-review-{timestamp}` | PR review checkout |

---

## Rules

1. **Task tool is the default.** Only reach for tmux if the task is genuinely long-running or interactive.

2. **PR reviews always use `/tmp`.** Never run an agent inside `/workspace/project` for review work — contamination risk.

3. **Never block on tmux.** After starting a session, report the session name and move on. Use `tmux capture-pane` to check progress, never `tmux attach` from within tool calls.

4. **One task per session.** Don't reuse a tmux session for unrelated work. Each session has a clear purpose.

5. **Absolute paths only.** tmux sessions do not inherit your working directory reliably. Always use `-c "$WORK_DIR"` with an absolute path when creating sessions.

6. **Literal key sending.** Use `tmux send-keys -t SESSION -l "text"` (the `-l` flag) for any prompt text containing special characters. Without `-l`, characters like `$`, `{`, `}`, `*` will be interpreted by the shell.

7. **No `bash pty:true`.** That is an OpenClaw-specific API that does not exist here. All interactive terminal work goes through tmux.

8. **No `process action:log`.** Also OpenClaw-only. Use `tmux capture-pane -p -t SESSION -S -N` to read session output.

9. **Codex check before use.** Always run `which codex` before attempting a Codex session. Don't assume it's installed.

10. **Clean up worktrees.** After merging or discarding worktree work, remove it: `git worktree remove /tmp/fix-{issue}`.
