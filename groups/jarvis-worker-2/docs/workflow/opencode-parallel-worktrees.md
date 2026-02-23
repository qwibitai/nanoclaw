# Parallel Worktrees + Subagents

## When to Use What

| Scenario | Tool | Why |
|----------|------|-----|
| 3+ independent features | Worktrees | Isolated git, parallel execution |
| Heavy investigation | Subagents | Separate context, no bleeding |
| Code review | Subagent | Fresh perspective |
| Large migration | Fan-out + Worktrees | Distribute across files |

## Worktrees

For parallel feature development:

```bash
claude -w feature-1      # Create worktree + start
claude -w feature-2      # Another worktree
claude --resume          # View all sessions
```

**Use for:** Independent features, bugfixes, code review

## Subagents

For heavy investigation without polluting main context:

```
Use subagents to investigate how auth handles token refresh
```

**Use for:** Research, large refactors, code analysis

## Fan-out (Headless)

For batch operations across files:

```bash
for file in $(cat files.txt); do
  claude -p "Migrate $file" --allowedTools "Edit,Bash"
done
```

**Use for:** Large migrations, bulk changes
