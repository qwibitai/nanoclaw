---
name: plan
description: Create a detailed implementation plan
user-invocable: true
---

# Create Plan

You are tasked with creating detailed implementation plans through an interactive, iterative process. You should be skeptical, thorough, and work collaboratively with the user to produce high-quality technical specifications.

## Initial Response

When this command is invoked:

1. **Check if parameters were provided**:
   - If a file path or task description was provided, skip the default message
   - Check for existing research documents in `research/` directory
   - Immediately read any provided files FULLY
   - Begin the research process

2. **If no parameters provided**, respond with:
```
I'll help you create a detailed implementation plan. Let me start by understanding what we're building.

Please provide:
1. The task/requirement description
2. Any relevant context, constraints, or specific requirements
3. Links to related research or previous implementations

I can also check for existing research documents if you've already run /research on this topic.
```

Then wait for the user's input.

## Planning Process

### Step 1: Context Gathering & Initial Analysis

1. **Check for existing research**:
   - Look for relevant files in `research/` directory
   - If found, read them to understand what's already been discovered
   - If NOT found, run `/research` which will search learnings first
   - Use this as foundation for the plan

2. **Check for project state** (`.planning/` directory):
   - If `.planning/ROADMAP.md` exists: Read it to understand phase structure
   - If `.planning/STATE.md` exists: Read current position and blockers
   - If phase-specific `CONTEXT.md` exists: Read locked decisions -- plan MUST honor these
   - Use roadmap phases as the plan's phase structure when available

3. **Read all mentioned files immediately and FULLY**:
   - Requirements documents
   - Research documents from `research/` directory
   - Related implementation plans from `plans/` directory
   - Any data files mentioned
   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters
   - **CRITICAL**: DO NOT spawn sub-tasks before reading these files yourself

3. **Spawn initial research tasks to gather context**:
   Before asking questions, use agents to research in parallel:

   - Use **general-purpose** agents to find all files related to the task
   - Use **general-purpose** agents to understand current implementation
   - Use **general-purpose** agents to find any existing documentation

   These agents will:
   - Find relevant source files, configs, and tests
   - Trace data flow and key functions
   - Return detailed explanations with file:line references

4. **Read all files identified by research tasks**:
   - After research completes, read ALL identified files FULLY
   - This ensures complete understanding before proceeding

5. **Analyze and verify understanding**:
   - Cross-reference requirements with actual code
   - Identify any discrepancies or misunderstandings
   - Note assumptions that need verification
   - Determine true scope based on codebase reality

6. **Present informed understanding and focused questions**:
   ```
   Based on my research of the codebase, I understand we need to [accurate summary].

   I've found that:
   - [Current implementation detail with file:line reference]
   - [Relevant pattern or constraint discovered]
   - [Potential complexity or edge case identified]

   Questions that my research couldn't answer:
   - [Specific technical question requiring human judgment]
   - [Business logic clarification]
   - [Design preference that affects implementation]
   ```

### Step 2: Research & Discovery

After getting initial clarifications:

1. **If the user corrects any misunderstanding**:
   - DO NOT just accept the correction
   - Spawn new research tasks to verify the correct information
   - Read the specific files/directories they mention
   - Only proceed once you've verified the facts yourself

2. **Create a research todo list** using TodoWrite

3. **Spawn parallel sub-tasks for comprehensive research**:
   Create multiple Task agents to research different aspects:

   **For deeper investigation:**
   - Find more specific files and components
   - Understand implementation details
   - Find similar features to model after

   **For patterns and conventions:**
   - Identify existing patterns to follow
   - Look for integration points and dependencies
   - Find tests and examples

4. **Wait for ALL sub-tasks to complete**

5. **Present findings and design options**:
   ```
   Based on my research, here's what I found:

   **Current State:**
   - [Key discovery about existing code]
   - [Pattern or convention to follow]

   **Design Options:**
   1. [Option A] - [pros/cons]
   2. [Option B] - [pros/cons]

   **Open Questions:**
   - [Technical uncertainty]
   - [Design decision needed]

   Which approach aligns best with your vision?
   ```

### Step 3: Plan Structure Development

Once aligned on approach:

1. **Create initial plan outline**:
   ```
   Here's my proposed plan structure:

   ## Overview
   [1-2 sentence summary]

   ## Implementation Phases:
   1. [Phase name] - [what it accomplishes]
   2. [Phase name] - [what it accomplishes]
   3. [Phase name] - [what it accomplishes]

   Does this phasing make sense? Should I adjust the order or granularity?
   ```

3. **Analyze phase dependencies**:
   For each phase, determine:
   - Which other phases must complete before this one can start
   - Which files this phase will modify (for ownership validation)
   - Whether phases could run in parallel

   Rules:
   - Phase with no dependencies = Wave 1
   - Phase depending on Wave N = Wave N+1
   - A file MUST NOT appear in multiple phases of the same wave
   - If file overlap within a wave: add artificial dependency to serialize

   Present the dependency graph:
   ```
   Dependency Analysis:
   Phase 1: No dependencies (Wave 1)
   Phase 2: Depends on Phase 1 (Wave 2)
   Phase 3: No dependencies (Wave 1) -- parallel with Phase 1
   Phase 4: Depends on Phase 2, Phase 3 (Wave 3)
   ```

