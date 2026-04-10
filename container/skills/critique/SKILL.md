---
name: critique
description: Get a Distinguished Engineer level technical critique of the current approach
user-invocable: true
---

# Critique Command

Use this command to get a Distinguished Engineer level technical critique of the current approach and implementation.

## Usage

```
/critique [type] "context"
```

## Types

- `general` - Overall technical review (default)
- `architecture` - System design and patterns review
- `performance` - Performance and scalability analysis
- `security` - Security implications assessment
- `cost` - Total cost of ownership analysis
- `complexity` - Overengineering assessment
- `all` - Comprehensive review covering all aspects

## Description

This command provides brutally honest, constructive critique with 25+ years of Distinguished Engineer experience perspective. The review prevents costly mistakes while not crushing innovation. The critique will be displayed in a clear <output> block for review and response.

## Examples

```
/critique architecture "Using microservices for a 3-user internal tool"
/critique cost "Kubernetes for a static website"
/critique all "Redux for state management in a todo app"
/critique "Using 5 different databases in a startup MVP"
```

## Output Format

The critique provides a structured JSON report containing:

- **Summary**: Verdict (APPROVE/CAUTION/RECONSIDER/REJECT), one-liner, confidence score
- **Strengths**: 2-3 genuine strengths of the approach
- **Concerns**: Critical, major, and minor issues with impact analysis
- **Alternatives**: Better approaches with pros/cons
- **Cost Analysis**: Initial, operational, hidden costs, and 3-year TCO
- **Complexity Assessment**: Overengineering score and simplification suggestions
- **Team Impact**: Learning curve, hiring difficulty, maintenance burden
- **Future Proofing**: Scalability limits, migration difficulty, tech debt
- **Recommendation**: Should proceed or not with conditions
- **Wisdom**: Pattern recognition, war stories, and principles

## Implementation

When this command is invoked:

1. **Context Extraction**:
   - Identify what needs critique from the current conversation
   - Gather recent technical decisions and implementation details
   - List files created or modified in this session
   - Extract relevant code snippets
   - Note any trade-offs or constraints mentioned

2. **Analysis Phase**:
   - Apply Distinguished Engineer perspective (25+ years experience)
   - Identify anti-patterns and overengineering
   - Assess complexity vs problem size
   - Consider simpler alternatives
   - Evaluate long-term implications

3. **Generate Critique** with structured output:
   - Verdict (APPROVE/CAUTION/RECONSIDER/REJECT)
   - Critical concerns with evidence
   - Alternative approaches with trade-offs
   - Overengineering score
   - Clear recommendations

4. **Display Output** in formatted <output> block:
   - Color-coded verdict
   - Highlighted critical concerns
   - Alternative recommendations table
   - Action items

5. **Save the critique** to `~/.claude/critiques/critique_[TIMESTAMP]_[TYPE].json`

## Critique Perspective

The Distinguished Engineer perspective includes:
- 25+ years seeing technologies rise and fall
- Experience with architectures that succeeded and failed
- Understanding of team dynamics and organizational impact
- Battle scars from real-world production systems

The critique should be:
- Brutally honest but constructive
- Data-driven with real examples
- Focused on preventing expensive mistakes
- Balanced between innovation and pragmatism

## Response Protocol

After receiving the critique:
1. Review and acknowledge each critique point
2. Provide rationale or agreement with concerns
3. Propose adjustments based on valid points
4. Update implementation if significant issues identified

## Notes

- The critique is advisory, not prescriptive
- Consider context and constraints when evaluating recommendations
- Perfect is the enemy of good, but good enough today often becomes tomorrow's technical debt
- The goal is to make informed decisions, not to achieve perfection
- Each critique should challenge assumptions and prevent costly mistakes
