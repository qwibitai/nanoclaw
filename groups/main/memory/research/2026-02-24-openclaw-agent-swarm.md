# Article: OpenClaw + Codex/ClaudeCode Agent Swarm: The One-Person Dev Team

**Source**: https://x.com/elvissun/status/2025920521871716562
**Author**: Elvis (@elvissun)
**Date**: February 23, 2026
**Read**: February 24, 2026

## Summary

Elvis built a one-person dev team using OpenClaw as an orchestration layer managing multiple Codex and Claude Code agents. His orchestrator "Zoe" spawns specialized agents, writes their prompts with business context, picks the right model for each task, and monitors progress - delivering 94 commits in a single day without opening an editor.

The key insight: Context windows are zero-sum. One AI can't handle both business context (customer data, meeting notes, past decisions) AND code effectively. The two-tier system separates concerns - the orchestrator holds all business context and writes precise prompts for coding agents that focus purely on implementation.

This is the Ralph Loop V2: Instead of running the same prompt each cycle with distilled learnings, the orchestrator rewrites prompts on failure using full business context to unblock stuck agents.

Real results: 50 commits/day average, 7 PRs in 30 minutes, same-day feature delivery converting leads to customers. Cost: ~$190/month. Success rate: One-shots most small-medium tasks without intervention.

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **Orchestration layer separates business from code context**
   - Created: [[Orchestration layer separates business context from coding context]]
   - Pattern: Two-tier system where each AI gets exactly what it needs
   - Orchestrator has business context, coding agents focus on implementation
   - Applicable to: NanoClaw could implement similar separation for tasks

2. **Git worktrees enable parallel agent execution**
   - Created: [[Git worktrees enable parallel agent execution without conflicts]]
   - Pattern: Each agent works in isolated directory to prevent conflicts
   - Applicable to: Multi-agent skills we might build for NanoClaw

3. **Multi-model code review for comprehensive coverage**
   - Created: [[Multi-model code review catches different error types]]
   - Pattern: Codex (logic), Gemini (security/free), Claude (validation)
   - Applicable to: Self-edit workflow in NanoClaw could use multiple reviewers

4. **Agent specialization by task type**
   - Created: [[Agent specialization by task type maximizes effectiveness]]
   - Pattern: Codex for backend/complex, Claude for frontend/git, Gemini for design
   - Applicable to: Task routing in NanoClaw's agent selection

5. **Proactive task discovery from logs and notes**
   - Created: [[Proactive task discovery multiplies agent productivity]]
   - Pattern: Scan Sentry, meeting notes, git log → spawn agents
   - Applicable to: NanoClaw could scan conversations/reminders/memory for tasks

### Tier 2: Strategic Value 📋

1. **Task registry pattern with JSON**
   - Track each agent: worktree, tmux session, status, PR number, checks
   - Update on completion with all validation results
   - Deterministic monitoring (check git/CI, not expensive polling)

2. **Definition of done enforces quality**
   - PR created + synced + CI passing + 3 reviews + screenshots (if UI)
   - Human notified only when ALL checks pass
   - Reduces review time from 30min to 5-10min

3. **tmux for mid-task redirection**
   - Don't kill stuck agents, redirect them with business context
   - "Stop. Customer wanted X not Y" injected mid-execution
   - Preserves work while course-correcting

4. **Learning from success patterns**
   - Log what works: "This prompt structure works for billing features"
   - Reward signals: CI passing + reviews passing + human merge
   - Over time, orchestrator writes better prompts

5. **Hardware bottleneck: RAM limits parallel agents**
   - Each worktree = own node_modules + builds + tests in memory
   - 16GB tops out at 4-5 agents before swapping
   - 128GB enables true parallelization

### Tier 3: Reference Knowledge 📚

1. **Agent launch commands**
   - Codex: `codex --model gpt-5.3-codex -c "model_reasoning_effort=high" --dangerously-bypass-approvals-and-sandbox "prompt"`
   - Claude: `claude --model claude-opus-4.5 --dangerously-skip-permissions -p "prompt"`

2. **Cron monitoring every 10 minutes**
   - Check tmux sessions alive
   - Check PRs on tracked branches
   - Check CI status via gh cli
   - Auto-respawn failed agents (max 3 attempts)

