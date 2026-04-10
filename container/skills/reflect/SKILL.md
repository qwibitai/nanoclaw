---
name: reflect
description: Self-improvement through conversation analysis. Extracts learnings from corrections and success patterns, permanently encoding them into agent definitions. Philosophy - Correct once, never again.
version: "2.0.0"
user-invocable: true
triggers:
  - reflect
  - self-reflect
  - review session
  - what did I learn
  - extract learnings
  - analyze corrections
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
metadata:
  clawdbot:
    emoji: "🪞"
    config:
      stateDirs: ["~/.reflect"]
---

# Reflect - Agent Self-Improvement Skill

Transform your AI assistant into a continuously improving partner. Every correction becomes a permanent improvement that persists across all future sessions.

## Quick Reference

| Command | Action |
|---------|--------|
| `reflect` | Analyze conversation for learnings |
| `reflect on` | Enable auto-reflection |
| `reflect off` | Disable auto-reflection |
| `reflect status` | Show state and metrics |
| `reflect review` | Review pending learnings |

## When to Use

- After completing complex tasks
- When user explicitly corrects behavior ("never do X", "always Y")
- At session boundaries or before context compaction
- When successful patterns are worth preserving

## Workflow

### Step 1: Scan Conversation for Signals

Analyze the conversation for correction signals and learning opportunities.

**Signal Confidence Levels:**

| Confidence | Triggers | Examples |
|------------|----------|----------|
| **HIGH** | Explicit corrections | "never", "always", "wrong", "stop", "the rule is" |
| **MEDIUM** | Approved approaches | "perfect", "exactly", "that's right", accepted output |
| **LOW** | Observations | Patterns that worked but not explicitly validated |

See [data/signal_patterns.md](data/signal_patterns.md) for full detection rules.

### Step 2: Classify & Match to Target Files

Map each signal to the appropriate target:

| Category | Target Files |
|----------|--------------|
| Code Style | `code-reviewer`, `backend-developer`, `frontend-developer` |
| Architecture | `solution-architect`, `api-architect`, `architecture-reviewer` |
| Process | `CLAUDE.md`, orchestrator agents |
| Domain | Domain-specific agents, `CLAUDE.md` |
| Tools | `CLAUDE.md`, relevant specialists |
| New Skill | Create new skill file |

See [data/agent_mappings.md](data/agent_mappings.md) for mapping rules.

### Step 3: Check for Skill-Worthy Signals

Some learnings should become new skills rather than agent updates:

**Skill-Worthy Criteria:**
- Non-obvious debugging (>10 min investigation)
- Misleading error (root cause different from message)
- Workaround discovered through experimentation
- Configuration insight (differs from documented)
- Reusable pattern (helps in similar situations)

**Quality Gates (must pass all):**
- [ ] Reusable: Will help with future tasks
- [ ] Non-trivial: Requires discovery, not just docs
- [ ] Specific: Can describe exact trigger conditions
- [ ] Verified: Solution actually worked
- [ ] No duplication: Doesn't exist already

### Step 4: Generate Proposals

Present findings in structured format:

```markdown
# Reflection Analysis

## Session Context
- **Date**: [timestamp]
- **Messages Analyzed**: [count]

## Signals Detected

| # | Signal | Confidence | Source Quote | Category |
|---|--------|------------|--------------|----------|
| 1 | [learning] | HIGH | "[exact words]" | Code Style |

## Proposed Changes

### Change 1: Update [agent-name]
**Target**: `[file path]`
**Section**: [section name]
**Confidence**: HIGH

```diff
+ New rule from learning
```

## Review Prompt
Apply these changes? (Y/N/modify/1,2,3)
```

### Step 5: Apply with User Approval

**On `Y` (approve):**
1. Apply each change using Edit tool
2. Commit with descriptive message
3. Update metrics

**On `N` (reject):**
1. Discard proposed changes
2. Log rejection for analysis

**On `modify`:**
1. Present each change individually
2. Allow editing before applying

**On selective (e.g., `1,3`):**
1. Apply only specified changes
2. Commit partial updates

## State Management

State is stored in `~/.reflect/` (configurable via `REFLECT_STATE_DIR`):

```yaml
# reflect-state.yaml
auto_reflect: false
last_reflection: "2026-01-26T10:30:00Z"
pending_reviews: []
```

### Metrics Tracking

```yaml
# reflect-metrics.yaml
total_sessions_analyzed: 42
total_signals_detected: 156
total_changes_accepted: 89
acceptance_rate: 78%
confidence_breakdown:
  high: 45
  medium: 32
  low: 12
most_updated_agents:
  code-reviewer: 23
  backend-developer: 18
skills_created: 5
```

## Safety Guardrails

### Human-in-the-Loop
- NEVER apply changes without explicit user approval
- Always show full diff before applying
- Allow selective application

### Incremental Updates
- ONLY add to existing sections
- NEVER delete or rewrite existing rules
- Preserve original structure

### Conflict Detection
- Check if proposed rule contradicts existing
- Warn user if conflict detected
- Suggest resolution strategy

## Output Locations

**Project-level (versioned with repo):**
- `.claude/reflections/YYYY-MM-DD_HH-MM-SS.md` - Full reflection
- `.claude/skills/{name}/SKILL.md` - New skills

**Global (user-level):**
- `~/.reflect/learnings.yaml` - Learning log
- `~/.reflect/reflect-metrics.yaml` - Aggregate metrics

## Examples

### Example 1: Code Style Correction

**User says**: "Never use `var` in TypeScript, always use `const` or `let`"

**Signal detected**:
- Confidence: HIGH (explicit "never" + "always")
- Category: Code Style
- Target: `frontend-developer.md`

**Proposed change**:
```diff
## Style Guidelines
+ * Use `const` or `let` instead of `var` in TypeScript
```

### Example 2: Process Preference

**User says**: "Always run tests before committing"

**Signal detected**:
- Confidence: HIGH (explicit "always")
- Category: Process
- Target: `CLAUDE.md`

**Proposed change**:
```diff
## Commit Hygiene
+ * Run test suite before creating commits
```

### Example 3: New Skill from Debugging

**Context**: Spent 30 minutes debugging a React hydration mismatch

**Signal detected**:
- Confidence: HIGH (non-trivial debugging)
- Category: New Skill
- Quality gates: All passed

**Proposed skill**: `react-hydration-fix/SKILL.md`

## Troubleshooting

**No signals detected:**
- Session may not have had corrections
- Check if using natural language corrections

**Conflict warning:**
- Review the existing rule cited
- Decide if new rule should override
- Can modify before applying

**Agent file not found:**
- Check agent name spelling
- May need to create agent file first
