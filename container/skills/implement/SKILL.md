---
name: implement
description: Execute implementation plan step-by-step
user-invocable: true
---

# Implement Plan

You are tasked with implementing an approved technical plan from `plans/`. These plans contain phases with specific changes and success criteria.

## Getting Started

When given a plan path:
- Read the plan completely and check for any existing checkmarks (- [x])
- Read the original requirements and all files mentioned in the plan
- **Read files fully** - never use limit/offset parameters, you need complete context
- Think deeply about how the pieces fit together
- Create a todo list to track your progress
- Start implementing if you understand what needs to be done

## Execution Mode Detection

After reading the plan, check for wave metadata:

1. **Scan all `## Phase` sections** for `<!-- wave:` comments
2. **If wave metadata found** -> enter Wave Execution Mode
3. **If no wave metadata** -> enter Sequential Execution Mode (current behavior)

## Wave Execution Mode

Execute phases grouped by wave number:

### For each wave (Wave 1, Wave 2, ...):

**Single-phase wave**: Execute inline (same as sequential -- avoids spawn overhead).

**Multi-phase wave**: Spawn parallel Task agents:

```
For each phase in this wave, spawn:

Task(
  prompt: "Implement Phase {N}: {title}

  Plan: {plan_path}
  Phase: {N} only

  Read the plan and implement ONLY Phase {N}.
  Follow Changes Required exactly.
  Run Success Criteria checks.
  Update plan checkboxes when done.

  Files you own (ONLY modify these): {files from wave comment}

  Report: what was implemented, tests passing, any deviations.",

  subagent_type: "general-purpose"
)
```

**Wait for ALL agents** in the wave before starting next wave.

**On failure**: Stop and report:
```
Wave {N} execution:
  Succeeded: Phase {X}, Phase {Y}
  Failed: Phase {Z} -- {reason}

Options:
1. Retry failed phase only
2. Continue to next wave (skip failed)
3. Fall back to sequential for remaining phases
```

**After each wave**: Verify no file ownership conflicts via `git diff --name-only`.

## Sequential Execution Mode

If no plan path provided, ask for one.

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:
- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections

When things don't match the plan exactly, think about why and communicate clearly. The plan is your guide, but your judgment matters too.

If you encounter a mismatch:
- STOP and think deeply about why the plan can't be followed
- Present the issue clearly:
  ```
  Issue in Phase [N]:
  Expected: [what the plan says]
  Found: [actual situation]
  Why this matters: [explanation]

  How should I proceed?
  ```

## Implementation Steps

### Phase-by-Phase Execution

For each phase in the plan:

1. **Understand the Phase**:
   - Read the phase overview and success criteria
   - Identify all files that need changes
   - Understand the dependencies between changes

2. **Implement Changes**:
   - Make the specified code changes
   - Follow the existing code style and conventions
   - Add necessary imports and dependencies
   - Ensure changes are consistent across files

3. **Verify as You Go**:
   - After implementing a component, run relevant tests
   - Fix any issues before proceeding
   - Don't let errors accumulate

4. **Update Progress**:
   - Check off completed items in the plan using Edit
   - Update your TodoWrite list
   - Document any deviations from the plan

5. **Update project state** (if `.planning/` exists):
   - After completing each phase: Update `.planning/STATE.md` with progress
   - Record deviations in `.planning/phases/{phase}/SUMMARY.md` if it exists
   - Mark completed requirements in `.planning/REQUIREMENTS.md`

### Verification Approach

After implementing a phase:
- Run the automated success criteria checks
- Fix any issues before proceeding
- Update your progress in both the plan and your todos
- Check off completed items in the plan file itself using Edit

Don't let verification interrupt your flow - batch it at natural stopping points.

### Checkpoint Handling

When you encounter a checkpoint marker in the plan:

**`[CHECKPOINT:human-verify]`**:
1. Present what was built and verification steps
2. Wait for user approval
3. On "approved": continue to next phase
4. On issues reported: fix and re-present

**`[CHECKPOINT:decision]`**:
1. Present the options with trade-offs from the plan
2. Wait for user to choose
3. Document the decision in plan file
4. Continue with chosen path

**`[CHECKPOINT:human-action]`**:
1. Clearly state what the user needs to do
2. Wait for confirmation that it's done
3. Verify the action took effect (if possible)
4. Continue implementation

**Automation-first rule**: Before creating any checkpoint, verify Claude cannot perform the action itself via CLI, API, or file operations. Checkpoints verify after automation, never replace it.

### Testing Strategy

Follow the plan's testing strategy:
- Write unit tests for new functionality
- Update existing tests affected by changes
- Run integration tests to verify end-to-end behavior
- Document any manual testing performed

## Handling Issues

### When Something Doesn't Work

1. **First, verify your understanding**:
   - Re-read the relevant part of the plan
   - Check if you've missed a dependency
   - Look for related code that might provide context

2. **Debug systematically**:
   - Use logging to understand what's happening
   - Check error messages carefully
   - Verify assumptions about data flow

3. **If stuck, document and ask**:
   - Clearly describe what you expected
   - Show what actually happened
   - Explain what you've tried
   - Ask for specific guidance

### When the Codebase Has Changed

If the codebase has evolved since the plan was written:
- Document the differences you've found
- Propose adaptations that maintain the plan's intent
- Get confirmation before proceeding with major changes

## Resuming Work

If the plan has existing checkmarks:
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

## Best Practices

1. **Maintain Forward Momentum**:
   - Complete one thing fully before starting another
   - Don't leave partially implemented features
   - Fix issues as you encounter them

2. **Communicate Progress**:
   - Update the plan document with checkmarks
   - Use TodoWrite to track detailed progress
   - Report completion of major milestones

3. **Quality Over Speed**:
   - Ensure each change is correct and tested
   - Follow existing patterns and conventions
   - Don't skip verification steps

4. **Document Deviations**:
   - If you need to deviate from the plan, document why
   - Propose alternatives that achieve the same goal
   - Get approval for significant changes

## Completion Checklist

Before considering implementation complete:

- [ ] All phases implemented
- [ ] All automated tests passing
- [ ] Manual verification completed
- [ ] Plan document updated with all checkmarks
- [ ] Any deviations documented
- [ ] Code follows project conventions
- [ ] No TODO comments left unresolved
- [ ] Performance considerations addressed

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.
