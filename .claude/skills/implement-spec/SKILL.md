---
name: implement-spec
description: Take a spec from PRD to working code. Re-examines the spec against current reality, applies the five-step algorithm (question, delete, simplify, accelerate, automate), finds concrete next steps, and executes. Triggers on "implement spec", "implement prd", "start implementation", "pick up spec", "execute spec". ALSO triggers on greenlight phrases after discussing concrete work — "lets do it", "go ahead", "build it", "start on this", "do it", "make it happen", "go for it", "ship it", "yes do it". If a specific piece of work (issue, PR, case, spec) was just discussed and the user gives a go-ahead, this skill drives the implementation. Always create a case first (all dev work must be in a case with its own worktree per CLAUDE.md).
---

# Implement Spec — From PRD to Working Code

A spec is a hypothesis written in the past. This skill bridges the gap between "spec exists" and "code ships" by re-examining the spec against current reality, finding the concrete next step, and executing it.

**When to use:**
- A spec exists (from `/write-prd`) and implementation is starting
- You're picking up a spec that was written days/weeks ago
- You've finished one phase of implementation and need to plan the next
- An `/accept-case` evaluation said "proceed with implementation"

**The key insight:** Specs rot. The codebase has changed. Understanding has deepened. Things that seemed important when the spec was written may be irrelevant now. Things the spec didn't anticipate may be obvious now. The spec's value is the *problem taxonomy and direction*, not the specific solutions it proposed.

## Case Gate — MANDATORY before writing any code

Before touching any source code, verify a case exists. The `enforce-case-exists.sh` hook (Level 2) will block edits in worktrees without a case, but you should create the case proactively rather than being blocked.

**Checklist:**
1. **Case exists in DB** for the current branch:
   ```bash
   BRANCH=$(git rev-parse --abbrev-ref HEAD) node -e "const db=require('better-sqlite3')('store/messages.db'); console.log(JSON.stringify(db.prepare('SELECT name, status, github_issue FROM cases WHERE branch_name = ?').all(process.env.BRANCH), null, 2))"
   ```
2. **Case has `github_issue` linked** (when working on a kaizen issue)
3. **Case status is `ACTIVE`**

If any check fails, create the case via `case_create` IPC before proceeding. For kaizen issues, always pass `githubIssue` to link the case to the existing issue.

**Naming convention for kaizen work:** `YYMMDD-HHMM-kNN-kebab-description` (e.g., `260318-2107-k21-fix-newline-prefix`). The `kNN` segment embeds the kaizen issue number, making it visible in worktree names, branch names, and `git worktree list` output — even if the DB step is somehow skipped.

## The Five-Step Algorithm

Before touching code, apply these steps to the spec itself. This is adapted from the algorithm used at Tesla/SpaceX for manufacturing process improvement — but it applies even more forcefully to specifications, because specs are pure thought-stuff with no physical constraints preventing deletion and simplification.

### Step 1: Question the requirements

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

**The most dangerous requirement is the one everyone assumes is true but nobody has re-examined.** A spec written when we were at L5 on the test ladder might propose L6 infrastructure that's already been built. A spec that assumed `processGroupMessages` was untestable might not know about a recent DI refactor.

### Step 2: Delete

The best code is no code. The best spec section is the one you don't need to implement.

**Look for:**
- Spec sections that solve problems that no longer exist
- "Nice to have" capabilities that don't serve the core need
- Entire phases that can be skipped because a simpler approach works
- Options analysis that's already been decided — delete the losing options, keep only the decision
- Defensive code the spec proposes "just in case" — if the case hasn't happened in practice, delete it

**This is uncomfortable.** The spec represents hours of thinking. Deleting feels wasteful. But implementing unnecessary spec is far more wasteful than the thinking that produced it. The thinking had value — it ruled things out. The implementation of ruled-out things has negative value.

### Step 3: Simplify

After deleting, look at what remains. Can it be simpler?

