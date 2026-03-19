---
name: accept-case
description: Evaluate a kaizen case before implementation — gather incidents, find low-hanging fruit, critique specs, get admin input, record lessons. Triggers on "accept case", "evaluate kaizen", "should we do this", "triage kaizen". ALSO triggers when browsing/selecting work — "look at issue #N", "check this PR", "what should we work on", "pick up kaizen #N", "find low hanging fruit", "which case", "what's next", "prioritize", or any discussion of a specific GitHub issue, PR, or kaizen case that precedes implementation.
---

# Accept Case — Kaizen Case Evaluation

**Role:** The scope gate. Decides WHAT to build and at what level. Gathers evidence, evaluates scope, gets admin approval. Scope decisions live here — `/implement-spec` executes the scope this skill sets, and must not change it unilaterally.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"Specs are hypotheses. Incidents are data."* and *"No promises without mechanisms."*

Before diving into implementation of a kaizen issue, run this skill to make sure we're solving the right problem, at the right scope, with the right evidence.

Too many kaizen issues go from "abstract problem" to "big spec" to "never implemented." This skill forces concrete thinking: what actually happened, what's the smallest fix that proves value, what does the admin think, and what did we learn for next time.

## When to use

- Someone says "let's do kaizen #N"
- A spec exists but no implementation has started
- You're about to plan work and want to validate the direction first
- The admin asks you to evaluate or prioritize a kaizen case

## The process

This is a conversation, not a checklist. The phases overlap. Use judgment about what's needed — a tiny issue might skip straight to low-hanging fruit; a complex one might need deep incident archaeology.

### Phase 0: Collision detection

**Before evaluating, check if someone else is already working on this issue.** This prevents wasted effort from parallel work.

**Check all three sources — labels alone are not authoritative:**

1. **GitHub labels:** Does the kaizen issue have `status:active`, `status:backlog`, or `status:blocked` labels?
   ```bash
   gh issue view {N} --repo Garsson-io/kaizen --json labels,state
   ```

2. **Active cases in database:** Is there a case linked to this issue?
   ```bash
   node -e "const db=require('better-sqlite3')('store/messages.db'); console.log(JSON.stringify(db.prepare(\"SELECT name, status, type FROM cases WHERE github_issue = {N} AND status IN ('active','backlog','blocked')\").all(), null, 2))"
   ```

3. **Open PRs:** Are there PRs referencing this issue?
   ```bash
   gh pr list --repo Garsson-io/nanoclaw --state open --search "kaizen #{N}" --json number,title,headRefName
   ```

**If collision detected**, present the conflict to the admin:
- "Kaizen #{N} is being worked on by case `{name}` (status: {status})"
- "There's an open PR #{M} that addresses this: {title}"
- Ask: **Take over** (claim the issue, coordinate with the other agent), **Assist** (contribute to the existing case/PR), or **Pick different work** (go back to `/pick-work`)?

**If no collision**, proceed to Phase 1.

