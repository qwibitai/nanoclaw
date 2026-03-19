---
name: gap-analysis
description: Systematic analysis of kaizen issues and incidents to find tooling gaps, testing gaps, horizon concentration, and unnamed dimensions. Produces prioritized lists for filing kaizens, writing feature PRDs, and writing meta/horizon PRDs. Triggers on "gap analysis", "analyze gaps", "what gaps do we have", "tooling gaps", "testing gaps", "horizon analysis", "where are problems concentrated".
---

# Gap Analysis — Strategic Kaizen Intelligence

**Role:** The strategist. Looks across the entire kaizen backlog and incident history to find patterns, gaps, and unnamed dimensions that individual issue triage misses. Produces actionable output that feeds into `/pick-work`, `/write-prd`, and `/kaizen`.

**Philosophy:** See the [Zen of Kaizen](../../kaizen/zen.md) — especially *"A good taxonomy of the problem outlasts any solution"* and *"The horizon you can't name climbs you."*

**When to use:**
- Periodic strategic review of the kaizen system
- Before planning a sprint or large body of work
- After a cluster of incidents suggests a systemic pattern
- When asking "where should we invest next?" at the meta level
- When the user asks about gaps, concentration, or unnamed horizons

## The Process

This is a multi-phase analysis. Each phase produces a concrete artifact. The skill is designed to run with parallel research agents for speed.

### Phase 1: Gather the Landscape

Launch **two parallel research agents** to collect raw data:

**Agent A — Issues & Structure:**
```bash
# All open kaizen issues with full context
gh issue list --repo Garsson-io/kaizen --state open --limit 100 --json number,title,labels,body,createdAt,updatedAt,comments

# Recently closed issues (last 20) for pattern detection
gh issue list --repo Garsson-io/kaizen --state closed --limit 20 --json number,title,labels,closedAt,body

# Active cases and their linked issues
node -e "const db=require('better-sqlite3')('/home/aviadr1/projects/nanoclaw/store/messages.db'); console.log(JSON.stringify(db.prepare(\"SELECT name, status, type, github_issue, description FROM cases WHERE status NOT IN ('pruned','done','reviewed') ORDER BY status\").all(), null, 2))"
```

Also read:
- Existing horizon taxonomies: `docs/horizons/` directory and any `horizon.md` files
- The kaizen system docs: `.claude/kaizen/` directory
- The enforcement level framework in the kaizen SKILL.md

**Agent B — Incidents & Friction:**
```bash
# Issues with incident comments (search for "incident", "broke", "failed", "manual fix")
gh issue list --repo Garsson-io/kaizen --state open --limit 100 --json number,title,body,comments --jq '.[] | select(.body + (.comments | map(.body) | join(" ")) | test("incident|broke|failed|manual fix|production|hotfix"; "i"))'
```

Also search for:
- Hook enforcement gaps: `.claude/kaizen/hooks/` and what they cover vs what they don't
- Test coverage: what's tested, what critical paths have zero coverage
- CI pipeline: what checks exist, what's missing

### Phase 2: Classify Gaps

Organize findings into three categories:

#### A. Testing Gaps

For each untested critical path, record:

| Component | LOC | What's at risk | Related kaizen # | Severity |
|-----------|-----|---------------|-----------------|----------|
| ... | ... | ... | ... | Critical/High/Medium |

**Key questions:**
- Which components have zero test coverage?
- Which tests exercise mocks but never the real artifact? (fidelity gap)
- Which integration paths are tested in isolation but never end-to-end?
- Is there source-to-artifact drift (source fixed but dist/ stale)?

#### B. Tooling Gaps

For each missing tool/check/enforcement:

| Gap | Level | Kaizen # | Impact | Effort |
|-----|-------|----------|--------|--------|
| ... | L1-L3 | ... | ... | Low/Med/High |

**Key questions:**
- What L1 instructions have failed and need L2+ escalation?
- What enforcement hooks are missing or have false positive/negative issues?
- What MCP tools need policy enforcement added?
- What CI checks are missing?

#### C. Taxonomy & Horizon Gaps

**Key questions:**
- Are problems concentrated in specific horizons?
- Does each horizon have a clear taxonomy with levels/dimensions?
- Are there clusters of issues that don't fit any existing horizon?
- Is there an unnamed dimension where incidents keep recurring?

### Phase 3: Analyze Concentration

For each existing horizon, count:
- Open issues assigned to it
- Incidents (concrete failures) within it
- Active work in progress

Present this as a concentration map:

