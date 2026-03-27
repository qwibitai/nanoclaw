---
name: paper-drafting
description: >
  Draft new LaTeX paper sections from scratch. Reads project context,
  vault notes, and .bib citations. Includes a rubric-based self-review
  pass before committing. Commits to agent branches only.
  Triggered by explicit drafting requests like "draft the introduction."
---

# Paper Drafting

Draft new sections of a research paper in LaTeX. The researcher reviews and merges all agent work — you never touch `main`.

For revising existing sections, use the Paper Revision skill instead.
For critique without modification, use the Paper Critique skill instead.

## When to Use

When the researcher asks to draft or extend a section that doesn't yet exist or needs to be written from scratch:
- "Draft the introduction for [project]"
- "Write up the results from [analysis]"
- "Extend the methods to cover [new approach]"
- "Add a new subsection on [topic]"

If the researcher says "revise," "improve," "fix," or "address reviewer comments" about an existing section, use the Paper Revision skill.

## Finding the Project

Where you find the project depends on how this channel is set up:

- **Project-linked channels** (e.g., Discord `#project-discontinuous-machines`): The project is mounted at `/workspace/project`. Check there first.
- **Main channel with additional mounts**: Projects are at `/workspace/extra/<project-name>`. List `/workspace/extra/` to see available mounts.

```bash
# Check which mount exists
ls /workspace/project/CLAUDE.md 2>/dev/null && echo "Project at /workspace/project" || ls /workspace/extra/
```

`cd` into the project directory before doing anything else.

## Before Writing

Do all of this before writing a single line of LaTeX.

1. **Read the project's CLAUDE.md** in the project root. This tells you the project structure, conventions, and analytical goals.

2. **Read the vault context** for this project:
   - `mcp__mcpvault__read_note` on `_meta/researcher-profile.md` — who the researcher is
   - `mcp__mcpvault__read_note` on `_meta/preferences.md` — writing style preferences
   - `mcp__mcpvault__read_note` on the project's vault directory — current status and goals

3. **Read existing manuscript sections** to match style, voice, and argument flow. Never write in isolation — your draft must connect to what comes before and after.
   - **Split layout** (has `sections/` or `draft/sections/` directory): Read at minimum the sections immediately adjacent to what you're drafting. Each section is a `.tex` file.
   - **Split drafting layout** (`.tex` files in `draft/` without a `sections/` subdirectory): Each section is a separate `.tex` file in `draft/`. Read adjacent sections for context.
   - **Monolithic layout** (all content in `main.tex`): Read `main.tex` for full manuscript context. All sections are in this one file — edit the relevant `\section{}` directly.

4. **Read refs.bib** to know which citation keys are available. The .bib file is at the project root for paper-only projects, or at `draft/refs.bib` for research-project layouts.

5. **Search for relevant literature** to strengthen citations:
   - Use `search_registry` (content registry MCP) for semantic search over indexed papers
   - If a paper from the registry is important and not in refs.bib, add it to Zotero
   - Use `[CITE: author year description]` as placeholder — the real BibTeX key won't exist until Better BibTeX assigns it on the researcher's Mac

6. **Read the rubrics.** Load both `_meta/global-writing-rubric.md` (global rules via `mcp__mcpvault__read_note`) and the project's `writing-rubric.md` if one exists (check the project root). These define what you'll evaluate your draft against in the self-review pass.

## Writing Rules

- **Ugly first drafts.** Capture the analytical argument clearly and correctly. Do not polish prose. Do not optimize for elegance. The researcher revises in Emacs.

- **Real citations only.** Never invent citation keys. Every `\cite{}` must reference a key in refs.bib. Use `[CITE: author year description]` for anything else.

- **Match the voice.** Read the existing sections. Match their register, formality, and conventions. If the paper uses "we", use "we". If it uses passive voice, use passive voice.

- **Structural clarity.** Use clear topic sentences. Each paragraph should make one point. Connect paragraphs with explicit transitions.

- **Be specific.** Replace "the literature suggests" with `\citet{smith2024} find that...` Replace "recent work" with specific citations. Replace "significant" with effect sizes or concrete descriptions.

