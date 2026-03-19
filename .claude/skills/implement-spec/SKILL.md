---
name: implement-spec
description: Take a spec from PRD to working code. Re-examines the spec against current reality, finds concrete next steps, and executes. Guided by the Zen of Kaizen (see .claude/kaizen/zen.md). Triggers on "implement spec", "implement prd", "start implementation", "pick up spec", "execute spec". ALSO triggers on greenlight phrases after discussing concrete work — "lets do it", "go ahead", "build it", "start on this", "do it", "make it happen", "go for it", "ship it", "yes do it". If a specific piece of work (issue, PR, case, spec) was just discussed and the user gives a go-ahead, this skill drives the implementation. Always create a case first (all dev work must be in a case with its own worktree per CLAUDE.md).
---

# Implement Spec — From PRD to Working Code

**Role:** The execution engine. Takes scope decided by `/accept-case` and turns it into working code. Does NOT decide scope — if re-examination reveals the scope should change, escalate to the admin or loop back to `/accept-case`.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"Specs are hypotheses. Incidents are data."* and *"The most dangerous requirement is the one nobody re-examined."*

**When to use:**
- An `/accept-case` evaluation said "proceed with implementation"
- A spec exists (from `/write-prd`) and implementation is starting
- You're picking up a spec that was written days/weeks ago
- You've finished one phase of implementation and need to plan the next

**The key insight:** Specs rot. The codebase has changed. Understanding has deepened. Things that seemed important when the spec was written may be irrelevant now. Things the spec didn't anticipate may be obvious now. The spec's value is the *problem taxonomy and direction*, not the specific solutions it proposed.

## Case Gate — MANDATORY before writing any code

Before touching any source code, verify a case exists. The `enforce-case-exists.sh` hook (Level 2) will block edits in worktrees without a case, but you should create the case proactively rather than being blocked.

**Checklist:**
1. **Case exists in DB** for the current branch:
   ```bash
   npx tsx src/cli-kaizen.ts case-by-branch "$(git rev-parse --abbrev-ref HEAD)"
   ```
2. **Case has `github_issue` linked** (when working on a kaizen issue)
3. **Case status is `ACTIVE`**

If any check fails, create the case via the CLI before proceeding:
```bash
npx tsx src/cli-kaizen.ts case-create --description "your description" --type dev --github-issue N
```
For kaizen issues, always pass `--github-issue` to link the case to the existing issue. Container agents should use `case_create` MCP tool instead.

**Naming convention for kaizen work:** `YYMMDD-HHMM-kNN-kebab-description` (e.g., `260318-2107-k21-fix-newline-prefix`). The `kNN` segment embeds the kaizen issue number, making it visible in worktree names, branch names, and `git worktree list` output — even if the DB step is somehow skipped.

## Re-examine the Spec

Before touching code, re-examine the spec against current reality. *"Specs are hypotheses. Incidents are data."*

### Question the requirements

Every requirement in the spec was added by someone smart at some point. That doesn't make it right *now*.

**For each section of the spec, ask:**
- Is this still true? Has the codebase changed since this was written?
- Is this still needed? Has the problem been partially solved by other work?
- Who added this requirement? (Check git blame on the spec.) Are they still the right person to validate it?
- What happens if we just... don't do this part?

**Concrete actions:**
- Re-read the spec's problem statement. Do the incidents it cites still reproduce?
- Check git log since the spec was merged. Did any PR already address part of it?
- Check if any "Needs Building" items from the spec now exist.
- Check if any "Open Questions" from the spec have been answered by subsequent work.

*"The most dangerous requirement is the one everyone assumes is true but nobody has re-examined."* A spec written when we were at L5 on the test ladder might propose L6 infrastructure that's already been built. A spec that assumed `processGroupMessages` was untestable might not know about a recent DI refactor.

### Check freshness, not scope

This step is about **accuracy** — is the spec still true? — not about **scope** — can we do less? Scope was decided in `/accept-case`.

If re-examination reveals something significant has changed (e.g., half the spec was already built by another PR, or a key assumption is wrong), **don't unilaterally skip it**. Flag it to the admin: "The spec assumed X but Y is now true — should we adjust scope?" That's an accept-case decision, not an implementation decision.

**The spec was written to be complete. Implementation should match the problem.** Not everything in the spec needs to be built right now — but what you do build should be built well. *"Avoiding overengineering is not a license to underengineer."*

## Kaizen Issue Lifecycle Tracking