```
Horizon              | Open | Incidents | Active | Assessment
---------------------|------|-----------|--------|------------
Testability          |   N  |     N     |   N    | Over/Under/Balanced
Autonomous Kaizen    |   N  |     N     |   N    | ...
Security             |   N  |     N     |   N    | ...
...                  |      |           |        |
```

Look for:
- **Over-concentrated:** Many issues, few incidents — may be over-engineering
- **Under-concentrated:** Few issues, many incidents — blind spot
- **Orphaned incidents:** Incidents that don't map to any horizon — signal of an unnamed dimension

### Phase 4: Identify Unnamed Dimensions

This is the most valuable part. Look for:

1. **Incident clusters that don't fit existing horizons** — If 3+ incidents share a root cause pattern that no horizon tracks, name it.

2. **Missing axes on existing horizons** — A horizon may track one dimension (e.g., test depth) but miss another (e.g., test fidelity). The signal: issues that belong to the horizon but the taxonomy can't express.

3. **Cross-horizon dependencies** — "X can't improve until Y reaches level N." These implicit dependencies should be made explicit.

For each candidate unnamed dimension, evaluate:
- Is this truly a new horizon (infinite game, fundamental quality dimension)?
- Or is it a missing axis on an existing horizon?
- Or is it actually a feature (finite, has a definition of done)?

### Phase 5: Produce Actionable Output

Organize all findings into three prioritized lists:

#### List 1: Low-Hanging Fruit (file as kaizen issues)

Issues that are:
- Small scope (hours, not days)
- Clear fix (no architectural decisions needed)
- High incident count relative to fix effort
- L1 to L2 escalations where the L1 already failed

Format each as a ready-to-file kaizen issue with: title, body (what/why/how), labels.

#### List 2: Feature PRD Candidates

Work items that are:
- Concrete features with a definition of done
- Too large for a single issue but not epic-sized
- Clear enough to spec without major discovery

Format each as: title, one-paragraph summary, estimated scope (S/M/L), blocking dependencies.

#### List 3: Meta/Horizon PRD Candidates

Work items that are:
- New horizons or horizon taxonomy updates
- Cross-cutting architectural changes
- Process/system redesigns
- Foundational infrastructure (like incident data layer)

Format each as: title, one-paragraph summary, what it enables (downstream value), why now.

### Phase 6: Present to Admin

Present the full analysis in a structured format:

1. **Executive summary** — 3-5 sentences on the biggest findings
2. **Concentration map** — where problems cluster
3. **Critical gaps table** — testing and tooling gaps ranked by severity
4. **Unnamed dimensions** — what's climbing you that you haven't named
5. **Recommended priority** — immediate / next sprint / foundational
6. **Three actionable lists** — low-hanging fruit, feature PRDs, meta PRDs

Ask the admin:
- Do these findings match your intuition? What's surprising?
- Which list should we act on first?
- Any gaps I missed that you've felt but not articulated?

## After the Analysis

The output of this skill feeds into:
- **Low-hanging fruit** — file as kaizen issues, then `/pick-work` to start executing
- **Feature PRDs** — `/write-prd` for each, producing specs and tracking issues
- **Meta/Horizon PRDs** — `/write-prd` (horizon mode) for taxonomy updates

This skill should be run periodically (every 2-4 weeks or after a burst of incidents) to keep the strategic view fresh.

## Integration with the Dev Work Skill Chain

```
/gap-analysis  (strategic: where should we invest?)
    ↓
  Low-hanging fruit → file kaizen issues → /pick-work → /accept-case → /implement-spec
  Feature PRDs → /write-prd → /plan-work → /implement-spec
  Meta PRDs → /write-prd (horizon mode) → /plan-work → /implement-spec
    ↓
/kaizen  (reflect on the work, close the loop)
```

`/gap-analysis` sits ABOVE `/pick-work` in the skill chain — it's the strategic layer that decides WHERE to invest before `/pick-work` decides WHICH specific issue to tackle.

## Anti-patterns

- **Analysis paralysis** — Don't spend days analyzing. The goal is actionable lists, not a perfect taxonomy. Ship the analysis, iterate.
- **Counting without reasoning** — Raw issue counts mean nothing. A horizon with 2 issues and 5 incidents is more important than one with 10 issues and 0 incidents.
- **Ignoring the unnamed** — The most valuable output is often the unnamed dimension. Don't force-fit everything into existing categories.
- **Skipping incidents** — Issues are hypotheses. Incidents are data. Always weight incidents higher than issue counts.
