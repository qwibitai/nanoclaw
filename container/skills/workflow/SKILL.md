---
name: workflow
description: Guide through structured delivery workflow with plan, implement, validate phases
user-invocable: true
---

# Workflow

You are tasked with orchestrating the complete research->plan->implement workflow for a given task or requirement. This command manages the entire pipeline from initial research through implementation.

## Initial Setup

When this command is invoked, respond with:
```
I'll orchestrate the complete workflow for your task.

This will include:
1. **Research**: Comprehensive investigation of the problem space
2. **Planning**: Creating a detailed implementation plan
3. **Implementation**: Executing the plan with verification

Please provide:
- The task/feature/bug you want to address
- Any specific constraints or requirements
- Whether you want to run the full pipeline or start from a specific phase

You can also say "workflow continue" if you have existing research or plans.
```

Then wait for the user's input.

### Phase 0: Project State Check

Before starting any workflow phase, check for persistent project state:

1. **Check for `.planning/` directory**:
   - If exists: Read `.planning/STATE.md` to understand current position
   - Load `.planning/ROADMAP.md` for phase context
   - Resume from where STATE.md indicates

2. **If `.planning/` does NOT exist**:
   - Ask: "Would you like to set up persistent project state? This tracks requirements, roadmap, and decisions across sessions."
   - If yes: Initialize from templates
     ```bash
     mkdir -p .planning/phases .planning/todos
     ```
   - Copy templates from `{{HOME_TOOL_DIR}}/templates/planning/` to `.planning/`
   - Guide user through filling in PROJECT.md (vision + constraints)
   - If no: Continue with standard workflow (backward compatible)

3. **If `.planning/` exists and has ROADMAP.md**:
   - Identify current phase from STATE.md
   - Check if current phase has CONTEXT.md (decisions captured)
   - If no CONTEXT.md: Suggest running `/discuss` before planning
   - Load phase context for downstream commands

## Workflow Phases

### Phase 1: Research

If no existing research found in `research/` directory:

1. **Invoke research phase**:
   - Call the `/research` command internally
   - Conduct comprehensive multi-modal research
   - Save findings to `research/YYYY-MM-DD_HH-MM-SS_topic.md`

2. **Review research output**:
   - Read the generated research document
   - Identify key findings and constraints
   - Note any open questions that need clarification

3. **Present research summary**:
   ```
   ## Research Complete

   Key findings:
   - [Major discovery 1]
   - [Major discovery 2]
   - [Important constraint]

   The research has been saved to: research/[filename].md

   Shall I proceed to create an implementation plan based on these findings?
   ```

### Phase 2: Planning

After research is complete or if existing research is found:

1. **Invoke planning phase**:
   - Call the `/plan` command with research context
   - Reference the research document findings
   - Create detailed, phased implementation plan

2. **Interactive planning**:
   - Work with user to refine the plan
   - Ensure all phases have clear success criteria
   - Save to `plans/descriptive_name.md`

3. **Present plan summary**:
   ```
   ## Plan Complete

   Implementation will be done in [N] phases:
   1. [Phase 1 name] - [objective]
   2. [Phase 2 name] - [objective]
   ...

   The plan has been saved to: plans/[filename].md

   Ready to begin implementation?
   ```

### Phase 3: Implementation

After plan is approved:

1. **Invoke implementation**:
   - Call the `/implement` command with plan path
   - Execute phase by phase
   - Track progress with TodoWrite

2. **Progress tracking**:
   - Update checkmarks in plan as phases complete
   - Run verification after each phase
   - Handle any issues that arise

3. **Present completion status**:
   ```
   ## Implementation Status

   Phase 1: [Name] - Complete
   Phase 2: [Name] - Complete
   Phase 3: [Name] - Partial (see notes)

   Verification Results:
   - Tests: [status]
   - Linting: [status]
   - Build: [status]

   Would you like me to run validation on the implementation?
   ```

### Phase 4: Validation (Optional)

If requested or if issues found:

1. **Run validation**:
   - Execute all automated checks
   - Verify against plan success criteria
   - Generate validation report

2. **Present validation results**:
   ```
   ## Validation Report

   Automated Checks:
   All tests passing
   Linting clean
   Build successful

   Plan Criteria:
   [Criterion 1] - Verified
   [Criterion 2] - Verified
   [Criterion 3] - Needs manual verification

   The implementation is ready for review.
   ```

### Phase 5: Knowledge Capture (Suggested)

After successful implementation, offer to capture learnings:

```
## Capture Learnings?

This task is complete. If you encountered any problems worth documenting
for future reference, consider running:

   /compound

This will:
- Capture the solution as a searchable learning
- Save it to docs/solutions/ for future sessions
- Make it discoverable via /research

Useful when:
- You debugged a tricky issue
- You found a non-obvious solution
- You want to remember "the fix" for next time

Skip this if the work was straightforward with no notable discoveries.
```

### .planning/ State Updates

After each major phase transition, update `.planning/STATE.md`:
- After Research: Update "Last activity", add key findings to "Recent Decisions"
- After Plan: Update phase status, link to plan file
- After Implement: Update progress, mark completed requirements
- After Validate: Record validation status, update blockers if any

## Workflow Commands

The user can control the workflow with these commands:

- **`workflow start`** - Begin from research phase
- **`workflow continue`** - Resume from existing research/plan
- **`workflow skip-research`** - Start directly with planning
- **`workflow validate`** - Run validation on completed work
- **`workflow status`** - Show current progress

## Progress Tracking

Throughout the workflow, maintain a master todo list:

```
Master Workflow: [Task Name]
[ ] Research Phase
  [ ] Codebase analysis
  [ ] Documentation review
  [ ] External research (if needed)
  [ ] Synthesize findings
[ ] Planning Phase
  [ ] Review research
  [ ] Draft plan structure
  [ ] Detail each phase
  [ ] Define success criteria
[ ] Implementation Phase
  [ ] Phase 1: [Name]
  [ ] Phase 2: [Name]
  [ ] Phase 3: [Name]
[ ] Validation Phase
  [ ] Run automated tests
  [ ] Verify success criteria
  [ ] Generate report
```

Update this list as you progress through each phase.

## Handling Interruptions

If the workflow is interrupted:

1. **Save state**:
   - Document what phase you're in
   - Note what's been completed
   - Save any partial work

2. **On resume**:
   - Check for existing research in `research/`
   - Check for existing plans in `plans/`
   - Look for checkmarks in plans indicating progress
   - Continue from where you left off

## Best Practices

1. **Always start with research** unless explicitly told to skip
2. **Plans must reference research findings** to ensure alignment
3. **Implementation must follow the plan** (adapt if needed, but document deviations)
4. **Validation is not optional** for production-ready code
5. **Keep the user informed** at each phase transition
6. **Use TodoWrite** to track detailed progress

## Example Usage

```
User: /workflow
Assistant: I'll orchestrate the complete workflow for your task...

User: Add OAuth2 authentication to the application
Assistant: I'll start by researching OAuth2 implementations and your current auth setup...
[Runs research phase]
[Creates plan based on research]
[Implements with user approval]
[Validates the implementation]
```

## Integration with Other Commands

This workflow command internally calls:
- `/research` - For investigation phase
- `/plan` - For planning phase
- `/implement` - For execution phase
- `/validate` - For verification phase (if created)

Each command can also be run independently if needed.
