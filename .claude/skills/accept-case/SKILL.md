---
name: accept-case
description: Evaluate a kaizen case before implementation — gather incidents, find low-hanging fruit, critique specs, get admin input, record lessons. Triggers on "accept case", "evaluate kaizen", "should we do this", "triage kaizen".
---

# Accept Case — Kaizen Case Evaluation

Before diving into implementation of a kaizen issue, run this skill to make sure we're solving the right problem, at the right scope, with the right evidence.

Too many kaizen issues go from "abstract problem" to "big spec" to "never implemented." This skill forces concrete thinking: what actually happened, what's the smallest fix that proves value, what does the admin think, and what did we learn for next time.

## When to use

- Someone says "let's do kaizen #N"
- A spec exists but no implementation has started
- You're about to plan work and want to validate the direction first
- The admin asks you to evaluate or prioritize a kaizen case

## The process

This is a conversation, not a checklist. The phases overlap. Use judgment about what's needed — a tiny issue might skip straight to low-hanging fruit; a complex one might need deep incident archaeology.

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

### Phase 4: Critique the spec (if one exists)

Read the spec with the incidents in hand. Evaluate:

- **Does the problem statement match the incidents?** Or did the spec drift into abstraction?
- **Are the proposed options proportional?** A 15-minute fix shouldn't have a 300-line spec with comparison matrices.
- **What's missing?** Incidents often reveal aspects the spec didn't consider.
- **What's over-specified?** Options that are clearly wrong shouldn't take up space.
- **Is the most important question buried?** Specs sometimes bury the pivotal decision as an "open question" instead of resolving it first.
- **Is there a simpler framing?** Sometimes the spec is solving the wrong problem at the right scope, or the right problem at the wrong scope.

Write the critique into the spec document itself (new section at the end). The critique is part of the artifact — future readers need to see it.

### Phase 5: Ask the admin

Present your findings and ask targeted questions. Not open-ended "what do you think?" but specific choices that need a human decision.

**Structure your questions as:**
- "I found N incidents over M weeks. The pattern is X. Does this match your experience?"
- "The spec proposes A, but the incidents suggest B would be more impactful. Which direction?"
- "The simplest fix is X (30 min). The full solution is Y (2 days). Do you want X now and Y later, or Y directly?"
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

## Integration with other skills

- After accept-case, use `/kaizen` for the actual implementation lifecycle
- If the case needs a spec, use `/write-prd` — but only if Phase 1-3 showed the problem is genuinely complex
- If the case is ready for implementation, use `/plan-work` to break it into PRs
- Lessons learned feed back into future accept-case evaluations
