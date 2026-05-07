# Retro: instrumented-memory-recall

**Date:** 2026-05-07
**Feature:** instrumented-memory-recall
**Branch:** feat/instrumented-memory-recall (merged to main as 169450a, 14 commits)
**Artifacts location:** `docs/specs/instrumented-memory-recall/`

## Workflow scoreboard

| Stage | Cycles | Outcome |
|---|---|---|
| /team-brief | 1 | clean approve |
| /team-design | 3 + simplification | hit 3-cycle cap, user simplified, evaporated most MUST-FIX via D35-D40 supersession |
| /team-review | (rolled into design) | cap-reached then cleared by simplification |
| /team-plan | 1 | written; pre-build drift caught a real contradiction |
| /team-build | 1 | 5 builders (A → B/C/D parallel → E), 1 lead-authorized scope expansion (DeadLetterItemType union) |
| /team-qa | 3 fix-cycles | Codex E found 9 issues across 3 rounds; 8 fixed, 1 (E9) deferred as documented limitation |
| /team-ship | 1 | merge-locally |

## Stage-by-Stage Findings

| Stage | Worked Well | Missed / Wrong | Root Cause |
|---|---|---|---|
| /team-brief | Three-deliverable framing (R1/R2/R3) with HARD measurement-first ordering held throughout | Brief assumed the LLM judge needed only `fact_id` to score; real judge needs fact content text | Brief author didn't simulate the judge prompt end-to-end before locking the schema |
| /team-design | Option C hybrid (host-inline cheap signal + daemon async judge) survived all 3 cycles + simplification | Cycle 2's MUST-FIX fixes (M2-1 daemon approval wrapper, M2-4 host-Ollama check location) introduced new MUST-FIX in cycle 3 (M3-1 nonexistent column reference, M3-2 cross-process write race). | Cycle 2 patches were specified at "what to change" level without checking the actual schema/runtime they referenced. M2-1 referenced `decided_at` column that doesn't exist; M2-4 had host writing to a file the daemon atomically rewrites |
| /team-review (cycle 3) | Cap-reached gate fired exactly as designed; surfaced the "patches creating new bugs" pattern | Reviewer B (best-practice) was not spawned in cycle 3 (documented as procedural gap in review.md:23). Cross-model diversity reduced for the cycle that hit the cap | Lead oversight — review.md acknowledges it explicitly |
| /team-design (simplification) | User intervention "not over-engineering" + Codex consultation cleanly resolved 7 of 7 cycle-3 MUST-FIX via D35-D40 supersession (auto-revert / queue caps / daily limits / oracle slice / Cohen's κ / cross-group consent / Spearman in health.json all cut) | Simplification was needed but the inputs to it (cycle-3 review's cap-reached escalation memo) had to be written manually as `auto-pause.md`. /team-design itself has no "step back to MVP scope" hook | Cap-reached escalates to user; user's instinct to simplify isn't a built-in workflow step |
| /team-plan | Group decomposition (5 groups, 20 tasks) cleanly partitioned files. Builder ownership map prevented overlap conflicts | plan.md retained Spearman in C2/C4 even though the design's "Active MVP CUT" section explicitly removed it. Plan was written against superseded §1.3/§1.6 sections | Plan author treated `design.md` as a flat document; didn't honor the "Active MVP Scope supersedes earlier sections" contract at the top of design.md (line 14-16) |
| /team-drift (pre-build) | Both extractors (Claude Sonnet + Codex xhigh) independently flagged the same DIVERGED Spearman finding. Mechanical fix unambiguous from SOT | One PARTIAL the agents flagged ("enabledCache 60s TTL not explicit in plan") was correct but propagated to the build prompt as a "carry-forward reminder" rather than fixing the plan. Builder-A then made the call to defer the cache to Group B, which Builder-B implemented correctly. So PARTIAL-as-reminder worked here, but it's a workflow contract that's only honored if the builder reads the prompt carefully | Drift skill maps PARTIAL findings to "review required, non-blocking" — the build-prompt-handoff is the lead's job, not the skill's |
| /team-build | All 5 builders self-reported ACK with correct file scope; no overlap. Sequential A → parallel B/C/D → E pattern prevented file conflicts. Lead-authorized scope expansion (DeadLetterItemType union for 'recall-judge') was the right call when Builder-C hit a real type-system blocker | Builder-B introduced a dynamic-import-with-fallback pattern for `JUDGE_PROMPT_VERSION` because Group C's `judge-client.ts` didn't exist when Builder-B was running. Pure TDD smell — workaround for a parallel-build dependency. Resolved during the E1 fix when the import became static, but it shouldn't have been written that way to begin with | Group B and Group C have a one-way dependency (B consumes C's exported constant); parallel build forced an awkward bridge. Plan dependency graph said B/C/D could run in parallel after A — but B's dependency on C's exports wasn't surfaced as a sequencing issue in /team-plan |
| /team-qa | Codex Validator E uniquely caught the CRITICAL ESM `require()` bug (E1) that no Claude validator would have caught — `tsc` accepts `require()` in an ESM module since types resolve, but at runtime in built ESM `require` is undefined and the function returns null silently. Cross-model perspective earned its keep here. Three round of progressively narrower findings followed the expected diminishing-returns curve | Validator CD (code review swarm) was skipped this run with the rationale "context-budget management in long autonomous run" — recorded as DEGRADED. This was a unilateral lead judgment, not a documented user opt-in. Could have surfaced E1/E2-class issues earlier — though Codex E covered E1 anyway | Lead made a context-economy call; the skill's "ensure CD runs unless Exa unavailable" guidance was treated as soft. The skill text doesn't actually have a "skip for context budget" branch |
| /team-ship | Pre-ship test rerun caught no regressions; merge-locally clean | Two pre-existing prettier reformat diffs (post-format-hook) showed up as "uncommitted" at ship-gate; bundled into a `style:` commit before merge | format hook reformats post-commit, but those reformats only land if a subsequent commit picks them up; a long workflow with many commits accumulates trailing prettier diffs |

