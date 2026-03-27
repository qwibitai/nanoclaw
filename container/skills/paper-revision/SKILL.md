---
name: paper-revision
description: >
  Make targeted revisions to existing LaTeX paper sections. Operates on
  specific issues: critique feedback, reviewer comments, TODO markers,
  or explicit instructions. Preserves the researcher's voice. Produces
  surgical edits, not wholesale rewrites. Commits to agent branches.
---

# Paper Revision

Make targeted revisions to existing paper sections. You are editing the researcher's prose, not replacing it. Preserve voice, fix problems.

## When to Use

When the researcher asks to revise, improve, or fix existing text:
- "Revise section 3.2 based on the critique"
- "Address the reviewer comments in the introduction"
- "Fix the TODOs in the methods section"
- "Tighten the argument in the discussion"
- "The results section is too long — cut it down"
- "Improve the transitions between paragraphs in section 4"

If the researcher asks to write a section from scratch, use the Paper Drafting skill instead.

## Finding the Project

Where you find the project depends on how this channel is set up:

- **Project-linked channels** (e.g., Discord `#project-discontinuous-machines`): The project is mounted at `/workspace/project`. Check there first.
- **Main channel with additional mounts**: Projects are at `/workspace/extra/<project-name>`. List `/workspace/extra/` to see available mounts.

```bash
# Check which mount exists
ls /workspace/project/CLAUDE.md 2>/dev/null && echo "Project at /workspace/project" || ls /workspace/extra/
```

`cd` into the project directory before doing anything else.

## Before Revising

1. **Read the revision source.** What's driving this revision?
   - A `.critique.md` file from the Paper Critique skill
   - A `.review.md` file from a previous drafting self-review
   - Reviewer comments (pasted by researcher or in a revision plan)
   - Explicit instructions from the researcher
   - TODO/FIXME markers in the .tex file

   If no explicit revision source exists, ask the researcher what they want improved. Don't revise speculatively.

2. **Read the section as it currently exists.** Read it closely. Understand the argument, the voice, the rhythm. Your job is to improve this text, not replace it.
   - **Split layout** (has `sections/` or `draft/sections/` directory): Each section is a `.tex` file.
   - **Split drafting layout** (`.tex` files in `draft/` without a `sections/` subdirectory): Each section is a separate `.tex` file in `draft/`.
   - **Monolithic layout** (all content in `main.tex`): All sections are in this one file — edit the relevant `\section{}` directly.

3. **Read adjacent sections.** Revisions must maintain flow with what comes before and after.

