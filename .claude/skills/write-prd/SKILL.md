---
name: write-prd
description: Plan a large body of work through iterative discovery, producing a spec document, GitHub issue, and docs-only PR. Leaves enough context for a future implementor. Triggers on "write prd", "plan large work", "write spec", "plan initiative", "architecture spec", "write MRD", "plan epic".
---

# Plan Large Work — Iterative Discovery to Spec

This skill guides you through planning a large initiative — from fuzzy idea to a structured spec document that a future implementor can pick up and execute. The output is a docs-only PR with a GitHub issue as the tracking anchor.

**When to use:** The work is too large to start coding immediately. You need to think through the problem space, make architectural decisions, identify risks, and leave a trail of reasoning for whoever implements it (including your future self).

**What you produce:**
1. A spec document in `docs/` (the single source of truth)
2. A GitHub issue (the tracking anchor for all future implementation)
3. A docs-only PR (reviewable, versionable)

## Phase 1: Understand the Initiative

Ask the user to describe what they want to build. Then ask yourself (and them) these questions to build context:

### Problem Space
- **What problem are we solving?** Get specific — not "better security" but "Customer A's MRI scan must never leak to Customer B's agent context."
- **Who experiences the problem?** End users, operators, developers, the system itself?
- **What happens today?** How does the current system handle (or fail to handle) this?
- **What's the cost of not solving it?** Business risk, user trust, operational burden?

### Solution Space
- **What does "good" look like?** Describe the desired end state, not the implementation.
- **What are the constraints?** Budget, timeline, compatibility, regulatory, team skills?
- **What's explicitly out of scope?** Name things that are adjacent but NOT part of this work.

### Threat/Risk Models (if applicable)
- **What can go wrong?** Data leakage, privilege escalation, state corruption, race conditions.
- **What are the isolation boundaries?** What should NOT be able to see/touch what?
- **What are the trust boundaries?** Who/what is trusted vs untrusted?

Don't try to answer everything in one pass. This is iterative — ask, listen, probe, clarify.

## Phase 2: Iterative Discovery

This is the core of the skill. You and the user go back and forth to build shared understanding. The pattern:

```
YOU: Present your understanding + specific questions
USER: Answers, corrects, adds context
YOU: Incorporate, identify new questions or contradictions
USER: Clarifies
... repeat until the model is stable ...
```

### How to drive discovery

1. **State your understanding explicitly.** Don't assume — write it out so the user can correct it. Use tables and diagrams to make structure visible.

2. **Ask pointed questions, not open-ended ones.** Not "what about security?" but "Should the router have access to customer files, or only case summaries?"

3. **Present options with tradeoffs.** When there's a design choice, lay out 2-3 options with pros/cons and state your lean. Let the user decide.

4. **Track what's decided vs what's open.** Maintain a running mental model of:
   - Decided: things you've agreed on
   - Open: things that need more thinking
   - Deferred: things explicitly punted to future work

5. **Challenge the user's assumptions constructively.** If something seems over-engineered or under-specified, say so. "The product thinking has merit, but the engineering needs figuring out" is a valid thing to say.

6. **Separate product thinking from engineering.** Product = what and why. Engineering = how. Get the product right first, then figure out the engineering. But flag early if the engineering looks infeasible for the product vision.

### Signs you're ready to move on
- The user stops adding new concepts
- Open questions are about implementation details, not fundamentals
- You can describe the system to someone who wasn't in the conversation and they'd understand it
- The user says "yes, write it" or equivalent

## Phase 3: Write the Spec Document

Create ONE document (not three). At this stage the MRD, PRD, and architecture are tightly coupled — splitting them adds cross-referencing overhead without clarity.

### File location and naming

```
docs/{kebab-case-initiative-name}-spec.md
```

Example: `docs/case-isolation-spec.md`, `docs/crm-integration-spec.md`

### Document structure