## Key Learnings

1. **Next time, /team-design should require an explicit "MVP scope" header in cycle 1, not added retroactively in cycle 3**, because the simplification pass that resolved 7 cycle-3 MUST-FIX was effectively defining MVP scope for the first time. Per `decisions.yaml` D35-D40, all the cuts (auto-revert circuit breaker, queue caps, daily limits, oracle slice, Cohen's κ, Spearman in health.json) had been *added* across cycles 1 and 2 because the design didn't have a "what's deferred" boundary. Adding them is gold-plating; cutting them is simplification. A first-cycle MVP boundary forces the gold-plating decision up front.

2. **Next time, schema design must include the LLM consumer's prompt shape as part of the contract**, because Codex E2 surfaced that the judge prompt got `content: ''` for every fact (the original schema persisted only `fact_id`). This required mid-build migration `023-mnemon-recall-fact-content` adding `fact_content_excerpt`. The brief's R1 deliverable said "judge scores facts" without specifying what the judge sees; the design's §1.4 specified the prompt structure but didn't trace it back to whether the schema persists what the prompt needs. Treat "what the LLM input looks like at runtime" as a HARD constraint, not an implementation detail.

3. **Next time, when a parallel-build group depends on another group's exports, sequence them or factor the shared symbol into Group A**, because Builder-B's dynamic-import-with-`'v1'`-fallback for `JUDGE_PROMPT_VERSION` was a TDD workaround for the fact that Group C wasn't built yet. The shared constant (`JUDGE_PROMPT_VERSION = 'v1'`) was only ~3 LOC and could have lived in Group A's `container-config.ts` or a shared constants module loaded by both. /team-plan §5 (file conflict check) caught file overlap but didn't surface symbol dependency between parallel groups.

4. **Next time, Codex Validator E should run before Validator CD when the diff includes ESM/TS migration territory**, because E1 (CRITICAL `require()` in `"type":"module"`) is exactly the class of bug Claude validators systematically miss. tsc is happy with the call (types resolve via static analysis); style audit is happy (the line uses an `eslint-disable` comment for `no-require-imports`). Only runtime knowledge catches it. Codex's cross-model training surfaces these patterns where Claude has a blind spot. The skill currently runs A/B/CD/E in parallel; consider running E first when the diff touches module-resolution-sensitive areas (new files, ESM imports, dynamic require/import usage).

5. **Next time, /team-qa skill should make CD-skip an explicit user-confirmed opt-in, not a lead judgment call**, because skipping CD this run produced a "DEGRADED" coverage banner without the user actually consenting to reduced coverage. Codex E happened to cover much of the same ground, but that's not guaranteed for future features. The skill text says "skip Validator CD only if the diff is pure docs/config" or "if Exa is unavailable" — "context-budget" was the lead inventing a third skip reason.

## Recommended Updates

> **Constraint when implementing these recommendations:** Apply at minimum-viable scope. Dave's stated preference during this feature was "not over-engineering — I just want a working product, not every edge case squashed." That preference applies recursively to the workflow updates themselves: pick the smallest skill-text edit that closes the gap, not the most thorough refactor of the skill. If a recommendation could be met with a one-paragraph addition to existing skill text, prefer that over restructuring the skill. Defer "while we're here" cleanups to a separate pass.

### CLAUDE.md
- **Section:** Supply Chain Security (pnpm) or new "Module System" subsection
- **Change:** Add a guardrail: "Never use CommonJS `require()` in `.ts` files in the host (`src/`). The host is ESM (`"type": "module"`). Use static `import` at the top of the file. If a circular import is forcing dynamic load, use `await import('./mod.js')` (ESM dynamic), never `require('./mod.js')`. The `eslint-disable-next-line @typescript-eslint/no-require-imports` comment is a red flag in this codebase."
- **Reason:** Codex E1 found a CRITICAL `require()` in `recall-outcomes.ts` that compiled cleanly but failed silently at runtime. The eslint-disable comment was the smell that a static check could have flagged.

### Workflow Skills

- **Skill:** `bootstrap-workflow:team-design` § Step 6 (Recommend One Option)
- **Change:** Add a Step 6c: "MVP Scope Boundary — list explicitly what is IN scope for the first ship and what is OUT of scope (deferred to v2). Include a one-line rationale per deferred item. The MVP boundary is normative and supersedes any later-cycle additions."
- **Reason:** `decisions.yaml` D35-D40 supersession in cycle 3 was effectively defining MVP scope for the first time. Defining it in cycle 1 prevents gold-plating across cycles.

- **Skill:** `bootstrap-workflow:team-plan` § Step 4 (Write Complete Task Specifications), specifically the interface/signature subsection
- **Change:** When the task spec has an LLM consumer (judge prompt, eval prompt, classifier prompt), require the planner to specify the prompt's input shape and trace each input field back to either (a) a column in a touched schema or (b) a runtime computation. Tasks that send empty strings to LLM inputs are spec defects.
- **Reason:** Codex E2 (`candidate_facts.map(r => ({fact_id: r.fact_id, content: ''}))`) was a direct consequence of plan.md not tracing the judge prompt's `candidate_facts[].content` back to the schema.

- **Skill:** `bootstrap-workflow:team-plan` § Step 5 (File Conflict Check)
- **Change:** Add a "Symbol dependency check" pass: for each parallel group, list any symbols it imports from another parallel group. If a parallel-group dependency exists, either (a) sequence the dependent group after the dependency, or (b) move the shared symbol into Group A or a shared module loaded before both.
- **Reason:** Builder-B's dynamic-import-fallback for `JUDGE_PROMPT_VERSION` was a TDD smell caused by parallel B/C with B depending on C's export. Could have been caught at plan time.

- **Skill:** `bootstrap-workflow:team-qa` § Validator CD section
- **Change:** Tighten the "Skip Validator CD" branch. Currently lists two skip reasons (pure docs/config diff, or `mcp__exa__*` unavailable). Add explicit: "If the lead is considering skipping CD for any other reason (context budget, time pressure, redundancy with other validators), the skip MUST be approved by the user before /team-qa runs. Lead may NOT unilaterally skip CD on judgment grounds."
- **Reason:** This run skipped CD with rationale "context-budget management in long autonomous run." That's a lead-invented exception not in the skill text. Codex E happened to catch the most critical issues, but that's lucky, not by design.

- **Skill:** `bootstrap-workflow:team-design` § cycle-cap escalation gate (Step 0)
- **Change:** When the cap fires, the escalation gate should explicitly include "Option 4: Simplify the design (request a 'cut to MVP' pass that supersedes earlier additions)." The user picked this option this run but had to articulate it themselves; the skill's Options 1/2/3 (waive / rework / escalate) didn't include it.
- **Reason:** Simplification was the path that worked, but it wasn't on the skill's offered list. Three of three /team-auto runs to date have benefited from this option (per ambient memory).

### Project Skills
- N/A this round — no project-skill-level change indicated by the artifacts.

## What I'd keep doing

- **Keep using Codex Validator E.** It earned its keep on this feature alone (E1 CRITICAL would have shipped silently broken without it). Cross-model perspective for runtime-class bugs is a real gap that Claude reviewers tile poorly.
- **Keep the pre-build drift gate.** It caught the Spearman-in-plan / Spearman-cut-from-design contradiction cleanly. Mechanical fix took 5 minutes; would have taken hours of rework if discovered post-build.
- **Keep the 3-cycle cap.** It fired correctly — cycle 2 fixes that introduced new bugs is exactly the signal it's meant to surface. The simplification path that resolved it was the right intervention, even if not codified in the skill.

## What I'd stop doing

- **Stop letting the lead unilaterally skip Validator CD.** Either run it or have explicit user opt-in.
- **Stop having Reviewer B miss cycles.** This was an acknowledged procedural gap in cycle 3. Add a pre-flight checklist to /team-review that forces all reviewers to be spawned (or explicitly skipped with reason).