4. **Read the project rubrics** (`_meta/global-writing-rubric.md` via `mcp__mcpvault__read_note` and the project's `writing-rubric.md` if it exists in the project root) to understand the evaluation criteria. The critique file's rubric assessment tells you which criteria failed.

5. **Read refs.bib** if the revision involves citations.

## Revision Principles

### Preserve voice
The researcher wrote this text. It reflects their thinking, their hedging decisions, their rhetorical choices. You are making the text better at being what the researcher intended, not transforming it into what you would have written.

Read the existing prose carefully. Match:
- Sentence length patterns (short and punchy? long and qualified?)
- Hedging register (does the researcher hedge here or assert?)
- Person and tense ("we show" vs. "this paper demonstrates")
- Paragraph density (tight paragraphs or expansive ones?)

### Be surgical
Every edit should have a clear reason traceable to the revision source. Don't improve things that aren't flagged. The researcher didn't ask for a general polish — they asked for specific fixes.

### One logical change per commit
If the critique flags three issues, each fix gets its own commit. This lets the researcher review and accept/reject each change independently. Commit messages should reference the issue being fixed.

### Minimize blast radius
Prefer editing a sentence to rewriting a paragraph. Prefer rewriting a paragraph to rewriting a section. The smallest edit that fixes the problem is the best edit.

### Pure LaTeX only
All output must be `.tex` files with LaTeX syntax. Never use markdown headings (`#`, `##`), markdown links, markdown bold/italic, or markdown anchors. Use `\section{}`, `\subsection{}`, `\textbf{}`, `\textit{}`, `\label{}`, `\ref{}` etc. If existing draft files use markdown syntax, convert them to LaTeX when you touch them.

## Revision Operations

These are the types of edits you should make, in order of preference:

### 1. Sentence-level fixes
- Replace a vague claim with a specific one
- Add a citation to an unsupported claim
- Fix a broken transition sentence
- Tighten wordy phrasing
- Correct a factual error

### 2. Paragraph-level restructuring
- Reorder sentences so the topic sentence leads
- Split a paragraph that makes two points
- Merge short paragraphs that fragment one point
- Add a missing transition between paragraphs

### 3. Section-level reorganization
Only when explicitly requested or when the critique identifies structural problems. This is the most invasive operation and should be discussed with the researcher first if the critique didn't already flag it.

### 4. Content addition
When the critique or reviewer asks for something missing:
- A missing definition
- A missing literature connection
- A missing methodological justification
- A missing limitation acknowledgment

Mark added content clearly in the commit message so the researcher can find it.

### 5. Content removal
When asked to cut or tighten:
- Remove redundant sentences (keep the stronger version)
- Cut tangential paragraphs (move to a `cut-content.tex` file rather than deleting — the researcher may want it back)
- Reduce over-hedging

## Working with Critique Files

When a `.critique.md` file exists for the section:

1. Read the rubric assessment table. Focus on WEAK and FAIL items.
2. Read the paragraph-level notes. Each note is a specific issue at a specific location.
3. Read the "Flagged for Researcher" section. **Do not attempt to fix flagged items** unless the researcher explicitly overrides this.
4. Work through issues in document order (top to bottom).
5. After completing revisions, update the critique file: add a "Revision Status" section at the bottom noting which items were addressed and which remain.

## Working with Reviewer Comments

When a revision plan (from the Paper Critique skill's peer review mode) exists:

1. Work through the plan's comment-by-comment responses.
2. Only address comments marked with a clear "Proposed response" — skip items marked as "needs researcher judgment" or "push back."
3. For each comment addressed, add a `% REVISION: Addresses R1.C2` LaTeX comment near the change so the researcher can trace revisions to reviewer comments.
4. Track which comments you've addressed in the commit messages.

## Working with TODO/FIXME Markers

Scan for these patterns in the .tex file:
```
% TODO: [description]
% FIXME: [description]
% CITE: [description]
\todo{description}          % if using todonotes package
```

Address each marker. Remove the marker when the issue is resolved. If a TODO requires the researcher's judgment, leave it and note it in your report.

## Git Workflow

1. Pull the latest:
   ```
   git pull origin main
   ```

2. Create an agent branch (or continue on an existing agent branch if revising a recent draft):
   ```
   git checkout -b agent/revise-<section>-$(date +%Y%m%d)
   ```

3. Make one logical change at a time. Commit each separately:
   ```
   git add sections/<file>.tex
   git commit -m "revise: <section> — <what was fixed and why>"
   ```

   Good commit messages for revisions:
   - `revise: intro — add missing citations for platform governance claims`
   - `revise: methods — split data collection paragraph, add sample size`
   - `revise: results — address R2.C3, clarify effect size interpretation`
   - `revise: discussion — tighten opening, remove redundant paragraph`

4. If a critique file exists, commit the updated critique with revision status:
   ```
   git add sections/<file>.critique.md
   git commit -m "revise: update critique status for <section>"
   ```

5. **Never merge to main.** Push for researcher review:
   ```
   git push -u origin agent/<branch-name>
   ```

## After Revising

Report to the researcher:
- Which issues you addressed (reference critique items or reviewer comments by ID)
- What changed in each commit (so the researcher can review granularly)
- Which issues you left untouched and why (flagged items, items requiring judgment)
- Any new `[CITE:]` placeholders introduced
- If content was cut: note where the cut material was saved
- The branch name: `agent/<name>`

## What Not to Do

- Don't revise without a clear revision source (critique, reviewer comments, explicit instructions, or TODO markers)
- Don't rewrite sections wholesale — make targeted edits
- Don't change the researcher's voice or rhetorical register
- Don't fix things that weren't flagged — resist the urge to improve adjacent prose
- Don't address items flagged for the researcher's judgment
- Don't delete content permanently — move cut material to a separate file
- Don't combine multiple logical changes in one commit
- Don't invent citations or guess at BibTeX keys
- Don't merge to main
- Don't use markdown syntax — all output must be pure LaTeX
- Don't create `.md` files for paper content — use `.tex` exclusively