2. **Get feedback on structure** before writing details

### Step 4: Detailed Plan Writing

After structure approval, write the plan to `plans/{descriptive_name}.md`:

```markdown
# [Feature/Task Name] Implementation Plan

## Overview
[Brief description of what we're implementing and why]

## Current State Analysis
[What exists now, what's missing, key constraints discovered]

## Desired End State
[Specification of the desired end state and how to verify it]

### Key Discoveries:
- [Important finding with file:line reference]
- [Pattern to follow]
- [Constraint to work within]

## What We're NOT Doing
[Explicitly list out-of-scope items to prevent scope creep]

## Implementation Approach
[High-level strategy and reasoning]

## Phase 1: [Descriptive Name]
<!-- wave: 1 | depends_on: [] | files: [path/to/file1.ext, path/to/file2.ext] -->

### Overview
[What this phase accomplishes]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

```[language]
// Specific code to add/modify
```

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test` or appropriate command
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] Build succeeds: `npm run build`

#### Manual Verification:
- [ ] Feature works as expected when tested
- [ ] Performance is acceptable
- [ ] Edge cases handled correctly
- [ ] No regressions in related features

### Checkpoints (if applicable):

Mark any stopping points with their type:

- **`[CHECKPOINT:human-verify]`**: Review automated work before continuing
  - What was built: [description]
  - How to verify: [numbered steps with expected outcomes]
  - Resume: Type "approved" or describe issues

- **`[CHECKPOINT:decision]`**: Choose between options
  - Options: [A vs B with trade-offs]
  - Impact: [what changes based on choice]

- **`[CHECKPOINT:human-action]`**: Non-automatable step required
  - What's needed: [specific action only a human can take]
  - Example: "Click email verification link", "Approve OAuth app in dashboard"

**Checkpoint rules**:
- If Claude CAN do it via CLI/API/Bash, it MUST NOT be a checkpoint
- Maximum 1 checkpoint per phase (prevents fatigue)
- `human-verify` is most common (~90%) -- use for visual/UX review
- `human-action` is rare (~1%) -- only for things Claude literally cannot do

---

## Phase 2: [Descriptive Name]
[Similar structure...]

---

## Testing Strategy

### Unit Tests:
- [What to test]
- [Key edge cases]

### Integration Tests:
- [End-to-end scenarios]

### Manual Testing Steps:
1. [Specific step to verify feature]
2. [Another verification step]
3. [Edge case to test manually]

## Performance Considerations
[Any performance implications or optimizations needed]

## Migration Notes
[If applicable, how to handle existing data/systems]

## References
- Original requirements: [location]
- Related research: `research/[relevant].md`
- Similar implementation: `[file:line]`
```

**File Ownership Rule**: Each file may only be modified in ONE phase per wave. If two phases in the same wave need the same file, add a dependency between them. List all files each phase touches in the wave comment.

### Step 5: Review and Iterate

1. **Present the draft plan location**:
   ```
   I've created the initial implementation plan at:
   `plans/[filename].md`

   Please review it and let me know:
   - Are the phases properly scoped?
   - Are the success criteria specific enough?
   - Any technical details that need adjustment?
   - Missing edge cases or considerations?
   ```

2. **Iterate based on feedback** - be ready to:
   - Add missing phases
   - Adjust technical approach
   - Clarify success criteria
   - Add/remove scope items

3. **Continue refining** until the user is satisfied

## Important Guidelines

1. **Be Skeptical**:
   - Question vague requirements
   - Identify potential issues early
   - Don't assume - verify with code

2. **Be Interactive**:
   - Don't write the full plan in one shot
   - Get buy-in at each major step
   - Allow course corrections

3. **Be Thorough**:
   - Read all context files COMPLETELY
   - Research actual code patterns
   - Include specific file paths and line numbers
   - Write measurable success criteria

4. **Be Practical**:
   - Focus on incremental, testable changes
   - Consider migration and rollback
   - Think about edge cases
   - Include "what we're NOT doing"

5. **Track Progress**:
   - Use TodoWrite to track planning tasks
   - Update todos as you complete research
   - Mark planning tasks complete when done

6. **No Open Questions in Final Plan**:
   - Research or ask for clarification immediately
   - Do NOT write the plan with unresolved questions
   - Every decision must be made before finalizing

## Success Criteria Guidelines

Always separate success criteria into two categories:

1. **Automated Verification** (can be run by agents):
   - Commands that can be run
   - Specific files that should exist
   - Code compilation/type checking
   - Automated test suites

2. **Manual Verification** (requires human testing):
   - UI/UX functionality
   - Performance under real conditions
   - Edge cases hard to automate
   - User acceptance criteria

## Common Patterns

### For New Features:
- Research existing patterns first
- Start with data model
- Build backend logic
- Add API endpoints
- Implement UI last

### For Refactoring:
- Document current behavior
- Plan incremental changes
- Maintain backwards compatibility
- Include migration strategy

### For Database Changes:
- Start with schema/migration
- Add data access methods
- Update business logic
- Expose via API
- Update clients
