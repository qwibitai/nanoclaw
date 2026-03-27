---
name: paper-critique
description: >
  Read-only structured critique of existing paper sections. Produces a
  review document with rubric-based assessment and actionable feedback.
  Never modifies .tex files. Use before sharing with coauthors, when
  processing peer review comments, or to evaluate your own revisions.
---

# Paper Critique

Produce a structured review of existing paper sections. You never modify the manuscript — you produce a review document that the researcher reads and acts on.

## When to Use

When the researcher wants feedback without changes:
- "Review the introduction"
- "What's wrong with the methods section?"
- "Give me feedback on this before I send to coauthors"
- "Check if this section is ready for submission"
- "How does the argument flow across sections?"
- "Process these reviewer comments into a revision plan"

Also invoke this skill when:
- The researcher pastes peer review comments and wants a structured response plan
- A section has been revised and the researcher wants to verify improvement
- The researcher wants to compare the current draft against venue expectations

## Finding the Project

Where you find the project depends on how this channel is set up:

- **Project-linked channels** (e.g., Discord `#project-discontinuous-machines`): The project is mounted at `/workspace/project`. Check there first.
- **Main channel with additional mounts**: Projects are at `/workspace/extra/<project-name>`. List `/workspace/extra/` to see available mounts.

```bash
# Check which mount exists
ls /workspace/project/CLAUDE.md 2>/dev/null && echo "Project at /workspace/project" || ls /workspace/extra/
```

`cd` into the project directory before doing anything else.

## Before Reviewing

1. **Read the rubrics.** Load `_meta/global-writing-rubric.md` (global rules via `mcp__mcpvault__read_note`) and the project's `writing-rubric.md` (if it exists — check the project root). These are your evaluation criteria.

2. **Read the project context:**
   - Project CLAUDE.md — what the paper argues, how it's structured
   - `mcp__mcpvault__read_note` on the project's vault directory — current goals and status
   - `mcp__mcpvault__read_note` on `_meta/preferences.md` — the researcher's known standards

3. **Read the section(s) under review** and their adjacent sections. Critique requires understanding how a section fits into the whole.
   - **Split layout** (has `sections/` or `draft/sections/` directory): Each section is a `.tex` file.
   - **Split drafting layout** (`.tex` files in `draft/` without a `sections/` subdirectory): Each section is a separate `.tex` file in `draft/`.
   - **Monolithic layout** (all content in `main.tex`): All sections are in this one file.

4. **Read refs.bib** so you can evaluate citation adequacy.

## Review Structure

Produce the review as a markdown file. The file goes in the project directory alongside the section being reviewed:

```
sections/<section-name>.critique.md     # paper-only layout
draft/sections/<section-name>.critique.md  # research-project layout
draft/<section-name>.critique.md           # split drafting layout
```

For whole-paper reviews, write to:
```
paper.critique.md                       # at project root
```

### Review Document Format

```markdown
# Critique: <section name>
Date: YYYY-MM-DD
Reviewer: Shoggoth (automated)
Rubric: _meta/global-writing-rubric.md [+ project rubric if used]

## Rubric Assessment

| Criterion | Rating | Notes |
|-----------|--------|-------|
| [from rubric] | PASS / WEAK / FAIL | [brief justification] |
| ... | ... | ... |

## Argument Analysis

[2-3 paragraphs on the section's argumentative structure.
What claim does each paragraph make? Do they build logically?
Where does the argument lose the reader? What's assumed but
not stated? Is the framing consistent with the project's
CLAUDE.md?]

## Paragraph-Level Notes

### ¶1 (lines N-M): [first few words...]
- [specific, actionable feedback]

### ¶2 (lines N-M): [first few words...]
- [specific, actionable feedback]

[Continue for each paragraph that has issues.
Skip paragraphs that work well — don't pad with praise.]

## Citation Gaps

- [Claims that need citations but don't have them]
- [Citations that feel misattributed or misused]
- [Areas where the literature positioning could be stronger]

## Structural Issues

- [Problems with section ordering, missing transitions,
  redundancy across sections, scope mismatch]

## Flagged for Researcher

- [Items that require domain judgment, not writing skill]
- [Analytical choices the reviewer can't evaluate]
- [Tensions between what the data shows and what the
  argument claims]

## Summary

[2-3 sentences: the single most important thing to fix,
overall assessment of readiness, and recommended next step
(revise / ready for coauthors / ready for submission)]
```

## Review Principles

- **Be specific and locatable.** Every piece of feedback should point to a specific paragraph or passage. "The argument is unclear" is useless. "¶3 claims X but the evidence cited (smith2024) actually shows Y" is actionable.

- **Distinguish presentation from substance.** Presentation issues (unclear writing, missing transitions, poor paragraph structure) are things the revision skill can fix. Substance issues (wrong framing, missing analysis, overclaimed results) require the researcher's judgment. Label them differently.

- **Rate against the rubric, not against perfection.** The rubric defines what matters for this paper and venue. A working paper for a workshop has different standards than a journal submission. Use the project rubric to calibrate.

- **Don't suggest rewrites.** This is a critique, not a revision. Say what's wrong and why. The researcher (or the revision skill) decides how to fix it. Exception: if a single sentence is so misleading that you need to show what you mean, a brief example is fine.

- **Evaluate citation adequacy, not just correctness.** Are claims supported? Are there obvious papers missing from the conversation? Is the paper positioned against the right literature? Check the content registry for papers the author might have missed.

- **Check scope discipline.** Does the section try to do too much? Does it promise things the paper doesn't deliver? Does it introduce concepts that never come back?

## Processing Peer Review Comments

When the researcher provides actual reviewer comments (from a journal or conference), produce a different document:

```markdown
# Revision Plan: <paper name>
Source: [reviewer comments pasted/uploaded by researcher]
Date: YYYY-MM-DD

## Comment-by-Comment Response Plan

### Reviewer 1, Comment 1
> [quote or paraphrase the comment]

**Assessment:** [Is the reviewer right? Partially right? Misunderstanding?]
**Severity:** Major / Minor / Cosmetic
**Proposed response:** [What to do about it — which section to modify,
what analysis to add, how to reframe]
**Effort:** [Quick fix / Moderate revision / Substantial new work]

### Reviewer 1, Comment 2
> [...]
[...]

## Revision Priority

1. [Most important change — what fixes the biggest concern]
2. [...]
3. [...]

## New Work Required

- [Any new analyses, figures, or data collection the reviewers want]

## Rebuttal Notes

- [Points where you should push back on the reviewer]
- [Places where the reviewer misread but you should clarify anyway]
```

## What Not to Do

- Don't modify any .tex files — this is a read-only skill
- Don't produce generic praise ("nice work on the framing")
- Don't suggest complete rewrites of passages — say what's wrong, not how to fix it
- Don't evaluate things outside the manuscript (code quality, data collection)
- Don't apply standards from a different venue than what the project rubric specifies
- Don't commit to any branch — critique files are working documents, not versioned artifacts (unless the researcher asks you to commit them)
