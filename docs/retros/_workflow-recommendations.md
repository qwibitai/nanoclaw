# Consolidated Workflow Recommendations

**Sources:** Two completed retros under `docs/retros/`:
- `instrumented-memory-recall/retro.md` (shipped 2026-05-07)
- `mnemon-rearchitecture/retro.md` (shipped 2026-04-30)

**Total:** 15 recommended skill/process updates, grouped by target skill.

---

## Meta-rule for the session that implements these

> **Apply at minimum-viable scope. Do not over-engineer the workflow updates themselves.**
>
> Dave's stated preference across both features (most explicit during instrumented-memory-recall E9 disposition): *"I just want a working product, not every edge case squashed. We are not over-engineering here."* That preference applies recursively to skill edits.
>
> Concrete guidance:
> - Prefer one-paragraph additions to existing skill text over skill restructuring.
> - If a recommendation could be met by adding a single bullet to an existing checklist, do that — don't introduce a new section.
> - Defer "while we're here" cleanups (rewording adjacent text, reordering sections, fixing other issues you notice) to a separate pass.
> - When two recommendations could be merged into one rule (R1+R2 in mnemon-rearchitecture retro were already merged this way during Codex review), prefer the merged version.
> - The 80% test: a workflow rule should survive unrelated future features. Patches that encode a specific failure mode and would not apply elsewhere are too narrow.

---

## How to use this doc

This doc is designed to be actionable from a fresh session with no prior conversation context.

**Skill file locations** (the bootstrap-workflow plugin is at `~/.claude/plugins/cache/davekim917-bootstrap/bootstrap-workflow/<version>/skills/<skill>/SKILL.md`):

```
team-brief/SKILL.md
team-design/SKILL.md
team-review/SKILL.md
team-plan/SKILL.md
team-build/SKILL.md
team-qa/SKILL.md
team-ship/SKILL.md
```

**Workflow:**
1. Read this doc end-to-end first.
2. Read each retro section before editing the corresponding skill — provenance matters for judging the right scope.
3. Make each skill edit standalone-committable (one commit per skill). That makes review and rollback cheap if a particular edit reads as over-engineering.
4. Test discipline: after each skill edit, the next `/team-*` invocation should still feel like the same skill — only with the new guardrail. If the skill feels meaningfully different in shape, you over-edited.
5. There is no "implement all 15 then ship" target. Implementing 8 of 15 well is better than 15 with bloat.

**Provenance keys used below:**
- `[IMR]` — sourced from `instrumented-memory-recall/retro.md`
- `[MR-Rn]` — sourced from `mnemon-rearchitecture/retro.md`, recommendation Rn

---

## CLAUDE.md (project) — 1 recommendation

### C1 — Module System guardrail [IMR]

- **Add:** A "Module System" subsection (or extend Supply Chain Security) with: *"Never use CommonJS `require()` in `.ts` files in the host (`src/`). The host is ESM (`"type": "module"`). Use static `import` at the top of the file. If a circular import is forcing dynamic load, use `await import('./mod.js')` (ESM dynamic), never `require('./mod.js')`. The `eslint-disable-next-line @typescript-eslint/no-require-imports` comment is a red flag in this codebase."*
- **Why:** Codex Validator E found a CRITICAL `require()` in `src/modules/memory/recall-outcomes.ts` that compiled cleanly under tsc but failed silently at runtime — `require` is undefined in built ESM. Eslint-disable comment was the smell that a static rule could have flagged.
- **Note:** mnemon-rearchitecture retro explicitly chose NOT to add a CLAUDE.md entry for its constraint-evidence rule (lives in team-design instead). The IMR rule is project-specific (NanoClaw is ESM); it earns the CLAUDE.md slot.

---

## team-brief — 1 recommendation

### B1 — Coverage matrix for closed sets [MR-R9]

- **Add:** When a brief enumerates a closed set of required integrations, inputs, surfaces, or capabilities, produce a coverage matrix in the brief. `/team-plan` Step 4 and `/team-qa` Step 1 mechanically verify each item appears in the spec/build.
- **Why:** Exa listed at `mnemon-rearchitecture/brief.md:44` survived 3 review cycles + design + plan + build + QA, then shipped without `mcp__exa__*` in `MCP_CAPTURE_TOOLS`. Discovered only via post-ship user audit. Generic for any brief that names a closed set of dependencies/sources/integrations.
- **Minimum-viable form:** A bullet under team-brief Step 1 that says *"if your brief lists a closed set (channels, sources, integrations), include a coverage matrix and reference it from team-plan Step 4 / team-qa Step 1."* That's the rule. Don't add a new mandatory step for briefs that don't have closed sets.

