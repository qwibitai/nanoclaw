---
name: paper-drafting
description: >
  Draft, revise, or extend LaTeX paper sections. Reads project context,
  vault notes, and .bib citations. Commits to agent branches only.
  Triggered by explicit drafting requests.
---

# Paper Drafting

Draft or revise sections of a research paper in LaTeX. The researcher reviews and merges all agent work — you never touch `main`.

## When to Use

When the researcher asks to draft, revise, or extend a section:
- "Draft the introduction for [project]"
- "Rewrite section 3.2"
- "Extend the methods to cover [new approach]"
- "Write up the results from [analysis]"

## Before Writing

Do all of this before writing a single line of LaTeX.

1. **Read the project's CLAUDE.md** in the project root. This tells you the project structure, conventions, and analytical goals.

2. **Read the vault context** for this project:
   - `mcp__mcpvault__read_note` on `_meta/researcher-profile.md` — who the researcher is
   - `mcp__mcpvault__read_note` on `_meta/preferences.md` — writing style preferences
   - `mcp__mcpvault__read_note` on the project's `PROJECT.md` in `projects/<name>/` — current status and goals

3. **Read existing manuscript sections** to match style, voice, and argument flow. Never write in isolation — your draft must connect to what comes before and after. Read at minimum the sections immediately adjacent to what you're drafting.

4. **Read refs.bib** to know which citation keys are available. The .bib file is at the project root for paper-only projects, or at `draft/refs.bib` for research-project layouts.

5. **Search for relevant literature** to strengthen citations:
   - Use `search_registry` (content registry MCP) for semantic search over indexed papers
   - If a paper from the registry is important and not in refs.bib, add it to Zotero:
     `zotero-cli add --title "..." --authors "..." --doi "..." --collection "To Read" --note "Needed for [project] [section]"`
   - Use `[CITE: author year description]` as placeholder — the real BibTeX key won't exist until Better BibTeX assigns it on the researcher's Mac

## Writing Rules

- **Ugly first drafts.** Capture the analytical argument clearly and correctly. Do not polish prose. Do not optimize for elegance. The researcher revises in Emacs.

- **Real citations only.** Never invent citation keys. Every `\cite{}` must reference a key in refs.bib. Use `[CITE: author year description]` for anything else.

- **Match the voice.** Read the existing sections. Match their register, formality, and conventions. If the paper uses "we", use "we". If it uses passive voice, use passive voice.

- **Structural clarity.** Use clear topic sentences. Each paragraph should make one point. Connect paragraphs with explicit transitions.

- **Be specific.** Replace "the literature suggests" with `\citet{smith2024} find that...` Replace "recent work" with specific citations. Replace "significant" with effect sizes or concrete descriptions.

- **LaTeX conventions.** Write in the project's LaTeX style. Use `\input{}` for sections. Use the project's citation command style (`\cite`, `\citet`, `\citep` — check existing files).

- **No preamble or wrappers.** Don't add `\begin{document}`, package imports, or section numbering unless the existing files use them. Write content that drops into the existing structure.

## Git Workflow

1. Pull the latest from origin:
   ```
   git pull origin main
   ```

2. Create an agent branch:
   ```
   git checkout -b agent/<description>-$(date +%Y%m%d)
   ```

3. Make changes to .tex files.

4. Commit with a descriptive message:
   ```
   git add draft/sections/<file>.tex   # research-project layout
   git add sections/<file>.tex          # paper-only layout
   git commit -m "draft: <what was written and why>"
   ```

5. **Never merge to main.** Push the branch to origin so the researcher can review:
   ```
   git push -u origin agent/<branch-name>
   ```

6. If multiple sections or rounds of revision, make separate commits for each logical change.

## After Writing

Report to the researcher:
- What you drafted/revised and why
- Which citations you used — especially any `[CITE:]` placeholders that need resolution
- What you're unsure about or what needs the researcher's judgment
- The branch name: `agent/<name>`

## Citation Resolution Flow

When you find a paper in the content registry that should be cited:

1. Check refs.bib for the paper's DOI or a recognizable citation key
2. If found in refs.bib → use `\cite{key}` directly
3. If not in refs.bib:
   a. Add to Zotero via `zotero-cli add --doi "..." --collection "To Read"`
   b. Write `[CITE: author year description]` as placeholder in the LaTeX
   c. Note the placeholder in your report so the researcher can resolve it after Better BibTeX syncs

## What not to do

- Don't write without reading context first — every draft must be grounded
- Don't invent citations or guess at BibTeX keys
- Don't merge to main or delete branches
- Don't rewrite sections the researcher didn't ask you to touch
- Don't add LaTeX preamble, package imports, or `\begin{document}` wrappers
- Don't pad prose with vague academic hedging
