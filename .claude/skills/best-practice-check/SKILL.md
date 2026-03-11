---
name: best-practice-check
description: >
  Assess whether current implementation follows known patterns and best practices.
  Researches established approaches via exa before forming opinions. Reports on
  pattern conformance, drift from best practices, and maintainability/scalability
  assessment. Read-only — no code changes.
  Use when user asks "are we following a known pattern", "best practices check",
  "how maintainable is this", "are we drifting", "pattern check", "sanity check".
  Do not use for code review (use /review-swarm), design review (use /team-review),
  or when the user wants code changes made.
version: 1.0.0
---

# /best-practice-check — Known Pattern Conformance Assessment

## What This Skill Does

Assesses whether the current implementation (or a specified scope) follows established, known patterns for the problem it's solving. Researches real-world approaches before forming opinions — does not rely on training data alone.

**Output:** Structured assessment with pattern identification, conformance analysis, drift report, and maintainability/scalability rating.
**NOT output:** Code changes, refactoring suggestions with implementation, or design documents. This is a diagnostic, not a prescription.

## Prerequisites

- Code to assess — either the current working directory, a specific file/module, or a described subsystem
- If no scope is clear, ask: "Which part of the system should I assess?"

## When to Use

- Mid-build sanity check: "Are we building this the right way?"
- Before committing to an architectural approach
- When something feels off but the issue is unclear
- Periodic health checks on a subsystem

## When NOT to Use

- Code review (bugs, edge cases, correctness) → `/review-swarm`
- Design document review → `/team-review`
- When the user wants fixes applied → just fix it directly

---

## Process

### Step 1: Identify What's Being Built

Read the code in scope and determine:
1. **The problem being solved** — what is this code trying to do? (e.g., "message queue with per-group isolation", "IPC between host and container agents")
2. **The approach taken** — what pattern is the code using? (e.g., "polling-based file IPC", "Map-based session tracking with container lifecycle")
3. **The technology context** — language, runtime, frameworks, constraints

Write a 2-3 sentence summary. Confirm with the user if the scope is ambiguous.

### Step 2: Research Known Patterns

**This step is mandatory. Do not skip it.** Claude's training data is not sufficient — research what the industry actually does for this class of problem.

Use the **research chain**:

1. **Exa first** — `mcp__exa__web_search_exa` with queries like:
   - "[problem domain] architecture patterns"
   - "[specific approach] best practices [language/runtime]"
   - "[problem domain] production [language] open source"
2. **Exa code context** — `mcp__exa__get_code_context_exa` to find how real projects solve this
3. **WebSearch fallback** — if exa returns insufficient results

For each pattern found, note:
- Pattern name (if it has one)
- Where it's commonly used (which projects, what scale)
- Key characteristics and constraints
- Known failure modes

Gather **at least 2-3 established patterns** for the problem domain before proceeding.

<!-- GATE: research-complete — At least 2 patterns researched via exa before assessment -->

### Step 3: Assess Conformance

Compare the implementation against discovered patterns across three lenses:

#### Lens 1: Pattern Conformance
- Which known pattern does this most closely follow?
- Where does it conform faithfully?
- Where does it deviate — and is the deviation intentional/justified or accidental drift?
- Is the chosen pattern appropriate for the scale and constraints?

#### Lens 2: Best Practice Drift
- What best practices exist for this pattern that the implementation doesn't follow?
- Are there anti-patterns present?
- Is the drift cosmetic (naming, structure) or structural (missing error handling, incorrect lifecycle)?

#### Lens 3: Maintainability, Scalability, Repeatability
- **Maintainability:** Can someone unfamiliar with this code understand and modify it? Are boundaries clear?
- **Scalability:** What breaks first as load/complexity grows? Is the current approach appropriate for the expected scale?
- **Repeatability:** Could this pattern be applied to a similar problem elsewhere? Is it generic enough, or too coupled?

### Step 4: Present Assessment

Use this format:

```
---
**Pattern Check: [subsystem/scope name]**

**What's being built:** [2-3 sentence summary from Step 1]

**Closest known pattern:** [pattern name or description]
Source: [where this pattern is documented/used — cite exa findings]

**Conformance:**
- [area]: CONFORMING — [brief note]
- [area]: CONFORMING — [brief note]
- [area]: DRIFTING — [what differs and why it matters]
- [area]: NOVEL — [no known pattern match; this is custom]

**Best Practice Drift:**
[If drifts found:]
- [drift]: Severity [LOW/MEDIUM/HIGH] — [what the best practice is vs what the code does]
[If none:]
- No significant drift from established practices.

**Maintainability:** [GOOD/FAIR/POOR] — [1-2 sentences]
**Scalability:** [GOOD/FAIR/POOR] — [1-2 sentences, what breaks first]
**Repeatability:** [GOOD/FAIR/POOR] — [1-2 sentences]

**Bottom line:** [1-2 sentences — is this on the right track?]
---
```

<!-- GATE: assessment-presented — Structured assessment shown before any follow-up -->

**STOP here.** Do not suggest code changes. If the user wants fixes, they will ask — that's a separate task.

---

## Anti-Patterns (Do Not Do These)

- **Opining without research.** Do not assess pattern conformance from training data alone. The research step exists because patterns evolve and Claude's knowledge has a cutoff.
- **Suggesting code changes.** This is a diagnostic skill. "Here's what's wrong and here's the fix" belongs in a different workflow.
- **Vague assessments.** "This looks fine" or "could be improved" without specifics. Every conformance/drift claim must reference a specific pattern or practice found in research.
- **Comparing to ideal rather than practical.** The question is "does this follow known patterns for this scale" — not "could this be a FAANG-scale system."
- **Inventing pattern names.** If no established pattern matches, say NOVEL. Don't fabricate a pattern name to sound authoritative.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "I already know the patterns for this" | Training data has a cutoff. Research confirms current best practice, not 2-year-old assumptions. |
| "The code is too small to have a pattern" | Even 50 lines follow or break patterns. Small code drifts compound into large architectural debt. |
| "No one builds exactly this" | Find the closest analog. IPC between host and container agents isn't unique — message passing between processes is well-studied. |
| "Everything is CONFORMING, nothing to report" | Unlikely. If every assessment is clean, the research was too shallow or the lenses weren't applied critically. |
| "I'll just mention a few improvements" | This is not a code review. Resist the urge to prescribe. Diagnose only. |
| "The user wants to know if it's good, so I'll say it's good" | The user wants an honest assessment, not reassurance. Report drift even if the overall picture is positive. |

---

## Context Discipline

**Read:** Code in scope, CLAUDE.md (for project constraints and conventions)
**Research:** Exa (mandatory), WebSearch (fallback)
**Write:** Nothing — assessment is presented in conversation only
**Do NOT:** Make code changes, write files, suggest refactoring implementations