3. **Screenshot requirement for UI changes**
   - If PR changes UI, must include screenshot or CI fails
   - Dramatically shortens human review time
   - See changes without clicking preview

4. **One-person million-dollar company thesis**
   - 2026: AI orchestrator delegates to specialized agents
   - Stay small, move fast, ship daily
   - Real customers, real revenue, not demos

## Memory Notes Created

1. [[Orchestration layer separates business context from coding context]]
2. [[Git worktrees enable parallel agent execution without conflicts]]
3. [[Multi-model code review catches different error types]]
4. [[Agent specialization by task type maximizes effectiveness]]
5. [[Proactive task discovery multiplies agent productivity]]

## Potential Applications to NanoClaw

### High Priority

**1. Orchestrator pattern for complex tasks**
- When user requests "build fitness app", spawn planner agent with full context
- Planner spawns specialized agents (database, API, frontend)
- Each agent works in isolation, orchestrator coordinates

**2. Multi-agent code review in self-edit**
- Current: Single agent reviews own PR
- Enhancement: Spawn 2-3 reviewers (different models)
- Merge only when consensus or specific model approves

**3. Proactive task scanning**
- Scan `ops/reminders.md` daily → spawn agents for due tasks
- Scan conversation history → identify follow-up tasks
- Scan `memory/logs/failures.jsonl` → prevent recurring issues

### Medium Priority

**4. Task registry for long-running work**
- Track agent sessions with JSON
- Monitor progress without expensive polling
- Notify user only when ready for review

**5. Agent specialization routing**
- Route research tasks → haiku (cheap, fast)
- Route complex analysis → opus (thorough)
- Route code generation → sonnet (balanced)

### Low Priority

**6. Git worktrees for parallel work**
- If implementing team features, use worktrees per agent
- Prevents conflicts when multiple agents work simultaneously

## Implementation Metrics

- **Memory notes created**: 5
- **New concepts integrated**: 5 (Tier 1) + 5 (Tier 2) = 10 total
- **Potential applications**: 6 identified

## Architecture Comparison

| Aspect | Elvis's Setup | NanoClaw Current |
|--------|---------------|------------------|
| **Orchestrator** | OpenClaw "Zoe" | User (manual) |
| **Business context** | Obsidian vault | memory/, self/, ops/ |
| **Coding agents** | Codex, Claude Code, Gemini | Claude (single model) |
| **Parallelization** | Git worktrees + tmux | Sequential execution |
| **Task discovery** | Proactive (scans logs/notes) | Reactive (user requests) |
| **Code review** | 3 AI models + human | Human only |
| **Definition of done** | Automated checks | Manual verification |

## Key Differences

**Elvis optimizes for**: Maximum parallel throughput, same-day feature delivery
**NanoClaw optimizes for**: Personal assistant tasks, memory persistence, chat integration

**Opportunity**: Adopt orchestration patterns where they fit NanoClaw's use case (complex multi-step tasks, code review, proactive scanning).

## Next Steps

1. **Experiment with multi-agent code review**
   - Add to `/self-edit` skill
   - Test Codex vs Gemini vs Claude reviewers
   - Measure time saved and bugs caught

2. **Implement proactive task scanning**
   - Daily cron: scan reminders.md
   - Weekly: scan memory for incomplete work
   - Monthly: review failures.jsonl for prevention

3. **Build orchestrator pattern for complex requests**
   - Start with "build X app" requests
   - Orchestrator plans, spawns specialists
   - Track with task registry JSON

4. **Document agent specialization guidelines**
   - When to use haiku vs sonnet vs opus
   - Task routing decision table
   - Cost vs quality tradeoffs

## Related Research

- [[Orchestration layer separates business context from coding context]]
- [[Proactive task discovery multiplies agent productivity]]
- Stripe's "Minions" - parallel coding agents with centralized orchestration

## Source Material

Full tweet archived (5.8K likes, 800 retweets, 1.8M views)

Author building: Agentic PR - one-person company competing with enterprise PR incumbents using agent swarm

Real business metrics:
- 94 commits in one day (3 client calls, didn't open editor)
- 7 PRs in 30 minutes
- 50 commits/day average
- $190/month cost (Claude + Codex)
- Features ship same-day, converting leads to customers