```markdown
# {Initiative Name} — Specification

## 1. Problem Statement

What problem we're solving, who experiences it, what happens today, and why it matters.
Include concrete examples (the "MRI scan" example, not abstract descriptions).

### Threat / Risk Model (if applicable)
- Enumerate specific threats with concrete scenarios
- For each: what's at risk, likelihood, impact, current mitigation (if any)

## 2. Desired End State

What "good" looks like. Describe the system as if it's already built.
- What can users do that they couldn't before?
- What guarantees does the system provide?
- What is explicitly NOT in scope?

## 3. Roles & Boundaries

Who/what are the actors in the system? What can each do, what can't they?
Use a table:

| Role | Can do | Cannot do | Data access | Tools |
|------|--------|-----------|-------------|-------|
| ... | ... | ... | ... | ... |

## 4. Architecture & Isolation Model

How the system enforces the boundaries from section 3.
- Layer diagram (what enforces what)
- Per-layer: what it enforces, what it doesn't, residual risks
- State management: what persists where, what survives restarts

## 5. Interaction Models

Walk through key user scenarios end-to-end:
- Happy path (everything works)
- Edge cases (concurrent users, agent recycling, identity merge)
- Error cases (what happens when X fails?)

Use numbered step-by-step flows, not prose.

## 6. State Management

For each stateful component:
- What state it holds
- Where it's stored (memory, disk, DB, external service)
- What survives container restart / agent recycle
- What's lost and how it's recovered

## 7. What Exists vs What Needs Building

Two tables:

### Already Solved
| Capability | Current implementation | Status |
|------------|----------------------|--------|

### Needs Building
| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|

## 8. Open Questions & Known Risks

Things that need more thinking before or during implementation.
For each: state the question, list options, note your lean if you have one.

## 9. Implementation Sequencing (Optional)

If you have a sense of build order, sketch it. What depends on what?
What can be built in parallel? What's the MVP vs the full vision?
```

### Writing guidelines

- **Be concrete, not abstract.** "Customer A's MRI scan" > "sensitive data." Show the scenario.
- **Show your reasoning.** Don't just state decisions — explain WHY. The implementor needs to know the reasoning to make good judgment calls when they hit edge cases you didn't anticipate.
- **Tables over prose.** When comparing options, listing capabilities, or mapping relationships — use tables. They're scannable and precise.
- **Diagrams in ASCII.** Keep them in the markdown. No external tools needed.
- **Name residual risks.** No design is perfect. Calling out what's NOT solved builds trust and prevents false confidence.
- **Link decisions to their rationale.** When you chose option A over B, say why. When you deferred something, say why it's safe to defer.

### Progressive detail — the most important writing principle

**Detail the problem space fully. Detail solutions only at the current level.**

A spec should define the problem taxonomy with high resolution — what the levels are, what capabilities each level requires, where we are today. Think Kardashev scale (energy), SAE levels (autonomous driving), or CMMI (process maturity). The taxonomy itself is the most valuable artifact. It gives shared vocabulary and direction.

But solution detail should be *progressive*: dense for the level we're at or about to reach, sketched for the next level, and deliberately left open beyond that.

**Example of what this looks like:**

If a system is at Level 3 of a 10-level taxonomy:
- **Level 3 (current):** Full problem analysis. Concrete solution design. Implementation-ready detail.
- **Level 4 (next):** Problem defined. Rough solution outline. Key open questions identified.
- **Level 5-7 (horizon):** Problem described. Solution left as "we will need X capability." No design.
- **Level 8-10 (vision):** One sentence each. The impossible ideal we climb toward.

**Why this matters:**
- Premature specification is the root of all evil. Designing a Level 10 solution while at Level 3 produces speculative architecture that constrains future thinking without providing current value.
- The problem taxonomy ages well. The Kardashev scale was defined in 1964 and is still useful. The specific engineering designs from 1964 are not.
- Progressive detail naturally creates open questions — "what does Level 6 look like in practice?" — which is exactly what a spec should leave for future work.
- When you reach Level 4, you refine its section with full detail and sketch Level 5. The spec evolves as understanding deepens.

**Anti-pattern: "Coverage Dashboard."** If you're at L1 (instructions in a doc), don't design the CI-integrated dashboard that auto-generates coverage matrices. Instead: define the *need* ("we need a way to see where we are"), note the *current state* ("today it's a manual Markdown table"), and leave the solution as an open question for when you're actually at the level where a dashboard makes sense.

**The test:** For every solution paragraph, ask: "Are we at the level where this solution is the next step?" If no, replace the solution with a problem statement and an open question.

## Phase 4: Create the GitHub Issue

The issue is the epic anchor. Keep it short — the spec document has the details.

```bash
gh issue create --repo {repo} --title "{Initiative Name}" --body "$(cat <<'EOF'
## Summary

{2-3 sentences: what this initiative is and why it matters}

## Spec

See [`docs/{name}-spec.md`](link-to-file-in-PR) for the full specification.

## Status

- [ ] Spec reviewed and approved
- [ ] Implementation planning (break into sub-issues)
- [ ] Implementation
- [ ] Verification

## Labels

epic, {relevant-domain-labels}
EOF
)"
```

