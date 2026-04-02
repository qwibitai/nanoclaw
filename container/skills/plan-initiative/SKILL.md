---
name: plan-initiative
description: Transform a brainstormed initiative into an actionable implementation plan with concrete steps. Triggers on "plan this", "make a plan", "how do we build this", or when an initiative needs implementation details.
---

# Plan an Initiative

Turn a brainstormed initiative into an actionable implementation plan. This follows `/brainstorm` which answered WHAT — now we answer HOW.

Adapted from Compound Engineering's ce:plan pattern.

## Initiative

#$ARGUMENTS

**If empty, ask Boris:** "Which initiative should we plan? I'll check the current list."

Ask Boris which initiative to plan — initiatives are managed externally via the FamBot app.

## Execution Flow

### Phase 1: Gather Context

1. Ask Boris for context on the initiative if not provided in $ARGUMENTS
2. Read any relevant family docs (`/workspace/extra/family-vault/MOC.md` first)
4. If there's no brainstorm text yet, suggest running `/brainstorm` first

### Phase 2: Research

Investigate what's needed:
- What exists already that we can build on?
- What are the technical constraints?
- Are there patterns in the codebase to follow?
- What external dependencies or APIs are involved?

### Phase 3: Design the Plan

Write a concrete implementation plan covering:

1. **Goal** — one sentence on what this achieves
2. **Approach** — the chosen strategy and why
3. **Steps** — ordered, actionable items (these become the `- [ ]` checklist)
4. **Open questions** — anything unresolved that needs Boris's input
5. **Verification** — how we'll know it works

Keep it practical. Each step should be something that can be done in one session.

### Phase 4: Write Back

1. Update the initiative's plan text in the initiatives file
2. Replace/update the steps checklist with the new plan steps
3. If the initiative is fully planned, add `[ready]` tag
4. Save the file

### Phase 5: Handoff

Ask Boris:
1. **Mark ready** — initiative is planned and actionable
2. **Refine** — adjust the plan
3. **Start working** — run `/work` to begin execution
4. **Done for now** — come back later

## Guidelines

- **Be concrete** — "Implement X in file Y" not "Consider implementing X"
- **Right-size steps** — each step = one working session, not one line of code
- **Reference existing patterns** — if NanoClaw already does something similar, say so
- **Flag risks** — highlight anything that could block or surprise us
- **Share your plan** with Boris so he can review and iterate
