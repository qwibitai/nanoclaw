---
id: EXP-001
title: "H3: agents game KAIZEN_IMPEDIMENTS structured output"
hypothesis: "Agents produce syntactically valid KAIZEN_IMPEDIMENTS that are semantically empty - declarations pass format checks but content is hollow"
falsification: "If >70% of reflections contain actionable, non-restating impediments, the hypothesis is falsified"
pattern: probe-and-observe
status: completed
issue: 388
created: 2026-03-21
completed: 2026-03-21
result: inconclusive
measurements:
  - name: "prs_with_persisted_reflections"
    method: "gh api search PR comments for Kaizen Reflection"
    expected: "majority of recent PRs"
    actual: "1 out of 20 (PR #276 only)"
  - name: "reflection_quality_pr276"
    method: "manual classification of impediments in the one persisted reflection"
    expected: "mostly hollow/restating"
    actual: "3/3 findings were substantive (shell injection fix, meta-discovery, pattern recognition)"
  - name: "prs_with_ephemeral_declarations"
    method: "grep PR bodies for KAIZEN_IMPEDIMENTS references"
    expected: "most PRs discuss impediments"
    actual: "6 of 20 mention KAIZEN_IMPEDIMENTS, but as feature descriptions, not declarations"
---

## Context

Kaizen #388 (H3) hypothesizes that agents game KAIZEN_IMPEDIMENTS — producing syntactically valid but semantically empty declarations. This was motivated by incidents where agents declared "no impediments" when they had introduced dep bypasses or mock pollution (PR #272 incident).

The experiment aims to measure this systematically by analyzing real KAIZEN_IMPEDIMENTS data from merged PRs.

## Design

**Pattern:** Probe-and-observe — no control group, just measurement of existing data.

**Procedure:** Scrape the last 20 merged PRs in Garsson-io/nanoclaw for:
1. Persisted reflection comments (posted by pr-kaizen-clear hook since PR #276)
2. KAIZEN_IMPEDIMENTS mentions in PR bodies
3. KAIZEN_NO_ACTION or "no impediments" declarations

**Measurements:**
- Count of PRs with persisted vs ephemeral reflections
- Semantic quality of each impediment (actionable vs restating vs hollow)
- Ratio of "no impediments" declarations vs filed issues

## Procedure

1. `gh pr list --state merged --limit 20` to get recent PRs
2. For each PR, check issue comments for "Kaizen Reflection" (persisted format)
3. For each PR, check body for KAIZEN_IMPEDIMENTS references
4. Classify each impediment found

## Raw Data

### Persisted reflections (PR comments)

Only **PR #276** has a persisted Kaizen Reflection comment (because #276 is the PR that added the persistence feature):

| Finding | Type | Disposition | Quality |
|---------|------|-------------|---------|
| Shell injection risk in defaultPostComment | standard | fixed-in-pr | Substantive — real security issue found and fixed |
| Reflection persistence as prerequisite discovery | meta | filed | Substantive — identified that H2+H3 can't be tested without persistence first |
| DI pattern for postComment matches existing pattern | positive | no-action | Substantive — valid positive observation |

### PR body mentions of KAIZEN_IMPEDIMENTS

6 of 20 PRs mention KAIZEN_IMPEDIMENTS in their body, but these are about the KAIZEN_IMPEDIMENTS *system* (building/fixing it), not actual impediment declarations:
- PR #276: Implementing persistence
- PR #259: Testing the lifecycle
- PR #258: Eliminating waiver disposition
- PR #254: Multi-PR gate targeting
- PR #252: JSON extraction robustness
- PR #218: Type-aware validation

### PRs without any reflection trace

PRs #275, #273, #271, #268 and others — no reflection comments, no KAIZEN_IMPEDIMENTS mentions in body. Reflections fired during the session (gating the agent), but left no audit trail.

## Analysis

**Result: Inconclusive** — we cannot measure H3 because the data doesn't exist yet.

The fundamental finding is a **measurement infrastructure gap**: prior to PR #276, KAIZEN_IMPEDIMENTS were ephemeral. They gated the agent during the session but were never persisted. This means:

1. **We cannot measure historical reflection quality** — the data was never saved
2. **The one persisted reflection (#276) is high quality** — 3/3 findings are substantive
3. **But N=1 is not statistically meaningful**

The hypothesis may still be true for the ephemeral reflections we can't see. The PR #272 incident (agent declaring "no impediments" while introducing dep bypass) suggests gaming does occur, but we can't measure prevalence.

**Why inconclusive instead of falsified:** The one data point we have (PR #276) is high quality, but it was created by a session specifically focused on improving kaizen reflection. That's selection bias — the agent was primed to reflect well.

## Learnings

1. **You can't analyze what you don't persist.** The experiment validated #276's design decision: reflection persistence is a prerequisite for quality measurement.
2. **The experiment framework itself works.** Using the CLI to create → start → analyze → record provides a structured workflow that prevents ad-hoc analysis.
3. **H3 needs a rerun.** After 10+ PRs with persisted reflections, rerun this experiment to get meaningful N.
4. **Selection bias in first data points.** First persisted reflection came from a kaizen-improvement session — naturally higher quality. Need organic data.

## Next Steps

- [ ] Rerun this experiment after 10+ PRs have persisted reflections (target: ~2 weeks)
- [ ] Track PR #272-style incidents: cases where "no impediments" was declared but follow-up fixes were needed
- [ ] Consider adding a "reflection quality score" to the persistence format for automated tracking