---

## team-design — 5 recommendations

### D1 — MVP scope boundary in cycle 1 [IMR]

- **Add:** A Step 6c (after "Recommend One Option"): *"MVP Scope Boundary — list explicitly what is IN scope for the first ship and what is OUT of scope (deferred to v2). Include a one-line rationale per deferred item. The MVP boundary is normative and supersedes any later-cycle additions."*
- **Why:** instrumented-memory-recall's `decisions.yaml` D35-D40 supersession in cycle 3 was effectively defining MVP scope for the first time. All 6 cuts (auto-revert circuit breaker, queue caps, daily limits, oracle slice, Cohen's κ, Spearman in health.json) had been *added* across cycles 1 and 2 because the design didn't have a deferred-vs-in-scope boundary. Defining it in cycle 1 prevents gold-plating across cycles.

### D2 — Simplification option in cycle-cap escalation [IMR]

- **Add:** When the 3-cycle review cap fires, the escalation gate's options must include *"Option 4: Simplify the design (request a 'cut to MVP' pass that supersedes earlier additions)."*
- **Why:** instrumented-memory-recall's cycle-3 cap was resolved by the user articulating "simplify" themselves — Options 1/2/3 (waive / rework / escalate) didn't include it. Three of three /team-auto runs to date have benefited from this option (per ambient memory).

### D3 — Numeric HARD constraints need empirical evidence [MR-R1]

- **Add:** Before exiting design: *"Every numeric HARD constraint must cite empirical evidence from the most representative executable path available, in a unit appropriate to the constraint type (ms for latency, MB/GB for memory, RPS for throughput, %/p99 for accuracy, $/call for cost, count for capacity). If unmeasured or over budget, mark the constraint provisional and add an explicit reconciliation gate before build/ship."*
- **Why:** mnemon-rearchitecture's C5 budgeted 1500ms based on Ollama embed-only benchmark (60-216ms warm); real mnemon CLI took 1.1-1.85s. Headline UX (passive recall) was 0% functional in production for hours because the timeout fired mid-traversal. Generic rule: numeric budgets validated against the artifact, not a component, in the right unit.

### D4 — Pseudocode primitives must be repo-verified or `[NEW]` tagged [MR-R2]

- **Add:** *"Every implementation-relevant primitive (function, file path, interface) named in design pseudocode must be verified against the repo or tool index, OR tagged `[NEW]` with an owner/creation step before planning. Pseudocode without grounding is rejected back to design."*
- **Why:** mnemon-rearchitecture cycle-3 review found 4 fictional symbols (`writeSessionMessageRaw`, `getAgentGroupFolder`, `should-recall.ts`, `src/modules/memory/index.ts`). Same root cause as PR #68's wrapper-jq path bug. Pattern has now bitten **twice** across separate features.

### D5 — SOT consolidation after review cycles [MR-R3]

- **Add:** *"After review-cycle resolutions, the design/spec body must be updated to reflect the resolution OR the superseded text must be explicitly marked stale. A resolution table at the top alongside contradictory unchanged prose blocks planning until consolidated."*
- **Why:** mnemon-rearchitecture pre-build drift surfaced multiple PARTIAL findings where cycle-2/cycle-3 corrections lived in the resolution table but the original body text remained unchanged (C3 wording, C13 PK shape, agent-to-agent inclusion). Build correctly followed the most-specific spec, but the contradiction was a process smell. instrumented-memory-recall's design.md:14-16 had a "Active MVP Scope supersedes earlier sections" header — mechanism is the same shape, deserves to be a skill rule.

---

## team-review — 1 recommendation

### V1 — Recommendations must be promoted to spec or `[NEEDS SPEC]` tagged [MR-R6]

- **Add:** *"Cycle-3 close gate: any reviewer 'recommendation' not yet promoted to concrete spec text becomes a `[NEEDS SPEC]` tag carried into `/team-plan` as a task-level decision. Recommendations cannot ship as un-resolved design text."*
- **Why:** mnemon-rearchitecture M7 said "recommend native fetch via OneCLI proxy" — propagated as design text, never became concrete spec. Broke at QA round 3 with 4 corrections needed (port 10254→10255, ExecStart `onecli run` wrapper, Node 20 HTTPS_PROXY ignored, OAuth Bearer auth).