## Phase 5: Create the Docs-Only PR

The PR contains ONLY the spec document. No code changes.

```bash
# Create branch
git checkout -b docs/{initiative-name}-spec

# Add spec
git add docs/{name}-spec.md

# Commit
git commit -m "docs: add {initiative name} specification

Covers problem statement, architecture, isolation model,
interaction flows, and open questions.

References: #{issue-number}"

# Push and create PR
git push -u origin docs/{initiative-name}-spec

gh pr create --repo {repo} \
  --title "docs: {initiative name} specification" \
  --body "$(cat <<'EOF'
## Summary

Adds the specification document for {initiative name}.

This is a **docs-only PR** — no code changes. The spec covers:
- Problem statement and threat model
- Architecture and isolation design
- Interaction models and state management
- What exists vs what needs building
- Open questions and known risks

Closes #{issue-number}

## Review guidance

- Does the problem statement capture the real risks?
- Are the isolation boundaries sufficient?
- Are there missing interaction scenarios?
- Are the open questions the right ones?

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## Anti-Patterns

Things this skill is NOT for:

- **Small features.** If you can describe it in a paragraph, just do it. No spec needed.
- **Bug fixes.** The bug IS the spec. Fix it, write tests, move on.
- **Implementation planning for an approved spec.** That's task breakdown, not discovery. Use `/plan-work` to break a spec into PRs and issues.
- **Ongoing documentation.** This produces a point-in-time spec. It will evolve during implementation via subsequent PRs.
- **Designing solutions for distant levels.** If you define a 10-level taxonomy and you're at level 3, don't design the level 8 solution. Define what level 8 *requires* (the problem), not how to build it (the solution). Leave it as an open question.

## Tips for the Implementor (Meta)

When you're the future agent picking up a spec created by this skill:

1. **Read the whole spec before starting.** Don't jump to "Needs Building" — the reasoning in earlier sections will save you from wrong turns.
2. **Check the Open Questions section.** Some may have been resolved since the spec was written. Some may block your work until answered.
3. **The spec is a starting point, not a contract.** Implementation will reveal things the spec didn't anticipate. Update the spec as you go (new PRs, not edits to the original).
4. **Respect the "Why" sections.** If you're tempted to take a shortcut that contradicts the stated reasoning, stop and think. The reasoning exists because someone thought hard about it. If you still disagree, raise it — don't silently diverge.

## Write for Deletion

A spec will be subjected to the five-step algorithm when implementation begins (`/implement-spec`): question requirements, delete, simplify, accelerate, automate. Write your spec expecting this. Specifically:

- **Make sections independently evaluable.** Each section should be deletable without breaking the rest. If someone applies step 2 (delete) and removes the "Coverage Dashboard" section, the remaining spec should still make sense.
- **Separate the problem taxonomy from proposed solutions.** The taxonomy (what the levels are, what capabilities each level requires) ages well and is hard to delete. The proposed solutions age poorly and should be easy to delete. Keep them in distinct sections.
- **Mark confidence levels.** "This is the problem" vs "this is one way to solve it" vs "this is a guess." The implementor needs to know which parts to trust and which to re-examine.
- **Don't bury decisions in prose.** Make them findable, so step 1 (question requirements) can be done efficiently. Tables and explicit "Decision: X because Y" callouts are better than decisions embedded in paragraphs.

The best spec is one where an implementor can read it, delete 40% of it, and still have a clear direction. If deleting any section makes the spec incoherent, the spec is too tightly coupled.

## What Comes Next

After the spec is merged and reviewed:
- Use **`/accept-case`** to evaluate whether to proceed, gather incidents, and find low-hanging fruit.
- Use **`/implement-spec`** to bridge spec to code — re-examine against current reality, apply the five-step algorithm, and execute incrementally.
- Use **`/plan-work`** when implementation is too big for one PR — break into independent, sequenced PRs with dependency graph and sub-issues.

### Recursive Kaizen

These skills are the improvement system. The improvement system should improve itself. After using `/write-prd`, reflect: did the spec help implementation or constrain it? Was the progressive detail at the right granularity? Did the problem taxonomy age well? Capture these observations in kaizen reflections — they're the raw material for improving how we write specs. See `/implement-spec` for the fuller picture.
