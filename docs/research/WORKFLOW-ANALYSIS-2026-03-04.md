# NanoClaw Development Workflow Analysis

**Date:** March 4, 2026
**Context:** Post-mortem analysis of development mistakes and comparison with industry best practices
**Mission Alignment:** Personal AI engineering team via WhatsApp shipping production code

---

## Executive Summary

**Problem:** NanoClaw has been solving fires (incidents) rather than building systematically. Despite a well-documented CLAUDE.md and mission statement, development sessions have created escalating technical debt through:

1. **Reactive incident-driven development** instead of mission-first architecture
2. **Parallel explorations without convergence** (Docker → Apple Container, multiple iterations of Jarvis)
3. **Insufficient human oversight gates** during implementation
4. **Missing "test-first" discipline** in worker/dispatch contracts
5. **Incomplete async/error-handling verification** (silent failures, no-output timeouts)

**Root Cause:** Deviation from proven workflow patterns used by experts (Boris Cherny, Addy Osmani, OpenAI Codex team).

**Recommendation:** Adopt a **Mission-Aligned, Plan-First, Test-Verified, Human-Gated Workflow** with explicit convergence gates before implementation begins.

---

## What We've Been Doing vs. What Experts Do

### Boris Cherny (Claude Code Creator) Workflow

From [VentureBeat](https://venturebeat.com/technology/the-creator-of-claude-code-just-revealed-his-workflow-and-developers-are-losing-their-minds/) and [InfoQ](https://www.infoq.com/news/2026/01/claude-code-creator-workflow/):

**Core Pattern:**

```
Parallel Processing → Plan Review → Auto-Execute with Subagents → Knowledge Persistence
```

**Key Elements:**

- **5 Claudes in parallel** (terminal) + 5-10 in browser with "teleport" handoff between CLI/web
- **Plan-first:** Goes back-and-forth until he likes the plan, THEN switches to auto-accept mode
- **CLAUDE.md is sacred:** Single file documenting past mistakes so Claude never repeats them
- **Slash commands:** Custom shortcuts checked into repo for complex operations (/commit-push-pr invoked dozens of times daily)
- **Subagents for phases:** code-simplifier, verify-app, etc. for specialized tasks
- **Outcome:** Single human operates with output capacity of small engineering department

**Principle:** Structure + Knowledge Persistence + Automation = Leverage

---

### Addy Osmani & OpenAI Codex Best Practices

From [Addy Osmani's blog](https://addyosmani.com/blog/ai-coding-workflow/), [Stack Overflow analysis](https://stackoverflow.blog/2026/01/28/are-bugs-and-incidents-inevitable-with-ai-coding-agents/), and [OpenSSF Security Guide](https://best.openssf.org/Security-Focused-Guide-for-AI-Code-Assistant-Instructions):

**Core Pattern:**

```
Understand → Structured Plan → Code → Test (80%+ coverage) → Review → Merge
                ↑___________________ Human Oversight Every Step ___________________↓
```

**Key Elements:**

- **Layered tools:** IDE for completions (Copilot), chat for reasoning (Claude), research for exploration
- **Human oversight at every gate:** Developer must understand every change; ask AI to add comments if convoluted
- **Structured testing:** Unit tests with 80%+ coverage minimum, edge cases explicit
- **Mandatory peer review:** Focus on business logic alignment and integration points
- **Test quality vigilance:** Don't test AI assumptions; test developer intent
- **Critical phrase:** "Stay alert, test often, review always"

**Outcome:** Zero silent failures, deterministic behavior, auditable decisions

---

### "Code Slop" Mistakes to Avoid (2025-2026)

From [Stephanie Stimac](https://blog.stephaniestimac.com/posts/2025/02/thoughts-on-ai-slop-coding/), [IEEE Spectrum](https://spectrum.ieee.org/ai-coding-degrades), [CodeRabbit Report](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report):

**Silent Failures (Most Dangerous):**

- AI generates code that runs without crashing but produces wrong results
- Example: Fake data in tests, removed safety checks, hallucinated dependencies
- Worse than crashes because they hide until production

**Logic Errors:**

- AI PRs show 1.7× more critical issues vs. human PRs
- Business logic mistakes, incorrect dependencies, flawed control flow
- **Root cause:** AI tested its own assumptions, not developer intent

**Security Risks:**

- Hallucinated packages (fake libraries referenced in code)
- Malicious package attacks exploiting AI-generated imports
- No verification that referenced packages exist

**"Vibe Coding" Culture (Anti-Pattern):**

- Developers prompt AI for outcomes instead of understanding systems
- Refining prompts instead of debugging logic
- Zero confidence in generated code

---

## NanoClaw: Where We Deviated

### ✅ What We Did Right

1. **Mission statement is clear** (`docs/MISSION.md`): "Humans steer, agents execute"
2. **CLAUDE.md exists** with trigger-line index and progressive disclosure
3. **Mission-aligned engineering contract** documented (define requirements, constraints, invariants, tradeoffs)
4. **Incident tracking** set up (`.claude/progress/incident.json`)
5. **Docs structure** for architecture, operations, troubleshooting

### ❌ Where We Deviated

#### 1. **Reactive Instead of Mission-First**

**What happened:**

- Started with OpenClaw replacement idea → shifted to Jarvis → Apple Container migration
- Each session was "fix the current blocker" not "is this moving us toward mission?"
- No convergence gate: "Does this architecture deliver the mission?"

**Evidence from incidents:**

- `incident-worker-connectivity-block`: Workers down for days; no recovery plan
- `incident-20260301T164404Z`: Andy greeting delayed; no proactive latency budget
- Multiple contract mismatches (completion branch drift, validation noise)

**What experts do:**

- Boris: Plan is reviewed and approved BEFORE execution starts
- Addy: Each change is checked against requirements and integration points
- OpenAI: Every PR must align with business logic and edge case handling

**Cost:** Each fix introduces new bugs; spiral of incidents consuming all time.

---

#### 2. **Insufficient Human Oversight Gates**

**What happened:**

- When Claude Code/Codex sessions run, minimal verification before shipping to production
- Tests are written by the same AI that wrote the code (testing assumptions, not intent)
- Contract changes (dispatch-validator, completion formats) released without acceptance checklist
- No mandatory peer review of architectural decisions

**Evidence:**

- Multiple dispatch contract mismatches (completion block parsing, branch validation)
- Worker timeouts not caught by pre-flight validation
- Andy responsiveness issues not surfaced until user-visible delay

**What we said we'd do:**

- CLAUDE.md: "Grounded every task in mission and make alignment explicit"
- "Never side step any issue or put a patch fix"

**What we actually did:**

- Applied fixes without verifying root cause (launchd status checks, preflight advisory mode)
- Moved problem from hard-fail to warning instead of fixing it

**What experts do:**

- Boris: Plan is reviewed by human before auto-execute mode kicks in
- Addy: Manual review of business logic and integration points before merge
- OpenSSF: Every component undergoes security review and verification

---

#### 3. **No Test-First Discipline**

**What happened:**

- Dispatch validator tests added AFTER finding bugs in production
- No acceptance checklist BEFORE worker runtime changes
- No smoke tests BEFORE releasing new Jarvis versions
- Test quality: tests pass but contracts still drift

**Evidence:**

- `incident-20260303T072358Z`: Completion parser bug caught by probe, not by test
- Watchdog timeout logic went through 3 revisions because initial tests passed
- Contract validation test added after the fact (not before deployment)

**What we said we'd do:**

- "Prioritize reliability, optimization, and efficiency as core defaults"
- "Verify outcomes with concrete evidence"

**What we actually did:**

- Added tests after debugging failures
- Skipped pre-deployment verification checklist
- Relied on probe runs to catch contract mismatches

**What experts do:**

- OpenAI Codex: 80%+ unit test coverage minimum, edge cases explicit
- Addy: Tests are deterministic and written before implementation
- Boris: Subagents include verify-app specifically to catch integration failures

---

#### 4. **Parallel Exploration Without Convergence**

**What happened:**

- Session 1: Design Jarvis with OpenCode
- Session 2: Investigate Apple Container alternative
- Session 3: Back to Docker + worker containers
- Session 4: Re-implement with new Jarvis contracts
- Session 5: Fix watchdog, fix completion parsing, fix preflight

**Each decision documented but no convergence gate:**

- Should we be using OpenCode at all?
- Is Apple Container the long-term strategy?
- When is Jarvis "stable enough" to stop redesigning contracts?

**Result:** Technical debt compounds; incidents pile up; no clear path to "done"

**What experts do:**

- Boris: CLAUDE.md documents what didn't work so clauses don't re-explore
- Addy: Decisions are traced to requirements; explorations stop when requirements are met
- OpenAI: Acceptance criteria are explicit before starting; no "let's see what works"

---

#### 5. **Silent Failures & Missing Error Handling**

**What happened:**

- No-output timeouts treated as normal (wait for timeout, then fallback)
- Dispatch validation noise accepted (false negatives on connectivity checks)
- Incomplete contract blocks not caught until probe runs
- Worker runtime errors not surfaced to Andy-developer

**Evidence:**

- Preflight checks went from hard-fail → advisory → warning instead of fixing underlying issue
- Stale probe runs not cleaned up; just ignored
- Contract branch mismatch accepted as "edge case" instead of prevented

**What code slop research shows:**

- [IEEE Spectrum](https://spectrum.ieee.org/ai-coding-degrades): Silent failures worse than crashes
- [CodeRabbit](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report): AI PRs 1.7× more critical issues

**What we missed:**

- Every silent failure is a debt accumulation event
- Every accepted "edge case" is a future incident waiting

---

## The Right Workflow: Mission-Aligned, Plan-First, Test-Verified, Human-Gated

### Overview

```
MISSION ALIGNMENT CHECK
        ↓
PLAN (convergence gate) ← Human reviews, approves architecture
        ↓
WRITE CODE + TESTS (80%+ coverage)
        ↓
ACCEPTANCE CHECKLIST (deterministic verification)
        ↓
SUBAGENT VERIFICATION (code-simplifier, verify-app, etc.)
        ↓
HUMAN PEER REVIEW (understand every change)
        ↓
MERGE + SHIP
        ↓
KNOWLEDGE PERSISTENCE (update CLAUDE.md with what we learned)
```

### Phase 1: Mission Alignment & Planning

**Gate: Every task must pass "Is this moving us toward the mission?"**

Before writing a single line of code:

1. **Restate the mission:** "Personal AI engineering team via WhatsApp shipping production-quality code"
2. **Map the task to mission:** "How does this feature/fix deliver the mission?"
3. **Define requirements, constraints, invariants:**
   - Requirement: Worker dispatch must be 100% deterministic (no retry logic hiding bugs)
   - Constraint: Worker runtime must be < 5min per task (no hanging operations)
   - Invariant: Every state transition must be terminal (no backwards transitions)
4. **Sketch architecture:** Draw the system; identify integration points
5. **Define acceptance criteria:** How do we know this is done? (Not: "tests pass"; Rather: "E2E dispatch → completion → PR link")

**Who approves:** You (human). Claude proposes, you approve before code starts.

**Duration:** One conversation; max 1 hour. If longer, the scope is too big.

---

### Phase 2: Code + Tests with Explicit Coverage

**Gate: 80%+ unit test coverage; edge cases named explicitly**

1. **Write tests first (or alongside):**
   - Happy path: happy path test passes
   - Edge cases: timeout, partial response, contract mismatch, etc.
   - Each test has a comment explaining what it's catching

2. **Verify test quality:** Don't test AI assumptions; test developer intent
   - Bad: `test('dispatch returns run_id') { expect(dispatch(...)).toHaveProperty('run_id') }`
   - Good: `test('incomplete dispatch payload rejected') { expect(() => dispatch({no_run_id: true})).toThrow('run_id required') }`

3. **Code review checklist:**
   - [ ] All functions have unit tests
   - [ ] Edge cases covered (timeout, empty, null, invalid input)
   - [ ] No silent failures (all error paths raise or log)
   - [ ] No assumptions about runtime behavior
   - [ ] Comments on "why", not "what"

---

### Phase 3: Acceptance Checklist (Deterministic Verification)

**Gate: Concrete evidence, no "I think it works"**

For Jarvis/dispatch changes, use determinism checklist:

```bash
# From docs/principles/determinism.md

✓ Unit tests pass with exit code 0
✓ Dispatch contract validated with sample payloads
✓ Worker probe runs end in review_requested status (not failed_*)
✓ Connectivity check passes: bash scripts/jarvis-ops.sh verify-worker-connectivity
✓ E2E smoke: npx tsx scripts/test-worker-e2e.ts PASS
✓ All state transitions are terminal (no backwards moves)
✓ No silent failures (every error path is observable)
```

**Who verifies:** You run the checklist; you sign off. Not "Claude says it passed".

---

### Phase 4: Subagent Verification

**Gate: Specialized agents catch what humans miss**

Use subagents for focused verification:

- **code-simplifier:** Clean up architecture, remove duplication
- **verify-app:** Run E2E tests, catch integration failures
- **incident-debugger:** Check if this fix creates new issues

Each subagent is invoked with explicit scope:

```
/code-simplifier "Review dispatch-validator.ts for duplication"
/verify-app "Run E2E dispatch → completion → PR link flow"
/incident-debugger "Check if watchdog timeout fix creates new stale-state issues"
```

**Key:** Subagent runs AFTER human has reviewed architecture. It's not a replacement; it's a second pair of eyes.

---

### Phase 5: Peer Review (Understanding, Not Trust)

**Gate: You must understand every change**

Before merge:

1. Read the actual diff (not summary)
2. Ask: "Do I understand what this code does?"
3. Ask: "If this breaks, how would I debug it?"
4. Ask: "Does this change expose any security risks?"
5. If answer is "no" to any, ask Claude to explain or refactor

**Anti-pattern:** "Claude says it works, so merge" = vibe coding. Don't do it.

**Pattern:** "I reviewed this, I understand it, I'm confident shipping it" = responsible.

---

### Phase 6: Knowledge Persistence

**Gate: Learning is encoded so we don't repeat mistakes**

After every non-trivial change:

1. **Update CLAUDE.md with lessons learned:**

   ```
   ## Mistakes to Avoid
   - Don't accept "preflight advisory" without fixing the underlying issue
   - Worker completion blocks must always include branch for validation
   - Probe runs MUST terminalize; no stale-state backlog allowed
   ```

2. **Update relevant architecture/operations docs:**
   - Did contract change? Update dispatch-contract.md
   - Did we learn about timeouts? Update worker-runtime.md

3. **Store decision trace:**

   ```bash
   context_store_trace \
     decision="Chose full completion validation over preflight warnings" \
     category="dispatch-contract" \
     outcome="success"
   ```

**Key:** Next developer (including future you) reads CLAUDE.md and avoids the same mistake.

---

## Development Workflow by Use Case

### When to Use This Workflow

| Scenario | Workflow | Duration |
|----------|----------|----------|
| **New feature** (dark mode, new channel) | Full workflow (Plan → Code → Test → Review) | 1-2 sessions |
| **Bug fix** (latency, silent failure) | Plan (5 min) → Code → Test → Review | 1 session |
| **Architecture change** (Jarvis contract, dispatch validation) | Full workflow with subagent verification | 1-2 sessions + acceptance checklist |
| **Performance optimization** (reduce timeouts, parallel processing) | Plan → Benchmark → Code → Test → Measure → Merge | 1-2 sessions |
| **Incident response** (worker down) | Diagnosis → Root cause → One-line fix → Test → Merge ASAP, then post-mortem | 1 session + follow-up |

### Discipline for Each Workflow Type

#### Feature Development (Dark Mode, New Skill)

```
1. PLAN: Sketch UI/behavior, identify integration points → Human approves (5 min)
2. CODE: Write code + tests, 80%+ coverage
3. ACCEPTANCE: Run feature flag test, E2E test
4. REVIEW: Code review checklist
5. KNOWLEDGE: Add to CLAUDE.md if it affects core workflow
6. SHIP: Create PR, merge, deploy
```

#### Bug Fix (Latency, Silent Failure)

```
1. REPRODUCE: Write a failing test that captures the bug
2. ROOT CAUSE: Understand why it's broken (not just patch it)
3. FIX: Minimal fix that makes test pass
4. VERIFY: Run full test suite; no new failures
5. KNOWLEDGE: Document the mistake in CLAUDE.md
6. SHIP: Merge with clear commit message
```

#### Contract/Architecture Change (Dispatch Validator, Worker Runtime)

```
1. PLAN: Define new contract, sketch validation logic → Human approves
2. WRITE TESTS: All validation rules as tests (before code)
3. IMPL: Write validator code; all tests pass
4. ACCEPTANCE CHECKLIST: Deterministic verification (connectivity, probe runs, E2E)
5. SUBAGENT VERIFY: code-simplifier, verify-app
6. PEER REVIEW: You understand every line
7. KNOWLEDGE: Update contract docs + CLAUDE.md
8. SHIP: Deploy with rollback plan
```

#### Incident Response (Worker Down, Andy Offline)

```
1. DIAGNOSIS: What's happening? (logs, probe, events)
2. ROOT CAUSE: Why? (not just "restart it")
3. FIX: One-line fix if possible; minimal changes
4. VERIFY: Incident symptom gone
5. MERGE IMMEDIATELY
6. POST-MORTEM: Root cause analysis + prevention (update CLAUDE.md + architecture docs)
```

---

## Specific Recommendations for NanoClaw

### Immediate (This Week)

1. **Stabilize Jarvis worker connectivity:**
   - Root cause: Watchdog timeouts not cleaning up stale probe runs
   - Fix: Move from advisory checks to mandatory deterministic gates (no warnings, only hard-fail)
   - Acceptance: `verify-worker-connectivity --skip-prechecks PASS` every time
   - Knowledge: Update `docs/workflow/nanoclaw-jarvis-worker-runtime.md`

2. **Fix Andy greeting latency:**
   - Root cause: No fast-path for simple salutations; all requests wait for heavy orchestration
   - Fix: Add greeting handler in `src/index.ts` that returns within 500ms
   - Test: Unit test for greeting latency < 1s
   - Knowledge: Update `docs/workflow/nanoclaw-andy-user-happiness-gate.md`

3. **Establish incident closure discipline:**
   - All open incidents must have root cause analysis + prevention in CLAUDE.md
   - Use `/incident-debugger` for every open incident
   - Move "open" → "closed" only when prevention is documented

---

### Short Term (This Sprint)

1. **Document contract convergence:**
   - Current state: Multiple dispatch contract versions floating around
   - Goal: One canonical contract with validation tests
   - Acceptance: `npm test` covers all dispatch scenarios; E2E smoke test passes

2. **Implement test-first discipline:**
   - All new worker code starts with tests
   - Acceptance checklist mandatory before merge
   - No "we'll test later"

3. **Update CLAUDE.md with lessons learned:**
   - Don't move issues from hard-fail to advisory
   - Every contract change requires acceptance checklist
   - Watchdog timeouts are reliability risks; handle explicitly

---

### Long Term (Next Month)

1. **Move to mission-aligned planning:**
   - Every feature starts with "How does this deliver the mission?" gate
   - Plan review happens with you before code starts
   - Subagents used for verification, not exploration

2. **Implement knowledge persistence:**
   - CLAUDE.md grows to 150+ lines documenting all past mistakes
   - Every incident → root cause → prevention → documented
   - New developers (or future you) know what not to do

3. **Establish convergence gates:**
   - Architecture decisions are final until explicitly re-scoped
   - No more Docker → Apple Container → Docker explorations
   - Each decision documented with rationale and constraints

---

## Comparison: Current vs. Proposed Workflow

| Aspect | Current | Proposed |
|--------|---------|----------|
| **Planning** | "Start coding, figure it out" | Plan review before code (5-10 min gate) |
| **Testing** | Tests added after bugs found | Tests written first; 80%+ coverage required |
| **Verification** | "Claude says it works" | Deterministic checklist + human review |
| **Incident response** | Fix and move on | Root cause → prevention → documented |
| **Knowledge persistence** | Docs scattered, CLAUDE.md not updated | Every incident/lesson updates CLAUDE.md |
| **Oversight** | Minimal (trust the agent) | Human gates at every phase |
| **Outcome** | Spiraling incidents, technical debt | Predictable delivery, reliability debt paid immediately |

---

## Why This Matters for Your Mission

Your mission is: **"Personal AI engineering team via WhatsApp shipping production-quality code."**

The current workflow (reactive incident response) prevents you from shipping. Every development session gets interrupted by fires:

- Worker down → can't dispatch → can't test → can't deliver
- Andy latency → user frustration → incident → new investigation
- Contract drift → probe failures → false signals → you lose trust in reliability

The proposed workflow (mission-aligned, plan-first, test-verified, human-gated) flips this:

- Plan before code: Fewer wrong turns
- Test-first: Fewer bugs
- Human gates: You stay in control
- Knowledge persistence: Fewer repeat mistakes
- Outcome: Reliable system that ships features, not just fixes fires

---

## References

- [Boris Cherny's Claude Code Workflow](https://venturebeat.com/technology/the-creator-of-claude-code-just-revealed-his-workflow-and-developers-are-losing-their-minds/) (VentureBeat)
- [Addy Osmani's AI Coding Workflow 2026](https://addyosmani.com/blog/ai-coding-workflow/)
- [Code Slop Crisis 2026](https://blog.stephaniestimac.com/posts/2025/02/thoughts-on-ai-slop-coding/) (Stephanie Stimac)
- [AI Code Quality Report](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report) (CodeRabbit: AI PRs 1.7× more critical issues)
- [OpenSSF Security Guide for AI Code Assistants](https://best.openssf.org/Security-Focused-Guide-for-AI-Code-Assistant-Instructions)
- [Are Bugs Inevitable with AI Agents?](https://stackoverflow.blog/2026/01/28/are-bugs-and-incidents-inevitable-with-ai-coding-agents/) (Stack Overflow Blog)
- NanoClaw MISSION.md: `/Users/gurusharan/Documents/remote-claude/Codex/jarvis-mac/nanoclaw/docs/MISSION.md`
- NanoClaw Incident Registry: `/Users/gurusharan/Documents/remote-claude/Codex/jarvis-mac/nanoclaw/.claude/progress/incident.json`

---

## Next Steps

1. **Read this doc**; discuss if this approach aligns with your vision
2. **Choose one area to pilot** (e.g., fix Andy latency + Jarvis connectivity using new workflow)
3. **Document the pilot** (what worked, what didn't)
4. **Iterate and refine** the workflow based on real experience
5. **Update CLAUDE.md** with lessons learned so future sessions follow this pattern

Your mission is too important to keep fighting fires. Let's build systematically.
