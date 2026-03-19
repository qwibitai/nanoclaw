---
name: make-a-dent
description: Autonomous deep-dive into a kaizen domain — find the root cause category behind repeated issues, fix concrete bugs, add interaction tests, and ship one high-impact PR. Triggers on "make a dent", "hero mode", "deep dive kaizen", "fix the category", "autonomous fix".
---

# Make a Dent — Autonomous Category Killer

**Role:** The hero. When a cluster of kaizen issues share a root cause, this skill finds the category, fixes the concrete bugs, adds tests that prevent the category from recurring, and ships it all in one PR. Works autonomously — the user is not available for feedback.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"Compound interest is the greatest force in the universe"* and *"An enforcement point is worth a thousand instructions."*

**When to use:**
- There's a cluster of related open kaizen issues (3+) with a shared root cause
- Individual fixes would be incremental; fixing the category has compound impact
- The user wants autonomous execution — "make it work, I'm counting on you"
- After `/gap-analysis` identifies a high-impact domain worth a deep dive

## The Algorithm

### Phase 1: Map the Territory (Research, no code changes)

Launch **parallel research agents** to build a complete picture of the target domain:

**Agent A — Issue Archaeology:**
```bash
# All open issues in the target domain
gh issue list --repo Garsson-io/kaizen --state open --limit 100 --json number,title,labels,body,comments

# Closed issues for pattern history
gh issue list --repo Garsson-io/kaizen --state closed --limit 50 --json number,title,labels,body,closedAt
```

Classify each issue: is it a **symptom** (one-off bug) or a **root cause** (category-level problem)?

**Agent B — Code Exploration:**
Read the actual code in the target domain. For hooks, this means:
- Hook files: `.claude/kaizen/hooks/*.sh`
- Shared libraries: `.claude/kaizen/hooks/lib/*.sh`
- Tests: `.claude/kaizen/hooks/tests/test-*.sh`
- Registration: `.claude/settings.json` hooks section
- State management: `/tmp/.pr-review-state/` patterns

Map the **interaction surface**: which hooks talk to each other via state files? What format expectations cross the PreToolUse/PostToolUse boundary?

### Phase 2: Find the Category

From the research, identify:
1. **The pattern**: What type of bug keeps recurring? (format mismatch, allowlist gap, missing test category, etc.)
2. **The root cause**: Why do individual fixes not prevent recurrence? (no interaction tests, no format contract, etc.)
3. **The compound fix**: What single change prevents the entire category?

Write this as a GitHub issue with:
- Problem section: the pattern with concrete issue references
- Root cause: why it keeps happening
- Solution: the compound fix (concrete bugs + category prevention + skill)

### Phase 3: Fix Concrete Bugs (Immediate value)

Fix all the concrete open bugs that are symptoms of the root cause category. These are the "low-hanging fruit" — they unblock agents TODAY.

For each fix:
- Read the hook code carefully
- Make the minimal change
- Run the existing unit tests to verify no regressions

### Phase 4: Add Category Prevention Tests (Compound interest)

Create **interaction tests** that verify the property that individual unit tests miss. The key insight: **test the interaction surface, not just the individual hooks.**

Examples:
- For gate→clear pairs: verify that every format the clear hook accepts also passes through the gate
- For allowlist hooks: verify that every command needed for the workflow is actually allowed
- For state management: verify that clearing one gate doesn't affect another
- For simultaneous gates: verify no deadlocks

### Phase 5: Ship It

1. Create branch and commit all changes
2. Create PR with structured body (summary, test plan, verification)
3. Complete the self-review cycle
4. Queue auto-merge
5. Run kaizen reflection

### Phase 6: Update Issue Metadata

After shipping, update the kaizen backlog:
- Close issues that are fixed by the PR
- Add "related" comments to issues that are partially addressed
- Update labels and priorities on remaining issues in the domain

## Key Principles

1. **Fix symptoms AND the category.** Fixing 3 bugs is good. Fixing 3 bugs + adding tests that catch the next 10 is compound interest.

2. **One PR, not five.** The bugs share a root cause — they belong together. Splitting them into individual PRs loses the narrative and the interaction tests.

3. **Test the interaction surface.** Unit tests verify individual hooks. Interaction tests verify the boundaries between them. Both are needed, but the interaction tests are what prevent category recurrence.

4. **Ship autonomously.** This skill is for when the user trusts you to make good judgement calls. Don't ask for permission on each step — just do the right thing and explain in the PR.

5. **Leave the system better.** The skill itself is part of the fix — it codifies the workflow so the next deep dive is faster.
