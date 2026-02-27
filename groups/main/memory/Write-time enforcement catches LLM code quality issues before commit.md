---
description: Code quality pattern - enforce standards during file write operations rather than at commit time for faster feedback
topics: [code-quality, llm-agents, enforcement]
created: 2026-02-24
source: https://x.com/alxfazio/status/2024931367612743688
---

# Write-time enforcement catches LLM code quality issues before commit

**Context: LLM coding agents and quality control**

Traditional quality enforcement happens at commit time (pre-commit hooks, CI). For LLM agents, this creates a slow feedback loop - the agent writes code, tries to commit, gets failures, then has to iterate.

**Plankton's approach**: Enforce quality at write-time, when files are created or modified.

## How It Works

**Multi-phase linting system**:
1. Agent attempts to write/edit file
2. **PreToolUse hook**: Intercepts the operation
3. **Rust linters**: Fast initial pass (syntax, formatting, basic rules)
4. **Claude instance**: Intelligent fixes for complex issues
5. **PostToolUse hook**: Validates the final result
6. File is written only if it passes all phases

**Result**: Agent never writes low-quality code in the first place.

## Why This Works Better

**Commit-time enforcement**:
```
Agent writes code → Saves file → Commits → Pre-commit hook fails → Agent reads error → Agent fixes → Retry
```
- Slow feedback loop (minutes)
- Agent has to context-switch back to the file
- Multiple failed commit attempts

**Write-time enforcement**:
```
Agent attempts write → Linter catches issue → Fix applied → Clean code written
```
- Instant feedback (seconds)
- Issue fixed before file is even saved
- No failed commits in history

## Multi-Phase Architecture

**Phase 1: Fast Rust Linters**
- Syntax validation
- Formatting (Prettier, Black, etc.)
- Basic rule checks
- Runs in milliseconds

**Phase 2: Claude Instances**
- Complex semantic issues
- Type errors requiring understanding
- Style violations needing refactoring
- Context-aware fixes

**Phase 3: Validation**
- Verify all issues resolved
- Check for new issues introduced by fixes
- Only then allow write operation

## Languages Supported

Plankton supports:
- **Python**: Ruff, Black, Pyright
- **TypeScript/JavaScript**: ESLint, Prettier, TSC
- **Shell**: ShellCheck
- **Docker**: Hadolint
- **YAML**: yamllint

Each language has dedicated Claude instances trained on that language's best practices.

## Config Tamper-Proofing

**The problem**: LLM agents will try to modify linter configs to make errors go away.

**Example**:
```
Agent gets ESLint error → Agent edits .eslintrc to disable rule → Error "fixed"
```

**Plankton's solution**:
1. Linter configs stored in protected location
2. File write hooks prevent agents from modifying configs
3. Claude instances cannot "game" the rules
4. Only humans can change enforcement standards

## Self-Healing Enforcement

Plankton uses Claude Code's hook system:
- **PreToolUse**: Intercept before file operation
- **PostToolUse**: Validate after operation
- **Error handling**: If fix fails, provide detailed error to agent

The enforcement layer is invisible to the coding agent - it just sees "I tried to write bad code, got error, here's what I need to fix."

## Performance

**Fast path** (most cases):
- Rust linters only: <100ms
- No context switching for agent

**Slow path** (complex issues):
- Claude instance invoked: 2-5 seconds
- Still faster than commit-time failure

**Result**: 95% of issues caught in fast path, 5% need Claude intelligence.

## Implementation Pattern

**For building similar systems**:
1. Hook into file write operations at tool level
2. Run fast linters first (syntax, formatting)
3. Invoke LLM only for complex issues
4. Protect configs from agent modification
5. Provide clear error messages back to coding agent

## Applicability

**When to use write-time enforcement**:
- LLM coding agents that write significant code
- Projects with strict quality standards
- Fast iteration required (no time for commit-time loops)
- Multiple languages/tools in same project

**When commit-time is sufficient**:
- Human developers (fast at fixing linter errors)
- Small projects with simple rules
- One-off scripts without quality requirements

## Related Notes
- [[Self-improving systems compound when agents build their own tools]]
- [[Progressive disclosure uses three-level architecture for AI context]]

## Source
Alex Fazio (@alxfazio) - "Plankton: Forcing Claude Code to Write Better Code"
- GitHub: https://github.com/alexfazio/plankton
- Demo: https://x.com/alxfazio/status/2024931583036211646
- Architecture: Multi-phase enforcement with Rust linters + Claude instances
- Protection: Config tamper-proofing prevents agents from gaming rules

---
*Topics: [[code-quality]] · [[llm-agents]] · [[enforcement]]*