**For each remaining component:**
- Does it need a new abstraction, or can it use an existing one?
- Does it need a new file, or can it be 20 lines in an existing file?
- Does it need configuration, or can it be hardcoded for now?
- Does it need to handle N cases, or does it only need to handle the 1-2 cases that actually occur?

**The spec was written to be complete. Implementation should be minimal.** A spec describes the full problem space so future implementors understand the territory. Implementation should solve the *current* problem with the *least* code. The spec's completeness is documentation, not a build manifest.

### Step 4: Accelerate

Now you have a simplified, minimal plan. How do you ship it faster?

- What can you build in 30 minutes that proves the approach works?
- Can you get feedback before building the full thing? (A test, a prototype, a question to the admin?)
- What's the smallest PR that delivers observable value?
- Can you split the work so the first PR is independently useful, even if you never do the second?

### Step 5: Automate (only after steps 1-4)

Only now think about automation, tooling, and infrastructure:
- Is this something that should be a hook, a CI check, a skill?
- Is manual process acceptable for now, with automation as a future improvement?
- What's the kaizen level? L1 (instructions) is fine if the problem is rare. Don't build L3 (mechanistic) for a problem you've seen twice.

**The most common mistake is jumping to step 5.** "We need a CI check that validates X" — no, first question whether X is needed, whether a simpler X works, and whether a manual check is good enough for now.

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

## The Implementation Loop

After applying the five steps, you have a refined understanding. Now execute:

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
  (this skill)         Re-examines, five-step algorithm, execute loop.
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
- **Skipping step 1.** Jumping straight to coding without questioning whether the requirements are still valid. This is how you implement solutions to problems that no longer exist.
- **Skipping step 2.** Implementing everything the spec describes because "it's in the spec." Deletion is the highest-leverage step.
- **Gold-plating.** Adding capabilities the spec mentions as "future work" because you're already in the code. Future work is future work. Ship the current step.
- **Ignoring new information.** Something you discovered during implementation contradicts the spec. Instead of updating the spec and adjusting, you forge ahead with the original plan. The spec should evolve.
- **Big-bang implementation.** "I'll implement the whole spec in one PR." No. Find the smallest valuable step. Ship it. Loop.

## Recursive Kaizen — Improving the Improvement Process

This skill is part of the improvement system: `write-prd → accept-case → implement-spec → kaizen`. That system itself should improve over time. Today, the loop that improves these skills runs through Aviad — he notices when a skill led agents astray, when a step was skipped, when the five-step algorithm wasn't applied, and he manually updates the skills.

**The lofty goal:** the system kaizens itself. After applying these skills, something triggers reflection not just on the *work* but on the *process*. Did the spec help or hinder? Did the five-step algorithm surface the right things to delete? Did accept-case catch the right issues? These reflections accumulate. Patterns emerge. The skills evolve.

**Where we are:** fully manual. Aviad is the recursive kaizen loop.

**Glimmers of what's next:**
- The kaizen reflection that fires on `case_mark_done` already captures impediments. If those reflections included "the spec was over-specified for this problem" or "I skipped step 2 (delete) and implemented unnecessary code," that's process feedback, not just work feedback.
- A hook or reflection prompt after implementation could ask: "Looking back, which of the five steps would have saved the most time if applied more rigorously? Was any spec section dead weight? Did accept-case miss something the implementation revealed?"
- These reflections, accumulated over many cases, would be the raw material for improving the skills themselves — the same way incident data is raw material for improving the codebase.

**What we don't know yet:** how to structure this, where to store it, how to surface it, when to act on it. That's fine. The first step is noticing. The kaizen reflection already exists. Making it ask one more question — "how was the process?" — costs nothing and starts accumulating the data that will eventually tell us what to build.

**Apply these skills to these skills.** When you use `/write-prd`, ask: is this skill helping or getting in the way? When you use `/implement-spec`, ask: did the five-step algorithm miss something? When you notice something, mention it in the kaizen reflection. That's IC-1 for recursive kaizen — instructions, manual, human-driven. It's where every kaizen journey starts.
