# Update: Claude CLI Built-in Worktree Support

**Source**: https://x.com/ericbuess/status/2025010432579437057
**Original Announcement**: https://x.com/bcherny/status/2025010432579437057 (Boris Cherny @bcherny)
**Author**: Eric Buess (@EricBuess) sharing Boris Cherny's announcement
**Date**: February 21, 2026
**Read**: February 24, 2026

## Summary

Claude Code now has built-in git worktree support via CLI. Agents can run in parallel without interfering with each other - each gets its own worktree and works independently. Command: `claude --worktree` or `claude --worktree --tmux` for tmux panes.

Key insight: Feature that was previously in Desktop app is now available in CLI, making parallel agent execution accessible from command line.

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **CLI worktree command**
   ```bash
   claude --worktree
   ```
   - Creates isolated worktree for agent session
   - Agent works independently
   - No interference with other sessions or main branch

2. **Optional tmux integration**
   ```bash
   claude --worktree --tmux
   ```
   - Combines worktree with tmux panes
   - Visual organization of parallel agents
   - Terminal-based parallel workflow

3. **Custom agents support worktrees**
   - Ask Claude to "use worktrees for subagents"
   - Quote: "Custom agents support git worktrees"

4. **Isolation mode for subagents**
   - Add `'isolation: worktree'` to agent frontmatter
   - Forces subagents to always run in their own worktree
   - Ensures parallel work never conflicts

### Tier 2: Strategic Value 📋

**Desktop → CLI feature parity**
- Desktop app had worktree support for a while
- Now available in CLI too
- Enables parallel agent workflows from terminal

**Learn more**: git-scm.com/docs/git-worktree

### Tier 3: Reference Knowledge 📚

**Command options**:
- `claude --worktree` - Basic worktree mode
- `claude --worktree --tmux` - Worktree + tmux panes
- Agent frontmatter: `isolation: worktree` - Force subagent isolation

**Use cases**:
- Running multiple agents in parallel
- Testing changes without affecting main branch
- Isolating experimental work
- Parallel feature development

## Memory Notes Created

None - This is a CLI feature announcement. The underlying concept (git worktrees for parallel agent execution) is already documented in [[Git worktrees enable parallel agent execution without conflicts]].

## Applications to NanoClaw

### High Priority

**1. Document CLI worktree usage in self-edit skill**
- Update self-edit documentation with `--worktree` flag
- Mention as alternative to manual git worktree creation
- Simpler command for users

**2. Test worktree support for NanoClaw agents**
- Verify if NanoClaw's custom agent setup supports `--worktree`
- Test tmux integration if useful for monitoring
- Document any compatibility issues

### Medium Priority

**3. Isolation mode for parallel tasks**
- When spawning multiple agents, use `isolation: worktree` in frontmatter
- Ensures no conflicts when agents work simultaneously
- Safer than manual coordination

### Low Priority

**4. Tmux integration for visibility**
- If running multiple agents, consider `--tmux` for visual monitoring
- Easier to see progress of parallel work
- Terminal-based dashboard

## Implementation Metrics

- **Memory notes created**: 0 (feature announcement, concept already documented)
- **CLI commands**: 2 (`claude --worktree`, `claude --worktree --tmux`)
- **Configuration option**: `isolation: worktree` (agent frontmatter)

## Key Quotes

"Now, agents can run in parallel without interfering with one other. Each agent gets its own worktree and can work independently."

"The Claude Code Desktop app has had built-in support for worktrees for a while, and now we're bringing it to CLI too."

"Custom agents support git worktrees"

"You can also make subagents always run in their own worktree. To do that, just add 'isolation: worktree' to your agent frontmatter"

## Related Research

- [[Git worktrees enable parallel agent execution without conflicts]] - Underlying concept from Elvis article
- [[Orchestrator agent bottleneck is human attention not agent capability]] - Parallel agents reduce human bottleneck

## Next Steps

**For NanoClaw**:
1. Test `claude --worktree` with NanoClaw's agent setup
2. Update self-edit documentation with worktree CLI option
3. Consider `isolation: worktree` for spawned agents
4. Evaluate tmux integration for multi-agent monitoring

**Not a major implementation** - This is a built-in feature we can leverage, not something to build.

## Source

Tweet: https://x.com/ericbuess/status/2025010432579437057
Original: https://x.com/bcherny/status/2025010432579437057 (Boris Cherny, Anthropic)
Author: Eric Buess (@EricBuess) sharing the update
Date: February 21, 2026
Type: CLI feature announcement
Learn more: git-scm.com/docs/git-worktree