**On approval (end of Phase 5):** When the admin approves this case for implementation, label the kaizen issue as claimed:
```bash
gh issue edit {N} --repo Garsson-io/kaizen --add-label "status:backlog"
gh issue comment {N} --repo Garsson-io/kaizen --body "Claimed for evaluation by accept-case at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

This labeling is defense-in-depth on top of the L3 enforcement in `ipc-cases.ts` (which blocks duplicate case creation for the same kaizen issue). The label makes the claim visible to other agents checking `gh issue list` before they even reach the code-level check.

### Phase 1: Gather the incidents

Don't work in the abstract. Find what actually happened.

**Search for concrete occurrences:**
- Git log: commits, PR descriptions, review comments that mention the problem
- Hook outputs: kaizen reflections, dirty-file violations, review blocks
- Kaizen issue comments and cross-references
- Agent memory files that reference this pattern

**For each incident, capture:**
- When it happened (date, PR, commit)
- Who was affected (which agent, which human)
- What the observable impact was (time wasted, work blocked, wrong output)
- How it was resolved (workaround, manual fix, abandoned)

**What you're looking for:**
- Frequency — is this weekly or was it twice ever?
- Trend — getting worse, stable, or already improving?
- Clustering — does it always happen in the same context?
- Severity distribution — mostly minor annoyances or occasional major blocks?

If you can't find incidents, that's a signal. Maybe the problem is theoretical, or maybe the observability is missing (which is itself a finding).

### Phase 2: Assess observability

Can you actually tell when this problem happens? If not, that might be the real first fix.

**Questions to answer:**
- What logs/artifacts exist when this occurs?
- Would you notice this problem without someone reporting it?
- If you fixed it, how would you prove it's fixed?
- What data would help the admin decide priority?

If the answer to most of these is "we can't tell," consider whether adding observability is the real low-hanging fruit, not the fix itself.

### Phase 3: Find the low-hanging fruit

Before looking at the spec's proposed solution, ask: what's the smallest change with provable, observable benefit?

**Criteria for a good low-hanging fruit:**
- Implementable in under an hour
- Testable — you can show before/after
- Observable — the admin can see it working
- Independent — doesn't require the full solution to deliver value
- Reversible — if it's wrong, easy to undo

Often the best low-hanging fruit isn't in the spec at all. It emerges from looking at the incidents with fresh eyes.

### Scope Reduction Discipline — MANDATORY gate

When your evaluation proposes doing less than the full solution — "start with L1, escalate later", "implement the simple version first", "defer the hook to a follow-up" — you are making a promise about future work. **Promises without mechanisms are just scope cuts.**

You may only recommend reduced scope if you also provide **at least one** of:

1. **A mechanistic signal** (non-LLM) that will fire when the deferred work is needed. Examples: a hook that counts `vi.mock` calls and warns above a threshold, a CI check that flags files over N lines, a script that measures duplication. Even noisy signals with false positives are acceptable — they create awareness. The signal doesn't need to be perfect; it needs to exist.

2. **A connection to an existing epic** where progress on that epic naturally surfaces the need. Example: "as we work through the ipc.ts extraction epic (#63), each extraction step will reveal whether the remaining coupling is tolerable." The epic must be open and actively tracked — a stale epic is not a mechanism.

3. **A filed follow-up issue** with concrete trigger criteria. Not "consider L2 later" but a kaizen issue that states: "Implement L2 mock-count warning hook. Trigger: when 3+ test files in a quarter have >5 mocks." The issue must be specific enough that a future agent can evaluate whether the trigger condition has been met.

**If none of these three exist, you must not reduce scope.** Either solve the full problem in the current case, or include building the signal infrastructure as part of the current scope.

**Why this matters:** "Do less now, more later" without a mechanism is just "do less." The "later" never arrives because there's no signal that triggers it. The reduced scope becomes the final scope, and the problem persists silently. This has happened repeatedly in kaizen evaluations — agents propose L1 with "escalate to L2 if needed" but provide no way to detect when L1 has failed.

**This gate applies to:**
- Phase 3 recommendations (low-hanging fruit instead of full solution)
- Phase 5 questions to the admin ("X now, Y later?")
- Any recommendation that defers work to a future case

**Example — wrong:**
> "Start with an L1 prompt addition. If agents still ignore it after 3-5 PRs, escalate to L2."
> *(Who counts the PRs? How do you detect "ignoring"? No mechanism = no escalation.)*

**Example — right:**
> "Start with L1 prompt + L2-warn hook that counts mocks and emits warnings. The warnings create the signal — if we see repeated warnings over the next few cases, that's the trigger to upgrade to L2-block. Filed as kaizen #N with trigger criteria."

### Phase 4: Critique the spec (if one exists)

Read the spec with the incidents in hand. Evaluate:

- **Does the problem statement match the incidents?** Or did the spec drift into abstraction?
- **Are the proposed options proportional?** A 15-minute fix shouldn't have a 300-line spec with comparison matrices.
- **What's missing?** Incidents often reveal aspects the spec didn't consider.
- **What's over-specified?** Options that are clearly wrong shouldn't take up space.
- **Is the most important question buried?** Specs sometimes bury the pivotal decision as an "open question" instead of resolving it first.
- **Is there a simpler framing?** Sometimes the spec is solving the wrong problem at the right scope, or the right problem at the wrong scope.

**If this case is one phase of a larger spec**, also assess the spec's progressive detail:
- Is the current phase detailed enough to implement without guessing?
- Are distant phases over-specified with solution details that will be wrong by the time we get there?
- Does the spec need updating *before* implementation (current phase is unclear) or *after* (current phase is fine, future phases need trimming)?
- If the spec doesn't need updating before implementation, say so — don't block real work on spec maintenance.

The `/implement-spec` skill handles PRD updates after each phase. Your job here is to flag if the spec's current state would *block or mislead* implementation, not to preemptively rewrite it.

Write the critique into the spec document itself (new section at the end). The critique is part of the artifact — future readers need to see it.

### Phase 5: Ask the admin

Present your findings clearly so the admin can make a decision without reading the spec or the code. Lead with three TLDRs, then offer depth.

**Required structure — always present these first:**

1. **Problem TLDR** (2-3 sentences): What's broken or missing, stated concretely. Not "test coverage is low" but "mount-security.ts validates every container mount but has zero tests — if the validation logic has a bug, containers could access .ssh, .aws, or other sensitive paths."

2. **How it works now TLDR** (2-3 sentences): How the current system handles this today. Help the admin understand whether the existing code is sound (just needs tests/hardening) or is itself the problem (hacky, needs rework). Be honest — "the validation logic is clean but untestable due to global cache state" is more useful than "it works."

3. **What changes TLDR** (2-3 sentences): What you'd actually do, concretely. Not "improve test coverage" but "add a deps interface to mount-security.ts (matching the existing pattern in send-response.ts), write 15-20 unit tests covering blocked patterns, allowlist matching, and read-write policy."

4. **Deep dive pointers** (1 paragraph): Where the admin can read more if they want — which spec sections, which source files, which incidents are most informative. This respects their time: they can stop at the TLDRs or dig in.

**Then ask targeted questions.** Not open-ended "what do you think?" but specific choices that need a human decision.

**Structure your questions as:**
- "I found N incidents over M weeks. The pattern is X. Does this match your experience?"
- "The spec proposes A, but the incidents suggest B would be more impactful. Which direction?"
- "The simplest fix is X (30 min). The full solution is Y (2 days). Do you want X now and Y later, or Y directly?" *(If recommending "X now, Y later" — you must have passed the Scope Reduction Discipline gate: what signal will tell us when Y is needed?)*
- "This problem overlaps with kaizen #N. Should we merge them or keep separate?"
- "The spec's open question #K is actually the pivotal decision. My lean is Z because [reason]. Agree?"

**Don't ask:**
- Questions you could answer by reading the code
- Questions where all options are equivalent
- "Is this important?" (you should already know from the incidents)

### Phase 6: Capture lessons for the system

After the admin responds, the conversation you just had contains signal that's currently lost. The admin's reasoning — why they chose X over Y, what they value, what surprised them about the data, where their intuition disagreed with the spec — this is the highest-value information in the entire process, and today it evaporates when the conversation ends.

**Why this matters for recursive kaizen:**

The kaizen cycle is WORK → REFLECT → IDENTIFY → CLASSIFY → IMPLEMENT → VERIFY. But there's a missing loop: the evaluation step itself (this skill) should improve over time. When an admin says "this spec was way too long for the problem" or "you should have checked incident frequency first," that's not just feedback on this case — it's calibration data for how future cases should be evaluated.

**What a lessons system would enable:**
- Agents could read past evaluation sessions before starting new ones, avoiding the same mistakes (e.g., writing a 300-line spec for a 15-minute fix)
- Pattern detection across evaluations: "we keep speccing things that should just be implemented" or "we keep implementing before understanding the problem"
- The admin's judgment becomes durable — not locked in one conversation's context
- Priority calibration: what the admin actually cares about vs. what agents think they care about

**What needs to be captured (not how):**
- The admin's decision and their reasoning
- Where the spec/plan diverged from the admin's view of the problem
- Calibration data: was the problem bigger or smaller than the spec implied?
- Meta-observations about the evaluation process itself

The mechanism for storing and surfacing this doesn't exist yet. That's a separate design problem — and one that should be informed by several rounds of running this skill first, so we have concrete examples of what kind of lessons emerge and how they'd be used. Don't design the system in the abstract; accumulate the data, then design around it.

## Anti-patterns

- **Skipping Phase 1.** Going straight from "kaizen #N exists" to "let's implement the spec" without checking if the spec matches reality.
- **Spec worship.** A spec is a hypothesis. Incidents are data. When they conflict, trust the data.
- **Analysis paralysis.** If Phase 3 finds an obvious 15-minute fix, just do it. Don't block on completing all 6 phases.
- **Asking the admin obvious questions.** Respect their time. Only escalate decisions that genuinely need human judgment.
- **Recording trivial lessons.** "We should test our code" is not a lesson. "Specs over 100 lines for problems with known solutions lead to spec-rot — implement instead" is.
- **"Do X now, Y later" without a mechanism.** Reducing scope is fine — but only if you provide a signal (mechanistic tool, epic connection, or filed follow-up) that will trigger "later." Without a mechanism, "later" never arrives. See the Scope Reduction Discipline gate.

## Integration with other skills

- After accept-case, use `/implement-spec` to bridge spec to code (applies the five-step algorithm: question, delete, simplify, accelerate, automate)
- If the case needs a spec first, use `/write-prd` — but only if Phase 1-3 showed the problem is genuinely complex
- If the case is ready for implementation, use `/plan-work` to break it into PRs
- Lessons learned feed back into future accept-case evaluations

## Recursive Kaizen

This skill is part of the improvement system. Apply it to itself: after evaluating a case, reflect on whether the evaluation process helped or got in the way. Did Phase 1 (gather incidents) reveal the right things? Did Phase 3 (low-hanging fruit) find something the spec missed? Was Phase 5 (ask the admin) worth the admin's time? These observations, captured in kaizen reflections, are the raw material for improving this skill. See `/implement-spec` for the fuller picture of recursive kaizen.