---

## team-plan — 2 recommendations

### P1 — Trace LLM-input fields back to a source (schema column or runtime computation) [IMR]

- **Add:** When a task spec has an LLM consumer (judge prompt, eval prompt, classifier prompt), require the planner to specify the prompt's input shape and trace each input field back to either (a) a column in a touched schema or (b) a runtime computation. Tasks that send empty strings to LLM inputs are spec defects.
- **Why:** Codex E2 surfaced that the recall-judge prompt got `content: ''` for every fact (the original schema persisted only `fact_id`). Required mid-build migration `023-mnemon-recall-fact-content` adding `fact_content_excerpt`. Plan didn't trace the judge prompt's `candidate_facts[].content` back to the schema.
- **Minimum-viable form:** One bullet in team-plan Step 4 (Write Complete Task Specifications). Don't introduce a new section.

### P2 — Symbol-dependency check across parallel groups [IMR]

- **Add:** A "Symbol dependency check" pass in Step 5 (File Conflict Check): for each parallel group, list any symbols it imports from another parallel group. If a parallel-group dependency exists, either (a) sequence the dependent group after the dependency, or (b) move the shared symbol into Group A or a shared module loaded before both.
- **Why:** instrumented-memory-recall Builder-B's dynamic-import-with-`'v1'`-fallback for `JUDGE_PROMPT_VERSION` was a TDD smell caused by parallel B/C with B depending on C's export. Could have been caught at plan time. The shared constant was ~3 LOC and could have lived in Group A.

---

## team-build — 2 recommendations

### Bd1 — Lead fix discipline: caller coverage on contract changes [MR-R4]

- **Add:** *"When a lead-directed fix changes a function's contract (sync→async, signature change, return-type change), the fix is incomplete until caller coverage is proven via a language-aware reference search (LSP, ts-morph, IDE 'find references', or `grep` if no better tool available). The search command + result is recorded in build-state.md. A single caller is acceptable only if the search confirms it is the only caller."*
- **Why:** mnemon-rearchitecture Group D's `writeSessionMessage` async fix updated the function and 1 of 9 callers; QA's swarm caught the remaining 8 fire-and-forget callers (`approvals/primitive.ts`, `create-agent.ts`, `response-handler.ts`, etc.). Same iteration costs nothing; surfacing it 2 stages later costs an entire QA cycle.

### Bd2 — Behavioral tests, not source-grep [MR-R5]

- **Add:** *"When behavior is exercisable (function output, state mutation, event emission, log assertion), tests must assert behavior — not source-text contents. Tests of the form `expect(src).toContain('...')` are flagged suspect: they verify the implementation was written, not that it works."*
- **Why:** mnemon-rearchitecture Group F builder initially wrote 5 of 7 classifier tests as source-grep. Lead caught and directed full behavioral rewrites with archive.db injection seam. Generic anti-pattern across all stacks.

---

## team-qa — 2 recommendations

### Q1 — CD-skip is explicit user opt-in, not lead judgment [IMR]

- **Tighten:** The "Skip Validator CD" branch currently lists two skip reasons (pure docs/config diff, or `mcp__exa__*` unavailable). Add: *"If the lead is considering skipping CD for any other reason (context budget, time pressure, redundancy with other validators), the skip MUST be approved by the user before /team-qa runs. Lead may NOT unilaterally skip CD on judgment grounds."*
- **Why:** instrumented-memory-recall skipped CD with rationale "context-budget management in long autonomous run." That's a lead-invented exception not in the skill text. Codex E happened to catch the most critical issues (E1 CRITICAL `require()` would have shipped silently broken), but that's lucky, not by design.

### Q2 — Deferred findings can't be correctness blockers [MR-R7]

- **Add:** *"Any QA finding deferred to follow-up must be re-scoped immediately if it prevents the feature's primary acceptance path from working. Scope discipline is valuable; correctness blockers are not scope creep."*
- **Why:** mnemon-rearchitecture F3 (daemon endpoint URL) was tagged "out of scope for cleanup PR" by Codex round 3 — the daemon literally couldn't make an Anthropic call as configured. User pushback forced inline fix. The original wording specifically named Codex; the durable rule applies to any deferral mechanism.

---

## team-ship (or new team-go-live) — 1 recommendation