- **Pure LaTeX only.** All draft files must be `.tex` files with LaTeX syntax. Never use markdown headings (`#`, `##`), markdown links (`[text](url)`), markdown bold/italic (`**bold**`, `*italic*`), or markdown anchors (`{#label}`). Use `\section{}`, `\subsection{}`, `\textbf{}`, `\textit{}`, `\label{}`, `\ref{}` etc. If existing draft files use markdown syntax, convert them to LaTeX when you touch them.

- **LaTeX conventions.** Write in the project's LaTeX style. For split-section projects, use `\input{}` for sections. For monolithic projects, edit within the existing file structure. Use the project's citation command style (`\cite`, `\citet`, `\citep` — check existing files).

- **No preamble or wrappers.** Don't add `\begin{document}`, package imports, or section numbering unless the existing files use them. Write content that drops into the existing structure.

## Self-Review Pass

After completing the first draft, perform exactly one review-then-revise cycle before committing. This catches structural and argumentative issues while the context is fresh.

### Step 1: Review against rubrics

Evaluate your draft against both the global rubric (`_meta/global-writing-rubric.md`) and the project rubric (if it exists). For each rubric criterion, produce a brief assessment:

- **PASS** — criterion is met
- **FIXABLE** — criterion is not met, but you can fix it now
- **FLAG** — criterion is not met, and fixing it requires the researcher's judgment

Focus on the criteria relevant to the section type you drafted. An introduction has different requirements than a methods section. The rubric files specify which criteria apply to which section types.

### Step 2: Revise FIXABLE items

Address every item marked FIXABLE. Typical fixes:
- Adding missing citations for unsupported claims
- Strengthening vague topic sentences
- Adding transitions between paragraphs that don't connect
- Replacing hedging language with specific claims
- Ensuring the section opens and closes with clear connections to adjacent sections

Do NOT attempt to fix FLAG items — those are for the researcher.

### Step 3: Save review notes

Write the review output to a file alongside the draft:
```
sections/<section-name>.review.md     # paper-only layout
draft/sections/<section-name>.review.md  # research-project layout
draft/<section-name>.review.md           # split drafting layout
```

The review file should contain:
- The rubric criteria checked
- PASS/FIXABLE/FLAG for each
- What you changed in the revision (for FIXABLE items)
- What needs the researcher's attention (for FLAG items)
- Any uncertainties about the argument or framing

Commit the review file alongside the draft.

## Git Workflow

1. Pull the latest from origin:
   ```
   git pull origin main
   ```

2. Create an agent branch:
   ```
   git checkout -b agent/<description>-$(date +%Y%m%d)
   ```

3. Write the first draft and commit it:
   ```
   git add sections/<file>.tex
   git commit -m "draft: <section> — first pass"
   ```

4. Run the self-review pass. Commit the revision and review notes together:
   ```
   git add sections/<file>.tex sections/<file>.review.md
   git commit -m "draft: <section> — self-review pass"
   ```

5. **Never merge to main.** Push the branch to origin so the researcher can review:
   ```
   git push -u origin agent/<branch-name>
   ```

Committing the first draft separately from the review pass lets the researcher diff between them to see what the review changed — useful for calibrating trust in the self-review.

## After Writing

Report to the researcher:
- What you drafted and the core argument
- Summary of the self-review: how many criteria passed, what you fixed, what's flagged
- Which citations you used — especially any `[CITE:]` placeholders
- What needs the researcher's judgment (FLAG items from review)
- The branch name: `agent/<name>`

## Citation Resolution Flow

When you find a paper in the content registry that should be cited:

1. Check refs.bib for the paper's DOI or a recognizable citation key
2. If found in refs.bib → use `\cite{key}` directly
3. If not in refs.bib:
   a. Add to Zotero if possible
   b. Write `[CITE: author year description]` as placeholder in the LaTeX
   c. Note the placeholder in your report

## What Not to Do

- Don't write without reading context first — every draft must be grounded
- Don't invent citations or guess at BibTeX keys
- Don't merge to main or delete branches
- Don't rewrite sections the researcher didn't ask you to touch
- Don't add LaTeX preamble, package imports, or `\begin{document}` wrappers
- Don't use markdown syntax — all output must be pure LaTeX
- Don't create `.md` files for paper content — use `.tex` exclusively
- Don't pad prose with vague academic hedging
- Don't run more than one self-review iteration — diminishing returns, and the researcher will revise anyway
- Don't attempt to fix FLAG items from the self-review — those require human judgment
