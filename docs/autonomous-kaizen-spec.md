# Autonomous Kaizen — Specification

A system that gets better at getting better.

## 1. Problem Statement

### The Incident That Exposed the Gap

PRs #105, #106, #107 (March 2026): The `create_case` MCP tool had `gap_type` and `signals` in the handler but missing from the Zod schema. The project uses Zod v4, but the code used v3 syntax. The agent-runner had its own `tsconfig.json` that was **never type-checked** — not in CI, not in hooks. The container failed at runtime, users got "processing system unavailable" for every message until a human noticed and fixed it.

### What the Current Kaizen System Did

After the fix, `kaizen-reflect.sh` prompted the agent to reflect. The agent correctly identified it as Level 3 (humans affected) and added agent-runner type-checking to CI (#106). This was a good outcome.

### What the Current Kaizen System Didn't Do

| Gap | What should have happened |
|-----|--------------------------|
| **Class identification** | "This is a schema/handler desync — a contract violation." Not just "gap_type was missing." |
| **Blast radius scan** | "Where else could schema/handler desync exist?" Scan other MCP tools for the same pattern. |
| **Prevention system** | "Schema and handler must always be in sync" → contract test or co-generation, not just "add the missing field." |
| **Meta-reflection** | "Why didn't CI already catch agent-runner errors? Why was it excluded? What else is excluded?" |
| **Migration detection** | "Zod v3 syntax in a v4 project — is the migration complete? Where else is v3 syntax lurking?" |
| **Pattern matching** | No connection to past incidents where "thing A references thing B but they're out of sync." |

### The Deeper Problem

The kaizen system today is **reactive and instance-focused**. It asks "what went wrong here?" and produces a fix for THIS bug. It doesn't ask:

- What **class** of bug is this?
- Where else could this class exist?
- What **system** would prevent the entire class?
- Did the kaizen system itself fail to catch this? Why? How does IT improve?

Every human intervention — a correction, a review comment, a "that's not right" — is a signal that the system failed to prevent something. Currently those signals fix the instance and evaporate. They should compound.

### Cost of Not Solving It

Without this, the system stays on a treadmill: each new bug gets its own fix, but the same categories keep recurring. The kaizen backlog grows, but the system's preventive surface area doesn't grow proportionally. Human attention remains the bottleneck.

## 2. Desired End State

### The Learning Loop

Every stage of the dev lifecycle generates learning. The system captures, classifies, and acts on that learning — not just for the current incident, but for the category it belongs to.

```
  Human feedback / CI failure / review comment / production error
                          |
                    [1. CAPTURE]
                    structured incident record
                          |
                    [2. CLASSIFY]
                    bug class, root cause category,
                    affected layer, recurrence count
                          |
                    [3. ANALYZE]
                    root cause chain, blast radius,
                    "where else could this exist?"
                          |
                    [4. PREVENT]
                    design a system (not a patch)
                    that prevents the category
                          |
                    [5. META-REFLECT]
                    should the kaizen system itself
                    change? what did it miss? why?
                          |
                    [6. SIMPLIFY / CONSOLIDATE]
                    what hooks/tests/processes should
                    be consolidated, simplified, or removed?
                          |
                   (loop continues)
```

### The Continuous Improvement Algorithm (adapted from Musk's manufacturing process)

The manufacturing algorithm (question → delete → simplify → accelerate → automate) doesn't translate 1:1 to software. Physical parts have clear costs; software abstractions have subtler tradeoffs — DRY/reuse/consolidation is often better than deletion. But the **mindset** is valuable: always ask whether each piece of process is earning its keep.

Applied to every kaizen reflection:

1. **Question the requirement.** Is this hook/test/process even needed? Does the enforcement match a real risk, or is it ceremony? Every piece of enforcement has a maintenance cost — justify it.

2. **Ask: should we delete, simplify, or consolidate?** (Experimental — develop judgment here over time.) In manufacturing, "delete the part" is clear. In software, the answer is often "reuse," "consolidate overlapping checks," or "simplify the interface" rather than outright deletion. The question to ask: "Is this process pulling its weight? Could two checks become one? Could a 50-line hook be 10 lines? Is there a test that tests mocks instead of behavior?" Sometimes the answer IS deletion (a hook that never fires, a test that tests nothing real). But often it's improvement.

3. **Accelerate.** Faster feedback loops. Catch things at edit time, not CI time. Catch things at CI time, not production time. Reduce the distance between mistake and correction.

4. **Automate.** Only after steps 1-3. Automation of a bad process just makes it fail faster.

### What "Good" Looks Like

- When a bug is fixed, the reflection produces not just "what happened" but "what class of bug is this, where else does it exist, and what system prevents the category."
- When a PR review catches something the agent should have gotten right, the system asks "why did the agent miss this? what would have made it succeed the first time?"
- When CI catches an error, the system asks "should we have caught this earlier? At edit time? At the hook level?"
- When a human corrects the system, the correction is stored structurally and applied to future similar situations — not just as a CLAUDE.md line (L1) but as whatever enforcement level the pattern warrants.
- The system periodically asks: "what hooks never fire? what tests never fail? what processes add friction without catching real bugs?" — and proposes consolidation, simplification, or removal.
- Over time, the ratio of human interventions to automated catches decreases.

### What's Out of Scope

- **Autonomous code changes.** The system proposes improvements; humans approve and agents implement. No self-modifying code without human review.
- **Cross-vertical learning.** This spec covers the NanoClaw harness. Vertical-specific kaizen is a separate concern.
- **Real-time monitoring / alerting.** This is about the development process, not production observability.

## 3. Lifecycle Touchpoints

Learning happens at every stage. Each stage has its own signal type and its own improvement surface.

### 3.1 PR Creation — Friction and QoL

**Signals:** What slowed the agent down? What required multiple attempts? What was confusing or underdocumented?

**Current state:** `kaizen-reflect.sh` prompts after `gh pr create`. Agent lists friction points.

**Target state:** Structured capture of:
- Time spent on non-productive work (fighting hooks, finding docs, retrying builds)
- Tooling gaps ("I needed X but had to work around it")
- Documentation gaps ("I couldn't find how Y works")
- DX friction ("Z required 5 steps when it should be 1")

**Improvement surface:** Developer experience, tooling, documentation, hook ergonomics.

### 3.2 PR Review — Agent Success Rate

**Signals:** What did review catch that the agent should have gotten right the first time?

**Current state:** `pr-review-loop.sh` runs up to 4 self-review rounds. Issues found are fixed.

**Target state:** Track what categories of issues review catches:
- Missing tests (should hooks enforce this better?)
- Style/convention violations (should linting catch this?)
- Architecture violations (should hooks/contracts prevent this?)
- Logic errors (are the tools/context given to the agent sufficient?)

**Improvement surface:** Agent instructions, hook coverage, linting, contract enforcement.

### 3.3 CI and Tests — Coverage and Relevance

**Signals:** CI failures, test failures, and (critically) things CI DOESN'T catch.

**Current state:** CI runs typecheck, tests, pr-policy. Agent-runner typecheck added in #106.

**Target state:**
- Track what CI catches vs what slips through to production
- Identify things that SHOULD be tested but aren't (like agent-runner was)
- Identify tests that never fail (are they testing anything real?)
- Identify tests that test mocks instead of behavior

**Improvement surface:** CI pipeline, test suite, contract tests, build validation.

### 3.4 Pre-Merge / Staging — Integration Gaps

**Signals:** Things that work in isolation but fail when combined with other changes or in the real environment.

**Current state:** `verify-before-stop.sh` runs typecheck and tests before agent finishes. Branch protection requires CI pass.

**Target state:**
- Track integration failures that unit tests missed
- Identify missing integration test coverage
- Detect "works in worktree, breaks in container" patterns
- Track merge conflicts and their causes (design coupling?)

**Improvement surface:** Integration tests, contract tests, environment parity.

### 3.5 Post-Merge / Production — The Ultimate Signal

**Signals:** Things that passed every check but still broke in production. These are the most valuable signals because they represent gaps in the entire prevention chain.

**Current state:** Human notices production error, creates a case or fixes directly.

**Target state:**
- Every production error triggers root cause analysis through the full prevention chain
- "This passed CI, hooks, review, and still broke — every layer failed. Why?"
- Automatic escalation: if the same category of production error recurs, escalate enforcement level

**Improvement surface:** Everything. Production errors indict the entire pipeline.

### 3.6 Human Feedback — The Richest Signal

**Signals:** Every time a human says "no, not that," "stop doing X," "why did you do Y?" — the system failed to prevent an unwanted outcome.

**Current state:** Feedback memories in `~/.claude/` (L1 — local, not synced, not structured).

**Target state:**
- Human feedback is classified by category and linked to the enforcement layer that should have prevented it
- Recurring feedback in the same category triggers automatic escalation
- Feedback that contradicts existing enforcement triggers a review ("hook says X, human says Y — which is right?")

**Improvement surface:** Agent behavior, instructions, hooks, architectural constraints.

## 4. Architecture

### 4.1 Incident Record Schema

Every kaizen-relevant event produces a structured incident record. This is the atom of the learning system.

```
Incident Record:
  id:               unique identifier
  timestamp:        when it happened
  source:           pr_creation | pr_review | ci_failure | production |
                    human_feedback | meta_reflection
  lifecycle_stage:  which of the 6 stages (section 3)

  # Classification
  bug_class:        contract_violation | migration_incomplete |
                    missing_enforcement | test_gap | dx_friction |
                    architecture_violation | documentation_gap |
                    unnecessary_process | ...
  root_cause:       free text — the actual cause chain
  affected_layer:   mcp_tools | ipc_handlers | hooks | ci |
                    container | host | instructions | ...

  # Impact
  severity:         low | medium | high | critical
  human_affected:   boolean (did a human experience this?)
  recurrence:       first | recurring (link to previous)

  # Resolution
  fix_level:        L1 | L2 | L2.5 | L3
  fix_description:  what was done
  prevention_system: what systemic prevention was created (if any)
  blast_radius_scan: was the same class checked elsewhere? results?

  # Links
  pr_urls:          PRs that fixed this
  issue_url:        kaizen issue (if created)
  case_id:          dev case (if created)
  related_incidents: previous incidents in same class
```

### 4.2 Incident Store

The incident store must be **cloud-accessible** — agents, humans, and future automation all need to reach it from anywhere. Local-only storage (SQLite, JSON files) creates silos.

**Option A: GitHub Issues** (in `Garsson-io/kaizen`)
- Pros: Already using this for kaizen backlog, visible, searchable, linkable, free, built-in labels/milestones for classification
- Cons: API rate limits, no structured schema (labels + body template approximate it), harder to run aggregate queries

**Option B: Linear (free plan)**
- Pros: Structured fields, fast UI, good filtering/grouping, API-friendly
- Cons: Another tool to maintain, free plan limits

**Option C: GitHub Issues with structured body template**
- Pros: Same as A, but with a YAML/JSON frontmatter block in the issue body that tools can parse for structured queries
- Cons: Fragile parsing, depends on agents following the template

**Recommendation:** GitHub Issues in `Garsson-io/kaizen` with a structured body template (Option C). We already use this repo as the kaizen backlog. Add a machine-parseable YAML block at the top of each incident issue for structured fields (bug_class, severity, lifecycle_stage, recurrence_count, fix_level). Labels provide fast filtering. The body provides rich context. This is zero new infrastructure — just a convention on top of what exists. If we outgrow it, Linear or a dedicated tool is an easy migration since the data is already structured.

### 4.3 Enhanced Reflection Engine

The reflection engine is what turns raw signals into structured incident records and improvement proposals. It operates at two levels:

**Level A: Per-Event Reflection (at each lifecycle touchpoint)**

Triggered automatically by hooks at PR creation, review, CI failure, merge, and human feedback. Produces a structured incident record.

The reflection follows a fixed protocol:

```
1. WHAT HAPPENED?
   Describe the specific failure or friction point.

2. WHAT CLASS OF PROBLEM IS THIS?
   Categorize: contract violation, migration gap, missing enforcement,
   test gap, DX friction, architecture violation, etc.
   Link to known classes. If new class, name it.

3. ROOT CAUSE CHAIN
   Go deeper than the immediate cause.
   "gap_type missing from schema" → "handler and schema can diverge
   without detection" → "no contract test between MCP schema and
   handler usage" → "agent-runner not in CI at all"

4. BLAST RADIUS
   Where else could this same class of problem exist?
   Concretely: list files, tools, patterns to check.

5. FIX vs PREVENT
   What fixes THIS instance? (patch)
   What prevents THIS CLASS? (system)
   Are they the same? If not, both are needed.

6. WHAT LEVEL?
   L1 (instruction) — when is this sufficient?
   L2 (hook/CI) — what would the hook check?
   L3 (architectural) — what design makes it impossible?
   What level matches the severity and recurrence?

7. META: DID THE KAIZEN SYSTEM FAIL?
   Should an existing hook/test/process have caught this? Why didn't it?
   Is there a gap in the prevention chain?
   Should a hook be added, strengthened, simplified, or REMOVED?
```

**Level B: Cross-Incident Pattern Analysis (periodic)**

Runs as a scheduled task (e.g., weekly, or after N incidents accumulate). Queries the incident store for patterns:

```
1. RECURRING CLASSES
   Which bug classes keep appearing despite fixes?
   → These need enforcement level escalation.

2. ESCALATION FAILURES
   Which L1 fixes have recurred? → Escalate to L2.
   Which L2 fixes have been bypassed? → Escalate to L3.

3. DEAD ENFORCEMENT
   Which hooks never fire? → Consider removing.
   Which tests never fail? → Are they testing real behavior?
   Which CI steps never catch anything? → Are they valuable?

4. FRICTION HOTSPOTS
   Which parts of the workflow generate the most friction incidents?
   → Simplify or redesign.

5. IMPROVEMENT VELOCITY
   Are we preventing more categories over time?
   Is the human intervention rate decreasing?
   How long from "incident" to "prevention system in place"?

6. META: IS THE KAIZEN SYSTEM ITSELF IMPROVING?
   Are reflections getting more specific over time?
   Are prevention systems being created (not just instance fixes)?
   Is the incident store growing with diverse classes or repeating?
```

### 4.4 System Diagram

```
Dev Lifecycle Events                    Learning System

PR Creation ─────────┐
PR Review ───────────┤                 ┌──────────────────┐
CI / Tests ──────────┤──── signals ──→ │ Reflection Engine │
Pre-Merge ───────────┤                 │ (per-event)       │
Production Errors ───┤                 └────────┬─────────┘
Human Feedback ──────┘                          │
                                        structured incident
                                                │
                                        ┌───────▼─────────┐
                                        │  Incident Store  │
                                        │  (GitHub Issues) │
                                        └───────┬─────────┘
                                                │
                                        ┌───────▼─────────┐
                                        │ Pattern Analyzer │
                                        │ (periodic)       │
                                        └───────┬─────────┘
                                                │
                                    ┌───────────┼───────────┐
                                    ▼           ▼           ▼
                              Dev Cases    Hook Changes   Removals
                              (prevent     (strengthen    (simplify
                               class)      or weaken)     pipeline)
                                    │           │           │
                                    └───────────┼───────────┘
                                                │
                                        Human Approval
                                                │
                                        Implementation
                                                │
                                        ┌───────▼─────────┐
                                        │  Meta-Reflect   │
                                        │  "Did kaizen    │
                                        │   itself get    │
                                        │   better?"      │
                                        └─────────────────┘
```

### 4.5 Integration Points

| Component | How It Changes |
|-----------|---------------|
| `kaizen-reflect.sh` | Enhanced reflection protocol (7-step, not 5-step). Creates structured incident issue in GitHub. |
| `case_mark_done` MCP tool | Kaizen array gets richer schema: `bug_class`, `root_cause_chain`, `blast_radius`, `prevention_system`. |
| `pr-review-loop.sh` | Tracks WHAT categories review caught. Feeds into incident store. |
| `verify-before-stop.sh` | On failure, captures what failed and why as an incident. |
| New: Incident issue template | Structured incident records as GitHub Issues with YAML frontmatter. |
| New: Pattern analysis scheduled task | Periodic cross-incident analysis. |
| New: Incident query MCP tool | Agent can query past incidents by class, recurrence, etc. |
| Existing: `Garsson-io/kaizen` issues | Human-facing view of significant incidents and proposals. |

## 5. Interaction Models

### 5.1 Happy Path: PR Creation with Enhanced Reflection

```
1. Agent completes work, runs `gh pr create`
2. pr-review-loop.sh triggers self-review (existing)
3. Review passes after N rounds
4. kaizen-reflect.sh triggers enhanced reflection:
   a. Agent follows 7-step protocol
   b. Produces structured incident record (if issues found)
   c. Classifies bug class, root cause, blast radius
   d. Proposes prevention system (not just instance fix)
   e. Meta-reflects: "should kaizen itself change?"
5. Incident issue created in Garsson-io/kaizen (with structured YAML block)
6. If significant: GitHub issue created in Garsson-io/kaizen
7. If actionable: dev case suggested via case_suggest_dev
8. Agent continues to merge flow
```

### 5.2 Human Feedback Loop

```
1. Human says "no, don't do X" or "that's wrong because Y"
2. Agent captures this as a feedback memory (existing)
3. NEW: Agent also creates an incident record:
   - source: human_feedback
   - bug_class: (classified by agent)
   - root_cause: "why did I do X? what led me to this?"
4. System checks: has this class of feedback occurred before?
   - If yes: previous prevention wasn't sufficient → propose escalation
   - If no: L1 feedback memory may be sufficient
5. Agent acknowledges and adjusts behavior
```

### 5.3 Cross-Incident Pattern Detection (Periodic)

```
1. Scheduled task runs (weekly, or after 5+ new incidents)
2. Queries incident store for:
   - Recurring bug classes
   - L1 fixes that recurred (need L2)
   - L2 fixes that were bypassed (need L3)
   - Hooks that never fire (candidates for removal)
3. Produces a "kaizen health report":
   - Top 3 recurring categories
   - Proposed escalations
   - Proposed removals/simplifications
   - Overall trend: improving or stagnating?
4. Report sent to leads (Telegram)
5. Actionable items become dev case suggestions
```

### 5.4 Meta-Kaizen: The System Evaluates Itself

```
1. After each pattern analysis run, the system asks:
   a. "Did the enhanced reflection protocol catch things the old one would have missed?"
   b. "Are incident records getting more specific and useful over time?"
   c. "Are prevention systems actually being created, or just proposed?"
   d. "Is the ratio of production errors to pre-merge catches improving?"
2. If the answer to any is "no" or "unclear":
   a. Create a kaizen issue for the kaizen system itself
   b. Propose specific changes to the reflection protocol, hooks, or analysis
3. This is recursive: meta-kaizen can identify that meta-kaizen itself needs improvement
   (but practically: 2 levels of recursion is enough)
```

## 6. State Management

| Component | State | Storage | Survives Restart | Recovery |
|-----------|-------|---------|-----------------|----------|
| Incident records | Structured incident data | GitHub Issues in `Garsson-io/kaizen` with YAML frontmatter | Yes (cloud) | N/A — persistent |
| Pattern analysis results | Latest analysis report | GitHub Issue (pinned) or wiki page | Yes (cloud) | Re-run analysis |
| Bug class taxonomy | Known categories + descriptions | JSON config file | Yes | N/A — version controlled |
| Enforcement inventory | List of all hooks, CI steps, tests with metadata | Generated from code scan | Regenerated | Scan on demand |

## 7. What Exists vs What Needs Building

### Already Exists

| Capability | Implementation | Status |
|------------|---------------|--------|
| Per-PR kaizen reflection | `kaizen-reflect.sh` | Working, but shallow |
| Case completion reflection | `case_mark_done` kaizen array | Working, basic schema |
| Kaizen backlog | GitHub Issues `Garsson-io/kaizen` | Working |
| Dev case suggestions | `case_suggest_dev` MCP tool + IPC | Working |
| Hook enforcement framework | 12 hooks in `.claude/kaizen/hooks/` | Working |
| PR self-review | `pr-review-loop.sh` (4 rounds) | Working |
| Escalation levels (L1-L3) | Documented in SKILL.md | Working (conceptual) |

### Needs Building

| Component | What | Why It Doesn't Exist Yet |
|-----------|------|-------------------------|
| **Enhanced reflection protocol** | 7-step structured reflection replacing current 5-step | Current protocol asks "what happened" but not "what class" or "where else" |
| **Incident issue template** | Structured GitHub Issue template with YAML frontmatter for machine-parseable fields | Currently reflections are ephemeral — they produce issues/cases but the analysis itself is lost |
| **Incident record writer** | Hook/tool logic that creates structured incident issues via `create_github_issue` | No infrastructure to capture reflections structurally |
| **Bug class taxonomy** | Initial set of categories (contract_violation, migration_incomplete, etc.) | Currently freeform — no shared vocabulary across incidents |
| **Blast radius scanner** | Given a bug class, find other instances of the same pattern in the codebase | Currently agents might do this ad-hoc, but it's not part of the protocol |
| **Cross-incident query tool** | MCP tool for agents to query incident history by class, recurrence, layer | Agents can't currently learn from past incidents |
| **Pattern analysis task** | Scheduled task that runs periodic cross-incident analysis | No periodic analysis exists |
| **Kaizen health report** | Summary of trends, recurring categories, proposed actions | No aggregate view of kaizen effectiveness |
| **Enforcement inventory scanner** | Catalog all hooks, CI steps, tests with metadata (last fired, what it catches) | No way to identify dead enforcement or gaps |
| **Enhanced case_mark_done schema** | Add bug_class, root_cause_chain, blast_radius, prevention_system to kaizen array | Current schema is just issue/suggestion/severity |
| **Feedback-to-incident bridge** | When human feedback is captured, also create a structured incident record | Feedback memories and incident tracking are separate systems |

## 8. Open Questions and Known Risks

### Open Questions

**Q1: How structured should the reflection be?**
- Option A: Fully structured — agent fills in specific fields for each of the 7 steps. Machine-parseable.
- Option B: Semi-structured — agent writes free-form text following the protocol, with key fields extracted.
- Option C: Start with B, migrate to A as the taxonomy stabilizes.
- **Lean: C.** Too much structure too early will produce low-quality checkbox answers. Let the taxonomy emerge from real incidents, then crystallize it.

**Q2: Should pattern analysis use an LLM or be rule-based?**
- Option A: Rule-based — GitHub API queries for recurrence by label, simple category matching.
- Option B: LLM-assisted — feed incident records to Claude for cross-cutting pattern identification.
- Option C: Start with A, add B when rule-based misses patterns humans notice.
- **Lean: A first, then C.** Rule-based is deterministic and debuggable. LLM adds insight but also hallucination risk. Start simple.

**Q3: Where does the bug class taxonomy live?**
- Option A: Hardcoded in the reflection hook
- Option B: JSON config file (version-controlled, editable)
- Option C: Emergent from incident records (no fixed list — agent classifies freely)
- **Lean: B with C as input.** Start with a seed taxonomy from known categories, let agents suggest new classes, periodically review and merge.

**Q4: How do we handle simplification/consolidation practically?**
- Software isn't a physical product — "delete the part" doesn't translate directly. DRY, reuse, and consolidation are often better than deletion. This is an area to develop judgment over time.
- When the system identifies a hook that never fires, the options are: consolidate it into a broader check, simplify it, or remove it. Pure removal feels risky since hooks exist because of past incidents.
- Experimental approach: Track "last fired" timestamp for every hook. If a hook hasn't fired in 60 days, flag it for review. The review asks: "is the risk still real? has the architecture made this impossible? could this be consolidated with another check? or should it be removed?"
- This is explicitly visionary/experimental — develop the instinct for when to simplify vs when to leave alone.

**Q5: Should there be a dedicated kaizen reflection skill?**
- The current reflection lives in `kaizen-reflect.sh` (a hook). Making it a skill would allow richer interaction (agent can query incident store, do blast radius scans, etc.)
- But skills are agent-invoked (L1-ish), while hooks are automatic (L2).
- Possible: hook triggers the protocol, skill provides the tools for deeper analysis when needed.

### Known Risks

**Risk: Over-kaizening.** Adding too many hooks, checks, and processes creates DX friction that slows development and produces false positives. The "simplify/consolidate" step exists specifically to counter this, but developing the judgment for when to simplify vs when to add is an ongoing experiment.

**Risk: Taxonomy sprawl.** Without curation, bug classes multiply until they're meaningless. Need periodic consolidation (part of the pattern analysis task).

**Risk: Reflection fatigue.** If every PR triggers a heavyweight 7-step reflection, agents will produce low-effort answers to get through it. Mitigation: make the protocol proportional to the incident severity. Minor QoL issues get light treatment; production outages get full analysis.

**Risk: Recursion depth.** Meta-kaizen that kaizens meta-kaizen is intellectually fun but practically useless beyond 2 levels. Cap it.

## 9. Implementation Sequencing

### Phase 1: Foundation (2-3 PRs)

**Goal:** Structured incident capture and enhanced reflection.

1. **Incident store** — GitHub Issue template with YAML frontmatter, labels for classification, `create_github_issue` integration.
2. **Enhanced reflection protocol** — Update `kaizen-reflect.sh` with the 7-step protocol. Agent writes free-form following the structure; key fields (bug_class, severity, human_affected) extracted and stored.
3. **Seed bug class taxonomy** — JSON config with initial categories derived from past incidents.

### Phase 2: Query and Learn (2-3 PRs)

**Goal:** Agents can learn from past incidents.

4. **Incident query MCP tool** — Agent can search incidents by class, layer, recurrence. "Show me all contract_violation incidents" before starting a fix.
5. **Enhanced case_mark_done** — Richer kaizen schema with bug_class, root_cause_chain, blast_radius, prevention_system fields.
6. **Blast radius scanner** — Given a bug class and pattern, grep the codebase for similar issues. Surface in reflection.

### Phase 3: Pattern Detection (2-3 PRs)

**Goal:** Cross-incident learning and proactive improvement.

7. **Pattern analysis scheduled task** — Periodic analysis of incident store. Recurrence detection, escalation proposals, dead enforcement identification.
8. **Kaizen health report** — Summary sent to leads via Telegram. Trends, top categories, proposed actions.
9. **Enforcement inventory** — Catalog all hooks/CI/tests with metadata. Last fired, what it catches, whether it's still needed.

### Phase 4: Meta and Simplify (1-2 PRs)

**Goal:** The system evaluates and improves itself.

10. **Meta-kaizen reflection** — After each pattern analysis, evaluate whether the kaizen system itself is improving. Self-referential but capped at 2 levels.
11. **Simplify/consolidate proposals** — System proposes consolidation of overlapping checks, simplification of heavyweight processes, and (where clearly warranted) removal of dead enforcement. Experimental — develop judgment over time.

### Dependency Graph

```
Phase 1: [incident store] → [reflection protocol] → [taxonomy]
              │
Phase 2: [query tool] → [enhanced case_mark_done] → [blast radius]
              │
Phase 3: [pattern analysis] → [health report] → [enforcement inventory]
              │
Phase 4: [meta-kaizen] → [simplify proposals]
```

Phases 1 and 2 can partially overlap. Phase 3 depends on having enough incident data from Phases 1-2. Phase 4 depends on Phase 3.

## 10. Success Criteria

How do we know this is working?

| Metric | Current | Target |
|--------|---------|--------|
| Incident records captured per month | 0 (no structured capture) | All significant incidents |
| Bug classes identified | 0 (freeform) | 10-20 well-defined categories |
| Prevention systems created (not just instance fixes) | Ad-hoc | Every recurring category has one |
| Production errors that passed all checks | Unknown | Tracked, trending down |
| Hooks that never fire | Unknown | Identified, reviewed quarterly |
| Human intervention rate | Unknown baseline | Tracked, trending down |
| Time from incident to prevention system | Days-weeks (manual) | Proposed same-session, implemented within 1-2 PRs |
| Recurring incidents in same class after prevention | Unknown | Tracked, should be zero |