### S1 — Live verification of headline path post-deploy [MR-R8]

- **Add:** *"For features with an observable user-facing behavior (UI, API, deployable service, scheduled job, integration), exercise the headline path once after deploy and capture the actual user-facing output (screenshot, API response, log line showing the feature firing) before declaring done. Tests pass ≠ feature works."*
- **Why:** mnemon-rearchitecture recall injection was 0% functional in production despite all 423 tests passing — every gate cleared but the headline UX silently never fired. Surfaced only when Dave manually tested via Discord @mention.
- **Note:** Could land in `team-ship` as a new step or in a new `team-go-live` skill. Minimum-viable: add to `team-ship` as a final post-merge step. Don't create a new skill unless there's clear demand for separate go-live tracking.

---

## What worked across both features (preserve, don't change)

These are signals, not change recommendations — surface them so the implementing session knows what NOT to "improve":

- **Codex Validator E** earned its keep on instrumented-memory-recall (E1 CRITICAL `require()` would have shipped silently broken). Cross-model perspective for runtime-class bugs is a real gap that Claude reviewers tile poorly.
- **Pre-build drift gate** caught real plan/design contradictions on both features (Spearman in plan / Spearman cut from design on instrumented-memory-recall; 4 DIVERGED + 2 PARTIAL on mnemon-rearchitecture). Mechanical fix at plan time is hours faster than discovering post-build.
- **3-cycle review cap** fired correctly in both features. Cycle 2 fixes that introduce new bugs is exactly the signal it's meant to surface.
- **2-extractor drift convergence** (Claude Sonnet + Codex xhigh) produced agreed-upon findings in both features.
- **Constraint-traceability table** in `/team-plan` (mnemon-rearchitecture) and explicit ASSERT lines (both features) wired HARD constraints to test cases cleanly.
- **Codex round 3 / cycle-cap discipline** — both features hit a cycle cap that surfaced real issues. Don't loosen the cap to avoid the escalation; the escalation is the feature.

---

## What to stop doing across both features

- **Lead unilaterally skipping Validator CD** (instrumented-memory-recall). Either run it or have explicit user opt-in. Q1 above.
- **Reviewer B missing cycles** (instrumented-memory-recall cycle 3). Add a pre-flight checklist to `/team-review` that forces all reviewers to be spawned (or explicitly skipped with reason). *(Not a separate recommendation above — a pre-flight checklist edit folds into V1 if the implementing session sees a clean way to combine, otherwise add as V2 with provenance "IMR cycle-3 procedural gap, review.md:23".)*
- **Treating reviewer "recommendations" as spec text** (mnemon-rearchitecture M7). V1 above.
- **Honoring "out of scope, defer" classifications when the feature is broken** (mnemon-rearchitecture F3). Q2 above.
- **Defining MVP scope retroactively in cycle 3** (instrumented-memory-recall D35-D40). D1 above.

---

## Suggested implementation order

If implementing all 15 sequentially, a reasonable order by impact-and-risk:

1. **C1** (CLAUDE.md `require()` guardrail) — lowest risk, immediate value, project-specific.
2. **D3** (Numeric HARD constraints need empirical evidence) — highest impact (live UX failure mode), one paragraph in team-design.
3. **D4** (Pseudocode primitives repo-verified) — second highest impact (twice-bitten), one paragraph in team-design.
4. **Bd1** (Caller coverage on contract changes) — concrete, testable rule.
5. **Bd2** (Behavioral tests not source-grep) — concrete, testable rule.
6. **Q1** (CD-skip explicit opt-in) — tightens existing branch.
7. **Q2** (Deferred findings can't be blockers) — tightens existing pattern.
8. **D1** (MVP scope boundary cycle 1) — adds Step 6c.
9. **D2** (Simplification option in cycle-cap) — extends existing options list.
10. **V1** (Recommendations promoted or `[NEEDS SPEC]` tagged) — close gate addition.
11. **D5** (SOT consolidation post-cycle) — close gate addition.
12. **P1** (LLM-input field tracing) — bullet in team-plan Step 4.
13. **P2** (Symbol-dependency check) — pass in team-plan Step 5.
14. **B1** (Coverage matrix) — bullet in team-brief Step 1.
15. **S1** (Live verification post-deploy) — final step in team-ship.

Order is suggestive. The implementing session should re-check the meta-rule (minimum-viable scope) and may bundle related edits if a single skill-section rewrite covers multiple recs cleanly.
