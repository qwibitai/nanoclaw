# PRD: Best Practices Checklist — Pre-Work Prompting and Post-Work Verification

**Issue:** [Garsson-io/kaizen#210](https://github.com/Garsson-io/kaizen/issues/210)
**Author:** Claude (autonomous)
**Date:** 2026-03-20
**Status:** Draft

---

## 1. Problem Statement

NanoClaw's kaizen system has sophisticated enforcement (Level 2 hooks) for binary rules — "don't edit main checkout", "don't stop during review". But **soft engineering practices** that require judgment fall through the cracks. DRY, evidence-based communication, interaction testing — these are known, documented, and repeatedly violated because nothing prompts for them at work boundaries.

The gap: hooks enforce hard rules. Practices are soft — they need judgment about relevance. A hook can't decide "is DRY relevant to this change?" but it CAN prompt the agent to decide.

### Evidence of the gap

| Practice violated              | PR              | Issue       | Cost                                       |
| ------------------------------ | --------------- | ----------- | ------------------------------------------ |
| DRY — extract duplicated logic | #209            | kaizen #209 | 4 copy-paste resolver wrappers shipped     |
| Evidence over summaries        | #209 reflection | kaizen #205 | Decorative kaizen reflection, no real data |
| Display URLs for traceability  | #209 reflection | kaizen #206 | Missing links in kaizen issues             |
| Test the interaction surface   | #163 cluster    | kaizen #163 | Hook format mismatches across boundaries   |
| Test the deployed artifact     | #157 area       | kaizen #157 | Source present but runtime artifact wrong  |

---

## 2. Industry Best Practices Inventory

### 2.1 Code Quality Practices

**Source: SOLID Principles, The Pragmatic Programmer, Google Engineering Practices**

| #    | Practice                        | Description                                                                                                                     | Relevance to NanoClaw                                                                               |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| CQ-1 | **DRY — Don't Repeat Yourself** | Extract duplicated logic into shared abstractions. Every piece of knowledge should have a single, authoritative representation. | HIGH — kaizen #209 showed 4 copy-paste resolver wrappers. Shell scripts + TS code both susceptible. |
| CQ-2 | **Single Responsibility**       | Each module/function does one thing. Changes for one reason only.                                                               | MEDIUM — hooks are generally well-scoped, but some (pr-review-loop.sh at 24.7K) do a lot.           |
| CQ-3 | **Minimal Surface Area**        | Expose the simplest possible interface to consumers. Don't force callers to understand internals.                               | HIGH — cli-kaizen had 4 invocation patterns; agents shouldn't need to know dist/ vs tsx.            |
| CQ-4 | **Error Path Coverage**         | Failure modes are handled, not silently swallowed. Every error path produces a diagnostic message.                              | HIGH — container/image-lib.sh silently returned 0 when CLI missing. Silent failures waste hours.    |
| CQ-5 | **Orthogonality**               | Changes in one area don't cascade to unrelated areas. Components are independent.                                               | MEDIUM — hook state isolation (worktree scoping) is good; some cross-cutting concerns remain.       |
| CQ-6 | **Boy Scout Rule**              | Leave the code better than you found it. Small improvements compound.                                                           | MEDIUM — part of kaizen philosophy but not prompted at PR time.                                     |

### 2.2 Testing Practices

**Source: Kent Beck (XP/TDD), Google Testing Blog, Release It!**

| #   | Practice                          | Description                                                                                                                        | Relevance to NanoClaw                                                                                                                            |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-1 | **Test the Interaction Surface**  | Test how components interact, not just individually. Integration/interaction tests catch boundary mismatches.                      | HIGH — kaizen #163 cluster: hook format mismatches between gate and clear hooks. 27 unit test files but interaction tests are newer and sparser. |
| T-2 | **Test the Deployed Artifact**    | Verify the actual runtime artifact, not just source presence. "The file exists in the repo" != "the agent receives it at runtime". | HIGH — kaizen #157: source present but compiled output or container mount wrong.                                                                 |
| T-3 | **Test in Fresh State**           | Verify code works without cached state, built artifacts, or prior setup. Fresh worktree, fresh container.                          | HIGH — kaizen #197: fresh worktrees without dist/ broke 8+ call sites. None of the 18 resolver tests ran in a truly fresh worktree.              |
| T-4 | **TDD — Write Tests First**       | RED → GREEN → REFACTOR. Failing tests reveal bugs that code reading alone misses.                                                  | MEDIUM — documented in CLAUDE.md policy #7, but compliance is inconsistent. Prompting would help.                                                |
| T-5 | **Test Exception Accountability** | When declaring test exceptions, justify each one. Exceptions should be public, auditable, and rare.                                | MEDIUM — CI enforces via pr-policy, but agents sometimes over-declare exceptions.                                                                |

### 2.3 Communication & Documentation Practices

**Source: Google Engineering Practices (Code Review), Pragmatic Programmer**

| #    | Practice                        | Description                                                                                                          | Relevance to NanoClaw                                                                                       |
| ---- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| CM-1 | **Display URLs**                | Surface all links (PRs, issues, CI runs) in response text. Traceability requires clickable references.               | HIGH — kaizen #206: agents omit URLs when filing issues or creating PRs. Costs human time to find the link. |
| CM-2 | **Evidence Over Summaries**     | Paste actual data, logs, error messages — not descriptions of them. "The test failed" vs pasting the failure output. | HIGH — kaizen #205: decorative kaizen reflections with no real data.                                        |
| CM-3 | **Commit Messages Explain Why** | The diff shows what changed. The commit message explains why. Include issue references.                              | LOW — generally followed; git hooks help.                                                                   |
| CM-4 | **PR Body as Contract**         | PR body is the specification of what was done, why, and how to verify. Not an afterthought.                          | MEDIUM — check-verification.sh prompts for Verification section, but overall quality varies.                |

### 2.4 Architecture & Design Practices

**Source: 12-Factor App, SOLID, Release It!**

| #    | Practice                      | Description                                                                                                     | Relevance to NanoClaw                                                  |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| AD-1 | **Dependency Declaration**    | Every import/require has a corresponding package.json entry. Never assume global availability.                  | MEDIUM — CLAUDE.md policy #9. Occasionally violated.                   |
| AD-2 | **Harness vs Vertical**       | Domain code goes in the vertical repo, infrastructure in the harness. Ask before writing.                       | MEDIUM — CLAUDE.md policy #4. Requires judgment — good checklist item. |
| AD-3 | **Layer Discipline**          | Files belong to exactly one architecture layer. Don't mix IPC handlers with backend logic.                      | MEDIUM — file naming conventions encode layers. Generally followed.    |
| AD-4 | **Simpler Dependency Stacks** | Before adding wrapper packages, check if the base library achieves the same. Fewer deps = fewer failure points. | LOW — CLAUDE.md policy #10. Rarely an issue for hook/shell work.       |

### 2.5 Operational & Stability Practices

**Source: Release It!, SRE Handbook, DevOps**

| #    | Practice                  | Description                                                                            | Relevance to NanoClaw                                                                   |
| ---- | ------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| OP-1 | **Build Before Restart**  | Never restart with an untested build. Build while running, verify, then swap.          | MEDIUM — documented in post-merge policy. Prompted by deploy workflow, not PR creation. |
| OP-2 | **Fail Loud, Not Silent** | When something goes wrong, make noise. Silent failures compound into invisible bugs.   | HIGH — same as CQ-4. Container scripts silently swallowing errors is a recurring theme. |
| OP-3 | **Idempotent Operations** | Running the same operation twice produces the same result. Scripts, hooks, migrations. | LOW — hooks are generally idempotent by design.                                         |

### 2.6 Agent-Specific Practices

**Source: NanoClaw's own kaizen history, emerging agent engineering practices**

| #    | Practice                      | Description                                                                                                           | Relevance to NanoClaw                                                             |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| AG-1 | **Worktree Isolation**        | Agent work is isolated. Your worktree, your state, your problem. Never read/write across worktree boundaries.         | HIGH — kaizen #172: cross-worktree contamination. Now enforced by state-utils.sh. |
| AG-2 | **Case-First Development**    | All dev work starts with a case. Cases provide identity, isolation, and traceability.                                 | HIGH — enforced by enforce-case-exists.sh.                                        |
| AG-3 | **Kaizen Level Assessment**   | Every fix should assess: what level is this? Has this type of failure happened before? Should it escalate?            | HIGH — kaizen reflection prompts for this, but quality varies (kaizen #205).      |
| AG-4 | **Auto-Detection Over Flags** | When the system can determine context (worktree, branch, case), don't require the agent to pass flags.                | MEDIUM — kaizen #210 PR showed agents struggling with --new-worktree flags.       |
| AG-5 | **Scope Discipline**          | Don't silently expand or reduce scope. Deferred items need tracking. Test coverage for deferred items needs flagging. | MEDIUM — kaizen #178, #179, #180: scope items disappearing after merge.           |

---

## 3. Assessment: Where NanoClaw Stands

### Green — We do this well, with enforcement (L2+)

| Practice                   | Evidence                                   | Enforcement               |
| -------------------------- | ------------------------------------------ | ------------------------- |
| AG-1 Worktree Isolation    | state-utils.sh, enforce-worktree-writes.sh | L2 hook + L3 architecture |
| AG-2 Case-First Dev        | enforce-case-exists.sh                     | L2 hook                   |
| CQ-5 Orthogonality (state) | Branch-scoped state, segment splitting     | L3 architecture           |
| OP-3 Idempotent Ops        | Hook design principles doc                 | L1 docs + L2 patterns     |

### Yellow — We do this sometimes, instructions exist but no enforcement (L1)

| Practice                          | Evidence                  | Gap                                                                          |
| --------------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| T-4 TDD                           | CLAUDE.md policy #7       | Instructions only — no hook prompts for "did you write tests first?"         |
| T-5 Test Exception Accountability | pr-policy CI check        | CI enforces presence, not quality of justification                           |
| CM-4 PR Body as Contract          | check-verification.sh     | Prompts for Verification section, but doesn't check quality                  |
| AD-1 Dependency Declaration       | CLAUDE.md policy #9       | Instructions only — CI catches missing deps at build time                    |
| AD-2 Harness vs Vertical          | CLAUDE.md policy #4       | Instructions only — requires judgment                                        |
| AG-3 Kaizen Level Assessment      | kaizen-reflect.sh prompts | Prompted but quality varies; pr-kaizen-clear.sh validates JSON but not depth |
| AG-5 Scope Discipline             | kaizen #178-181 specs     | Specs exist but no enforcement                                               |
| CQ-6 Boy Scout Rule               | Kaizen philosophy         | No prompt — just vibes                                                       |

### Red — We don't do this, or actively violate it

| Practice                        | Evidence                                | Impact                                   |
| ------------------------------- | --------------------------------------- | ---------------------------------------- |
| CQ-1 DRY                        | kaizen #209: 4 resolver wrappers        | Pattern duplication ships regularly      |
| CQ-3 Minimal Surface            | kaizen #209: 4 invocation patterns      | Agents waste time on wrong invocation    |
| CQ-4 / OP-2 Error Path Coverage | image-lib.sh silent return 0            | Hours lost to invisible failures         |
| T-1 Test the Interaction        | kaizen #163: gate/clear format mismatch | Unit tests pass, integration fails       |
| T-2 Test the Deployed Artifact  | kaizen #157: source ≠ runtime           | "It should work" is not a test           |
| T-3 Test in Fresh State         | kaizen #197: fresh worktree breaks      | Only tested in "happy path" environments |
| CM-1 Display URLs               | kaizen #206: missing links              | Humans must hunt for references          |
| CM-2 Evidence Over Summaries    | kaizen #205: decorative reflections     | Reflections produce no actionable data   |
| AG-4 Auto-Detection Over Flags  | kaizen #210 PR: --new-worktree struggle | Agents forced to know system internals   |

---

## 4. Gap Analysis: Prioritized by Compound Interest

### Tier 1 — High frequency, high cost, enforceable with advisory prompt

These practices are violated frequently, cost significant time per violation, and can be caught by a simple "did you check?" prompt.

| Practice                         | Frequency                    | Cost/violation                      | Ease of advisory                   | Compound interest                      |
| -------------------------------- | ---------------------------- | ----------------------------------- | ---------------------------------- | -------------------------------------- |
| **CQ-1 DRY**                     | Every 3-4 PRs                | Hours (multiple consumers break)    | Easy — "any duplicated patterns?"  | Very high — prevents pattern explosion |
| **CM-1 Display URLs**            | Every 2-3 PRs                | Minutes per missing link            | Easy — "did you include all URLs?" | High — traceability across all issues  |
| **CM-2 Evidence Over Summaries** | Every kaizen reflection      | 15-30 min lost context              | Easy — "paste actual data?"        | High — reflections become actionable   |
| **T-1 Test Interaction Surface** | Every multi-component change | Hours (CI passes, production fails) | Medium — "cross-component tests?"  | Very high — category prevention        |
| **CQ-4 Error Path Coverage**     | Every new script/hook        | Hours (silent failures)             | Easy — "error paths handled?"      | High — fail-loud culture               |

### Tier 2 — Medium frequency, medium cost, judgment-dependent

| Practice                         | Frequency                    | Cost/violation                      | Ease of advisory                    | Compound interest               |
| -------------------------------- | ---------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------- |
| **T-2 Test Deployed Artifact**   | Every container/build change | Hours (wrong artifact tested)       | Medium — "testing actual artifact?" | High but narrower scope         |
| **T-3 Test Fresh State**         | Every new library/CLI        | Hours (works locally, breaks fresh) | Medium — "works without dist/?"     | High for infrastructure changes |
| **CQ-3 Minimal Surface**         | Every new API/CLI/tool       | Hours (agents confused)             | Easy — "simplest interface?"        | Medium — prevents UX debt       |
| **AG-3 Kaizen Level Assessment** | Every kaizen reflection      | Policy debt accumulates             | Already prompted — improve quality  | Medium — better level choices   |

### Tier 3 — Important but lower frequency or already partially addressed

| Practice                 | Notes                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| T-4 TDD                  | Instructions exist; inconsistently followed                      |
| AD-2 Harness vs Vertical | Requires contextual judgment; checklist prompt helps             |
| AG-5 Scope Discipline    | Needs mechanistic tracking (kaizen #178-181) more than prompting |
| CQ-6 Boy Scout Rule      | Philosophical; hard to check mechanistically                     |

---

## 5. Proposed Design

### 5.1 The Practices File

**Location:** `.claude/kaizen/practices.md`

A living, evolving checklist organized by practice category. Each practice is:

- **Checkable** — yes/no, not philosophical
- **Referenced** — links to the kaizen issue that discovered it
- **Categorized** — grouped by when it's relevant (code quality, testing, communication, etc.)
- **Actionable** — states what to look for, not just what the principle is

The file is NOT a copy of CLAUDE.md. CLAUDE.md is policy ("thou shalt"). Practices are prompts ("did you check?"). The difference matters — policies are rules, practices are judgment aids.

### 5.2 Advisory Hook Integration

**Hook:** `check-practices.sh` — advisory (non-blocking)

**Trigger:** `gh pr create` (PreToolUse Bash)

**Behavior:**

1. Reads `.claude/kaizen/practices.md`
2. Reads PR diff to determine change categories (shell, TS, tests, hooks, container, docs)
3. Selects relevant practices based on change categories
4. Prints them as an advisory checklist
5. Does NOT block — the agent sees the checklist and addresses relevant items naturally

**Why advisory, not blocking:**

- Practices require judgment about relevance
- Blocking on "did you check DRY?" is meaningless — the agent would just say "yes" to pass
- The value is in the **prompt** — creating the moment to think about it
- If a practice is violated 3+ times despite the prompt, THEN escalate to L2 enforcement

### 5.3 Post-Work Integration

Integrate with existing `kaizen-reflect.sh` — after the agent submits KAIZEN_IMPEDIMENTS, the practices checklist is shown as a post-work review. This catches practices that are only visible in retrospect (e.g., "did you paste evidence?").

### 5.4 Growth Mechanism

When a kaizen reflection identifies a new recurring practice:

1. Add it to `practices.md` with `ref:` to the originating issue
2. The next PR automatically includes it in the advisory prompt
3. If violated 3+ times despite the prompt → escalate to L2 hook
4. Track violation count in the practice's ref history

This is the **practices lifecycle:** incident → lesson → checklist item → enforcement (if needed).

### 5.5 Category-to-Practice Mapping

The hook uses file extensions and paths to determine which practices to show:

| Change category        | Detected by          | Practices shown                                                  |
| ---------------------- | -------------------- | ---------------------------------------------------------------- |
| Shell scripts (.sh)    | `*.sh` in diff       | CQ-1 DRY, CQ-4 Error Paths, T-1 Interaction                      |
| TypeScript (.ts)       | `*.ts` in diff       | CQ-1 DRY, CQ-3 Minimal Surface, AD-1 Deps, AD-2 Harness/Vertical |
| Tests (_.test._)       | `*.test.*` in diff   | T-1 Interaction, T-2 Deployed Artifact, T-3 Fresh State          |
| Hooks (kaizen/hooks/)  | `hooks/` in path     | T-1 Interaction, CQ-4 Error Paths, AG-1 Isolation                |
| Container (container/) | `container/` in path | T-2 Deployed Artifact, T-3 Fresh State                           |
| Docs (\*.md)           | `*.md` in diff       | CM-1 URLs, CM-2 Evidence                                         |
| All PRs                | always               | CM-1 URLs, CM-2 Evidence, CQ-1 DRY                               |

---

## 6. What This PRD is NOT

- **Not an implementation plan** — implementation details come in `/implement-spec`
- **Not a complete hook design** — the hook emerges from the practices, not vice versa
- **Not a replacement for CLAUDE.md** — CLAUDE.md is policy; practices are prompts
- **Not static** — the practices file grows as the system learns

---

## 7. Success Criteria

1. **Practices file exists** with categorized, checkable items linked to kaizen issues
2. **Advisory hook fires** on `gh pr create` showing relevant practices
3. **No false prompts** — practices shown are relevant to the change category
4. **Growth path works** — new practices can be added by editing one file
5. **Within 5 PRs**, at least one practice violation is caught by the prompt that would have shipped otherwise
6. **Zero blocking** — the hook is purely advisory; agents are never stuck waiting

---

## 8. Out of Scope (for initial implementation)

- Post-work integration with kaizen-reflect.sh (Phase 2)
- Violation tracking / escalation counting (Phase 3)
- Practice relevance scoring based on historical violations (Phase 4)
- Integration with `/review-pr` skill (Phase 2)
