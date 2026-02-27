# Article: Plankton - Forcing Claude Code to Write Better Code

**Source**: https://x.com/alxfazio/status/2024931367612743688
**Author**: Alex Fazio (@alxfazio)
**Date**: February 2026
**Read**: February 24, 2026

## Summary

Plankton is a quality enforcement system built on top of Claude Code that catches code quality issues at write-time rather than commit-time. Uses multi-phase approach: fast Rust linters → intelligent Claude instances → validated writes. Includes config tamper-proofing to prevent agents from gaming the rules.

Key insight: Enforcing quality when files are written (not when committed) creates faster feedback loops and prevents low-quality code from ever being saved.

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **Write-time enforcement beats commit-time for LLM agents**
   - Created: [[Write-time enforcement catches LLM code quality issues before commit]]
   - Traditional pre-commit hooks too slow for agent iteration
   - Intercept file writes, lint immediately, fix issues before save
   - Agent never writes bad code in first place

2. **Multi-phase linting optimizes for speed and intelligence**
   - Fast Rust linters (syntax, formatting) run first (<100ms)
   - Claude instances only invoked for complex issues (2-5 seconds)
   - 95% of issues caught in fast path
   - Reserve expensive LLM calls for semantic problems

3. **Config tamper-proofing prevents agents from gaming rules**
   - LLM agents will try to disable linter rules to make errors disappear
   - Store configs in protected locations
   - File write hooks prevent config modifications
   - Only humans can change enforcement standards

### Tier 2: Strategic Value 📋

1. **Multi-language support through dedicated Claude instances**
   - Python: Ruff, Black, Pyright
   - TypeScript/JavaScript: ESLint, Prettier, TSC
   - Shell: ShellCheck
   - Docker: Hadolint
   - YAML: yamllint
   - Each language gets dedicated Claude instance trained on best practices

2. **Hook-based architecture for transparency**
   ```typescript
   PreToolUse → Rust linters → Claude fixes → PostToolUse → Validate → Write
   ```
   - Invisible to coding agent
   - Agent just sees error messages, not enforcement mechanism
   - Self-healing through automatic fixes

3. **Error messages optimized for agent consumption**
   - Structured output (not human-friendly text)
   - Specific line numbers and fixes
   - Context about what rule was violated
   - Example of correct pattern

### Tier 3: Reference Knowledge 📚

1. **Architecture layers**
   - **Interception layer**: PreToolUse/PostToolUse hooks
   - **Fast linting layer**: Rust-based syntax/formatting checks
   - **Intelligent fixing layer**: Claude instances per language
   - **Validation layer**: Verify fixes don't introduce new issues
   - **Protection layer**: Config modification prevention

2. **Performance characteristics**
   - Fast path (Rust only): <100ms
   - Slow path (Claude invoked): 2-5 seconds
   - Still faster than commit-time failure loop (minutes)
   - 95%/5% split between fast/slow paths

3. **Built on Claude Code**
   - Uses Claude Code's hook system
   - Extends with custom linting pipeline
   - Transparent to the coding agent
   - Can be applied to any Claude Code project

## Memory Notes Created

1. [[Write-time enforcement catches LLM code quality issues before commit]]

## Applications to NanoClaw

### High Priority

**1. Write-time enforcement for self-edit workflow**
- Currently: Agent writes code, commits, CI fails, agent fixes
- Enhancement: Intercept file writes in worktree, lint immediately, fix before save
- Pattern: PreToolUse hook → lint → fix → PostToolUse validation

**2. Config protection for system files**
- Prevent agents from modifying CLAUDE.md, memory/index.md structure
- File write hooks that block changes to protected paths
- Only humans can modify core system architecture

**3. Multi-phase validation (fast then smart)**
- TypeScript: TSC (fast) → Claude for complex type errors (smart)
- Markdown: Basic formatting (fast) → Structure validation (smart)
- Balance speed with intelligent fixes

### Medium Priority

**4. Language-specific linting for skills**
- When agents create skills, enforce quality standards
- YAML validation for manifest.yaml
- Markdown structure for SKILL.md
- TypeScript validation for implementation files

**5. Error messages optimized for agents**
- Structured output from linters
- Include fix suggestions in agent-readable format
- Reduce iteration cycles for self-edit

### Low Priority

**6. Performance monitoring**
- Track fast path vs. slow path usage
- Identify which linters are slowest
- Optimize based on actual bottlenecks

## Implementation Metrics

- **Memory notes created**: 1
- **Enforcement approach**: Write-time (not commit-time)
- **Performance**: 95% fast path (<100ms), 5% slow path (2-5s)
- **Languages supported**: Python, TypeScript, JavaScript, Shell, Docker, YAML

## Architecture Comparison

| Aspect | Commit-Time Enforcement | Write-Time Enforcement (Plankton) |
|--------|------------------------|-----------------------------------|
| **Feedback speed** | Minutes (commit → CI → agent reads) | Seconds (immediate at write) |
| **Failed commits** | Multiple in history | Zero (caught before write) |
| **Agent iteration** | Slow (context switching) | Fast (instant feedback) |
| **Config gaming** | Possible (agent edits rules) | Prevented (protected configs) |
| **Performance** | All checks at once | Multi-phase (fast then smart) |

## Key Quotes

"Enforcement at write-time, not commit-time."

"LLM agents will try to modify linter configs to make errors go away."

"95% of issues caught in fast path, reserve expensive LLM calls for semantic problems."

"The enforcement layer is invisible to the coding agent - it just sees error messages."

## Pattern: Multi-Phase Linting

```
File write attempt
    ↓
PreToolUse hook intercepts
    ↓
Phase 1: Fast Rust linters (<100ms)
    ↓
If complex issue → Phase 2: Claude instance (2-5s)
    ↓
PostToolUse validation
    ↓
All checks pass → Write file
    ↓
Any check fails → Return error to agent
```

## What Humans Configure vs. What Agents Do

**Humans configure**:
- Linter rules and standards
- Which linters run for each language
- Error message templates
- Protected config paths

**Agents experience**:
- Attempt to write file
- Get instant feedback if quality issues
- See clear error messages
- Fix and retry
- Never aware of enforcement mechanism

## Related Research

- [[Self-improving systems compound when agents build their own tools]] - Plankton improves agent output quality
- [[Orchestrator agent bottleneck is human attention not agent capability]] - Write-time enforcement removes human from review loop

## Next Steps

**For Plankton** (from article):
1. Expand language support (Rust, Go, Ruby)
2. Custom rule authoring for domain-specific patterns
3. Learning mode (track which rules agents violate most)
4. Integration with other LLM coding tools (not just Claude Code)

**For NanoClaw** (potential applications):
1. Implement write-time linting for self-edit worktrees
2. Protect system configs from agent modification
3. Multi-phase validation (TSC fast, Claude smart)
4. Language-specific enforcement for skill creation
5. Optimize error messages for agent consumption

## Source

Article: https://x.com/alxfazio/status/2024931367612743688
GitHub: https://github.com/alexfazio/plankton
Demo: https://x.com/alxfazio/status/2024931583036211646
Author: Alex Fazio (@alxfazio)
Architecture: Multi-phase enforcement with config protection