When implementing work linked to a kaizen issue, maintain the issue's status throughout the lifecycle. This prevents other agents from picking the same work and provides visibility into progress.

### On case creation

When creating a dev case for a kaizen issue, **always pass the kaizen issue number as `githubIssue`** in the case creation request. Do NOT let the system auto-create a new issue — the kaizen issue already exists and should be reused.

The L3 enforcement in `ipc-cases.ts` will:
- Auto-sync `status:active` label to the kaizen issue via `case-backend-github.ts`
- Block creation if another active case already references this issue (collision detection)

### On PR creation

After creating a PR, link it to the kaizen issue and ensure auto-closure on merge:
```bash
# Add has-pr label
gh issue edit {N} --repo Garsson-io/kaizen --add-label "status:has-pr"
# Add PR link as comment
gh issue comment {N} --repo Garsson-io/kaizen --body "PR: {pr_url}"
```

**CRITICAL: The PR description body MUST include `Fixes Garsson-io/kaizen#{N}`** (with the cross-repo prefix). This tells GitHub to auto-close the kaizen issue when the PR merges. Without this, issues stay open after PRs merge and epic progress tracking breaks.

### On case completion

The L3 enforcement in `case-backend-github.ts` handles this automatically:
- Syncs `status:done` label to the kaizen issue
- Closes the issue if the case is marked done

You don't need to manually update labels on completion — the code does it.

### On sub-issue closure — update the parent epic

When a sub-issue is closed (either by PR merge or case completion), **update the parent epic issue body**:

1. **Check off the completed item** in the Progress checklist (`- [x] #N`)
2. **Update "Current State"** with what was actually built (1-2 sentences)
3. **Update "Next Step"** with the recommended next sub-issue and why

```bash
# Find the parent epic — look for task list references to this issue
gh issue list --repo Garsson-io/kaizen --state open --label "kaizen" --search "#{N}" --json number,title
# Then edit the epic body with updated progress
gh issue edit {EPIC} --repo Garsson-io/kaizen --body "$(cat <<'BODY'
... updated body with checked items, current state, next step ...
BODY
)"
```

This keeps the epic as a living dashboard. `/pick-work` reads the epic's "Next Step" to boost scoring for the recommended follow-up work.

## Testability Pre-Flight — BEFORE writing code

Before adding logic to an existing file, assess the testability cost. *"Avoiding overengineering is not a license to underengineer."*

**For each file you're about to modify, ask:**
- How many imports does this file have? (Check the import block at the top.)
- If I add branching logic here, how many modules would I need to mock to test it?
- If the answer is >3 mocks, **extract the new logic into a separate, testable function or file first** — then call it from the existing file.

**This is not about scope reduction** — it's about doing the work in a way that's testable from the start, not discovering testability problems after the code and tests are written.

**The signal to watch for:** You're about to add an if-branch to a 500+ line file with 10+ imports. Stop. Extract first, then add.

## TDD — Write Failing Tests First (MANDATORY)

After re-examining the spec and before writing any production code, write failing tests that express the target invariants. This is not just about test coverage — **tests-first is a diagnostic tool** that reveals bugs and misunderstandings that code reading alone misses.

*Incident that motivated this: kaizen #120 — TDD revealed a second bug (null `github_issue_url`) that pure code reading missed. The failing test was the diagnostic that found the real bug surface.*

### The RED-GREEN-REFACTOR cycle

