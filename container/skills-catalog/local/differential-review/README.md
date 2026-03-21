# Differential Review

Security-focused differential review of code changes with git history analysis and blast radius estimation.

**Author:** Omar Inuwa

## When to Use

Use this skill when you need to:
- Review PRs, commits, or diffs for security vulnerabilities
- Detect security regressions (re-introduced vulnerabilities)
- Analyze the blast radius of code changes
- Check test coverage gaps for modified code

## What It Does

This skill performs comprehensive security review of code changes:

- **Risk-First Analysis** - Prioritizes auth, crypto, value transfer, external calls
- **Git History Analysis** - Uses blame to understand why code existed and detect regressions
- **Blast Radius Calculation** - Quantifies impact by counting callers
- **Test Coverage Gaps** - Identifies untested changes
- **Adaptive Depth** - Scales analysis based on codebase size (small/medium/large)

## Installation

```
/plugin install trailofbits/skills/plugins/differential-review
```

## Documentation Structure

This skill uses a **modular documentation architecture** for token efficiency and progressive disclosure:

### Core Entry Point
- **[SKILL.md](skills/differential-review/SKILL.md)** - Main entry point (217 lines)
  - Quick reference tables for triage
  - Decision tree routing to detailed docs
  - Quality checklist and red flags
  - Integration with other skills

### Supporting Documentation
- **[methodology.md](skills/differential-review/methodology.md)** - Detailed phase-by-phase workflow (~200 lines)
  - Pre-Analysis: Baseline context building
  - Phase 0: Intake & Triage
  - Phase 1: Changed Code Analysis
  - Phase 2: Test Coverage Analysis
  - Phase 3: Blast Radius Analysis
  - Phase 4: Deep Context Analysis

- **[adversarial.md](skills/differential-review/adversarial.md)** - Attacker modeling and exploit scenarios (~150 lines)
  - Phase 5: Adversarial Vulnerability Analysis
  - Attacker model definition (WHO/ACCESS/INTERFACE)
  - Exploitability rating framework
  - Complete exploit scenario templates

- **[reporting.md](skills/differential-review/reporting.md)** - Report structure and formatting (~120 lines)
  - Phase 6: Report Generation
  - 9-section report template
  - Formatting guidelines and conventions
  - File naming and notification templates

- **[patterns.md](skills/differential-review/patterns.md)** - Common vulnerability patterns (~80 lines)
  - Security regressions detection
  - Reentrancy, access control, overflow patterns
  - Quick detection bash commands

### Benefits of This Structure
- **Token Efficient** - Load only the documentation you need
- **Progressive Disclosure** - Quick reference for triage, detailed docs for deep analysis
- **Maintainable** - Each concern separated into its own file
- **Navigable** - Decision tree routes you to the right document

## Workflow

The complete workflow spans Pre-Analysis + Phases 0-6:

1. **Pre-Analysis** - Build baseline context with `audit-context-building` skill (if available)
2. **Phase 0: Intake** - Extract changes, assess size, risk-score files
3. **Phase 1: Changed Code** - Analyze diffs, git blame, check for regressions
4. **Phase 2: Test Coverage** - Identify coverage gaps
5. **Phase 3: Blast Radius** - Calculate impact of changes
6. **Phase 4: Deep Context** - Five Whys root cause analysis
7. **Phase 5: Adversarial Analysis** - Hunt vulnerabilities with attacker model
8. **Phase 6: Report** - Generate comprehensive markdown report

**Navigation:** Use the decision tree in SKILL.md to jump directly to the phase you need.

## Output

Generates a markdown report with:
- Executive summary with severity distribution
- Critical findings with attack scenarios and PoCs
- Test coverage analysis
- Blast radius analysis
- Historical context and regression risks
- Actionable recommendations

## Example Usage

```
Review the security implications of this PR:
git diff main..feature/auth-changes
```

## Related Skills

- `context-building` - Used for baseline context analysis
- `issue-writer` - Transform findings into formal audit reports
