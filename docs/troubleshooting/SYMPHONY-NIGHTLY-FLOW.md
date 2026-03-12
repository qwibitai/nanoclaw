# Symphony Nightly Improvement - Troubleshooting Guide

## Overview

This guide helps debug the nightly improvement agent dispatch flow via Symphony.

## Architecture

```
Linear (Ready) → Symphony Daemon → Worktree → Claude CLI → Agent Execution
```

## Common Issues & Solutions

### 1. Issue Not in Ready State

**Symptom**: `symphony_list_ready_issues` returns 0 issues

**Debug**:

```bash
# Check Linear state
bash scripts/workflow/run-with-env.sh npx tsx scripts/workflow/symphony.ts list-ready --project-key nanoclaw
```

**Solution**: Move issue to "Ready" state in Linear.

---

### 2. Missing Required Issue Sections

**Symptom**: "Issue description is missing required sections"

**Required Sections**:

- Problem Statement
- Scope
- Acceptance Criteria
- Required Checks
- Required Evidence
- Blocked If
- Symphony Routing (must include "Execution Lane")

**Debug**:

```bash
# Check issue has all sections
grep -E "^## " /path/to/issue.md
```

**Solution**: Add missing sections to Linear issue description.

---

### 3. Missing "Blocked" State

**Symptom**: "Linear team NAN is missing state 'Blocked'"

**Debug**:

```bash
# List team states — use run-with-env.sh to load .env correctly
# NOTE: `source .env && curl` does NOT work in subshells; use this pattern instead
bash scripts/workflow/run-with-env.sh bash -c 'curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"query { teams(first: 10) { nodes { key name states { nodes { name type } } } } }\"}"'
```

**Solution**: Create "Blocked" state in Linear team settings.

---

### 4. Backend Command Not Found

**Symptom**: `Backend exited with code 127` or `command not found`

**Debug**:

```bash
# Check which backend
grep NANOCLAW_SYMPHONY_.*_COMMAND .env
```

**Common Solutions**:

- Use full path: `PATH=$HOME/.local/bin:$PATH claude`
- Test command: `~/.local/bin/claude --help`

---

### 5. Claude Code Nested Session Error

**Symptom**: "Claude Code cannot be launched inside another Claude Code session"

**Debug**: Check if `CLAUDECODE` env var is being passed

**Solution**: Unset in `symphony-dispatch.ts`:

```typescript
const { CLAUDECODE: _omit, ...envWithoutClaudeCode } = { ...process.env, ...env };
const child = spawn('/bin/sh', ['-lc', wrapped], {
  env: envWithoutClaudeCode,
});
```

---

### 6. Unknown CLI Option

**Symptom**: `error: unknown option '--workdir'`

**Debug**: Check Claude CLI help

```bash
~/.local/bin/claude --help
```

**Solution**: Update command in `.env`:

```
# Wrong:
NANOCLAW_SYMPHONY_CLAUDE_CODE_COMMAND='claude --workdir {workspace}'

# Correct (for non-interactive):
NANOCLAW_SYMPHONY_CLAUDE_CODE_COMMAND='PATH=$HOME/.local/bin:$PATH claude -p --dangerously-skip-permissions --permission-mode bypassPermissions < {promptFile}'
```

---

### 7. Worktree Already Exists

**Symptom**: `fatal: 'symphony-nan-29' is already used by worktree at '...'`

**Debug**:

```bash
git worktree list
```

**Solution**:

```bash
# Remove stale worktree
rm -rf /Users/gurusharan/code/symphony-workspaces/nanoclaw/NAN-29
# Or force:
git worktree remove --force /path/to/worktree
```

---

### 8. Command Works Manually But Not Via Daemon

**Symptom**: Running command manually works, but daemon fails

**Debug**: Check the exact command being run:

```bash
# Look at RUN.json
cat /path/to/workspace/RUN.json
```

**Likely Cause**: Environment variables not being passed to subprocess.

---

## Testing the Flow

### Manual Test (Step by Step)

1. **Sync Registry**:

```bash
npm run symphony:sync-registry
```

1. **Check Ready Issues**:

```bash
bash scripts/workflow/run-with-env.sh npx tsx scripts/workflow/symphony.ts list-ready --project-key nanoclaw
```

1. **Dispatch Once (Dry Run)**:

```bash
bash scripts/workflow/run-with-env.sh npx tsx scripts/workflow/symphony.ts dispatch-once --project-key nanoclaw --dry-run
```

1. **Dispatch Once (Real)**:

```bash
bash scripts/workflow/run-with-env.sh npx tsx scripts/workflow/symphony.ts dispatch-once --project-key nanoclaw
```

1. **Monitor**:

```bash
# Check process is alive
ps aux | grep claude

# Check logs
cat /path/to/workspace/run.log

# Check runtime state
npm run symphony:status
```

> **Empty log is normal for the first few minutes.** Claude `-p` buffers output internally until it produces results — the log file will be 0 bytes while the agent is initializing and making API calls. Do NOT assume the agent is stuck.
>
> If `run.log` is empty and you want to confirm the agent is working, check for active network connections instead:
>
> ```bash
> # Confirm agent is making API calls (look for ESTABLISHED https connections)
> lsof -p <pid> | grep -E "TCP|IPv" | grep ESTABLISHED
>
> # Confirm files are being written in the workspace
> find /path/to/workspace -newer /path/to/workspace/RUN.json -not -path '*/.git/*'
> ```
>
> If both checks return nothing after 5+ minutes, then investigate further.

---

## Useful Commands

| Command | Purpose |
|---------|---------|
| `npm run symphony:sync-registry` | Sync Notion → local cache |
| `npm run symphony:status` | Check daemon + runtime state |
| `npm run symphony:serve` | Start dashboard (port 4318) |
| `npm run symphony:daemon -- --auto-dispatch` | Start daemon with auto-dispatch |
| `npx tsx scripts/workflow/symphony.ts dispatch-once --project-key nanoclaw` | Manual dispatch |

---

## Debugging Checklist

- [ ] Issue is in "Ready" state in Linear
- [ ] Issue has all required sections
- [ ] Linear team has "Blocked" state
- [ ] Backend command works manually
- [ ] CLAUDECODE env var is not passed to subprocess
- [ ] Worktree path is clean
- [ ] Dashboard at <http://127.0.0.1:4318/> shows correct state