**RED — Write failing tests first:**
1. State the invariants explicitly (per CLAUDE.md's Invariant Statement requirement)
2. Write test file(s) expressing the target behavior — what SHOULD be true after the fix
3. Run the tests. **They must fail.** If they pass, either:
   - The problem is already fixed (re-examine — is this work still needed?)
   - Your tests aren't testing the right thing (fix the tests)
4. Confirm they fail **for the expected reason** — not for an import error, mock issue, or unrelated crash

**GREEN — Write minimal production code:**
5. Make the failing tests pass with the simplest correct change
6. Run the full test suite — no regressions

**REFACTOR — Clean up:**
7. Improve code structure if needed, keeping tests green

### Why this ordering matters

- **Tests written after code** verify what you built — they confirm your implementation, not your understanding
- **Tests written before code** verify what should be true — they catch gaps in your mental model
- **Unexpectedly passing tests** reveal that the problem is different than you thought (kaizen #120: the host-side handler already worked, the bug was elsewhere)
- **Unexpectedly failing tests** reveal bugs you hadn't noticed (kaizen #120: `github_issue_url` was null — a second bug invisible during code reading)

### When to skip (rare)

TDD may not apply when:
- The change is purely docs/config with no testable behavior
- You're writing a spec or PRD (no production code)
- The change is a one-line fix where the existing test suite already covers the invariant (state why in the PR)

When you skip TDD, say so in the PR body and explain why.

## The Implementation Loop

After writing failing tests, you have both a refined understanding AND a concrete definition of done. Now execute:

### 1. State what you're building

One paragraph. What's the concrete deliverable? Not "implement the test ladder spec" but "add mount-security unit tests covering symlink traversal and blocked pattern matching, bringing X3 from None to L2."

### 2. Check the progressive detail principle

The spec should have detailed solutions for the current level and rough outlines for the next level. If you're about to implement something the spec left as a rough outline, that's a signal: you need to refine the spec for this level before coding. Add detail to the spec (as a new commit in the implementation PR or a separate docs PR) and then implement against the refined spec.

If you're about to implement something the spec left as an open question, **stop**. That's a signal the spec needs another round of `/write-prd` or `/accept-case` for this specific area. Don't design and implement in the same breath — that's how you get solutions that weren't examined.

### 3. Find the low-hanging fruit

What's the smallest change that:
- Moves a capability up at least one ladder rung?
- Is testable (you can prove it works)?
- Is independently valuable (doesn't depend on future PRs to be useful)?

This is your first PR. Ship it. Get feedback. Then repeat.

### 4. After each phase, update the PRD

When you complete a phase (or a meaningful chunk of a phase), **update the spec document before moving on**. This is not optional — a stale spec is actively harmful because it creates false confidence about what's planned vs what's real.

**The update follows the progressive detail principle:**

1. **Move completed work to "Already Solved"** (Section 7 or equivalent). Record what was actually built, not what the spec predicted. Include learnings — e.g., "DI refactor was simpler than expected because the module had few callers" or "blocked pattern matching had a subtle bug the spec didn't anticipate."

2. **Refine the next phase with real detail.** Now that you've done Phase N, you know things the spec author didn't. Phase N+1's rough outline should become concrete: specific files, specific test counts, specific DI interfaces. This is the detail level that Phase N had before you started it.

3. **Be selective about touching future phases.** A spec has two kinds of content: *problem taxonomy* (what the levels/categories/capabilities are, what each proves, what each misses) and *solution detail* (specific files to change, test counts, implementation strategies). Problem taxonomy is the Kardashev scale — it ages well and must never be trimmed. For solution detail in future phases: **most of the time, leave it alone.** It was written thoughtfully and will be re-examined when that phase begins. The main action is **adding** implementation hints when the current phase produced genuine insight relevant to a future phase — e.g., "the DI pattern in mount-security.ts was simpler than expected; index.ts may benefit from the same approach." As the spec matures through multiple phases, future steps will already be well-specified and rarely need changes. Trim future solution detail if it's actively misleading (contradicts what you just learned) or if the spec is genuinely too prescriptive about implementation for distant phases — but never as a routine cleanup step. The judgment call is: "Is this detail constraining future implementors more than it's helping them?"

4. **Update the gap analysis.** Capabilities that climbed a rung should be updated in the inventory. New gaps discovered during implementation should be added.

**The rhythm:** implement → update spec → implement next → update spec. The spec evolves as a living document, getting more detailed at the frontier and more abstract in the distance. Git history preserves the original detail for anyone who wants it.

**Anti-pattern: "I'll update the spec later."** You won't. The learnings are freshest right after implementation. The update is part of the phase, not an afterthought.

### 4b. Documentation and policy deliverables

When your implementation introduces **new operational processes** — scripts operators must run, policies for when to clean up resources, new lifecycle management, new scheduled tasks — you must produce documentation alongside the code. Code without docs creates tribal knowledge that agents and humans can't discover.

**Ask yourself:** "If someone encounters this system for the first time in 3 months, what do they need to know to operate it?" If the answer is more than "read the code," write docs.

**What to produce:**

1. **Operational documentation** (`docs/{feature-name}.md`): How it works, when to run it, what the policy is. Written for operators (both human and agent). This document captures **what we built and why** — not the implementation plan (that's in the PRD/issue), but the lasting description of the system as it exists now, plus the vision for where it's going.
2. **CLAUDE.md section**: Brief policy summary that agents see in every conversation. Link to the full docs. Keep it to 5-10 lines — CLAUDE.md is expensive context.
3. **Skill (if interactive)**: When the feature has a "run this when X happens" flow, create a skill that guides the user through it (e.g., `/docker-gc` for cleanup workflows).

**Issue-only PRDs → repo docs:** When the PRD lives only in a GitHub issue (not a `docs/*-spec.md` file), the knowledge about what was built and the future vision must still land in the repo. GitHub issues are ephemeral — they get closed, buried, and disconnected from the code. The repo docs (`docs/{feature}.md`) are the lasting record. After implementation, the repo doc should contain:
- **What we built** — the system as it exists now, with concrete details
- **Operating policy** — when to run what, what the thresholds are
- **Future vision** — deferred work, next steps, where this is heading
- **Design decisions** — why we chose X over Y (from the PRD discussion)

This is not duplicating the issue — it's transforming planning artifacts into lasting system documentation.

**When to skip:** Pure library code, internal refactors, bug fixes, test additions — these don't need operational docs. The test is: does this change introduce a new **operational process** that someone needs to know about?

**Anti-pattern: "The code is self-documenting."** Shell scripts with `--help` flags are not documentation. They tell you what flags exist, not when to run the command, what the policy is, or what happens if you don't.

### 5. Re-enter the loop

After updating the spec, the landscape has changed:
- New information may have emerged — does it change the plan?
- The next step may be different than you expected — re-apply the five steps
- The refined Phase N+1 section is now your implementation target

**Don't treat the spec as a checklist to grind through.** Treat it as a map that gets more detailed as you explore the territory.

## Relationship to Other Skills

```
/write-prd          → Defines the problem space and taxonomy. Progressive detail.
                       Output: spec document, kaizen issue.

/accept-case        → Evaluates whether to proceed. Gathers incidents,
                       finds low-hanging fruit, gets admin input.
                       Output: go/no-go, concrete direction.

/implement-spec     → THIS SKILL. Bridges spec to code.
  (this skill)         Re-examines spec, execute loop.
                       Output: working code, PRs, updated spec.

/plan-work          → Breaks a large implementation into sequenced PRs.
                       Use WITHIN this skill when the work is too big
                       for one PR but the direction is clear.
                       Output: dependency graph, sub-issues.

/kaizen             → Reflection after implementation. What did we learn?
                       What should we do differently next time?
                       Output: kaizen reflections, new issues.
```

The flow is usually: `write-prd → accept-case → implement-spec → kaizen`. But it's not always linear — `implement-spec` may loop back to `write-prd` when it discovers the spec needs more detail for the current level, or to `accept-case` when implementation reveals the problem is different than expected.

## Anti-patterns

- **Spec-as-checklist.** Grinding through every spec section in order, implementing what it says regardless of whether the world has changed. The spec is a map, not a contract.
- **Implementing open questions.** If the spec says "open question: how should X work?" and you answer it *while coding*, you skipped the thinking phase. Refine the spec first.
- **Skipping re-examination.** Jumping straight to coding without questioning whether the requirements are still valid. This is how you implement solutions to problems that no longer exist. *"The most dangerous requirement is the one nobody re-examined."*
- **Gold-plating.** Adding capabilities the spec mentions as "future work" because you're already in the code. Future work is future work. Ship the current step.
- **Ignoring new information.** Something you discovered during implementation contradicts the spec. Instead of updating the spec and adjusting, you forge ahead with the original plan. *"Specs are hypotheses. Incidents are data."*
- **Big-bang implementation.** "I'll implement the whole spec in one PR." No. Find the smallest valuable step. Ship it. Loop.

## Recursive Kaizen — Improving the Improvement Process

*"It's kaizens all the way down."* — Zen of Kaizen

This skill is part of the improvement system: `write-prd → accept-case → implement-spec → kaizen`. That system itself should improve over time. See the [Zen of Kaizen](../../kaizen/zen.md) for the full philosophy.

The kaizen reflection that fires on `case_mark_done` already captures impediments. If those reflections include "the spec was over-specified for this problem" or "I implemented unnecessary code because I didn't re-examine the spec," that's process feedback, not just work feedback. These reflections, accumulated over many cases, are the raw material for improving the skills themselves.

**Apply these skills to these skills.** When you use `/implement-spec`, ask: did the re-examination surface the right things? Did accept-case catch the right issues? When you notice something, mention it in the kaizen reflection. That's how the improvement process improves itself.
