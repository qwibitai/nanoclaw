---
description: Generate a visual HTML diff review — before/after architecture comparison with code review analysis
---
Load the visual-explainer skill, then generate a comprehensive visual diff review as a self-contained HTML page.

Follow the visual-explainer skill workflow. Read the reference template, CSS patterns, and mermaid theming references before generating. Use a GitHub-diff-inspired aesthetic with red/green before/after panels, but vary fonts and palette from previous diagrams.

**Scope detection** — determine what to diff based on `$1`:
- Branch name (e.g. `main`, `develop`): working tree vs that branch
- Commit hash: that specific commit's diff (`git show <hash>`)
- `HEAD`: uncommitted changes only (`git diff` and `git diff --staged`)
- PR number (e.g. `#42`): `gh pr diff 42`
- Range (e.g. `abc123..def456`): diff between two commits
- No argument: default to `main`

**Data gathering phase** — run these first to understand the full scope:
- `git diff --stat <ref>` for file-level overview
- `git diff --name-status <ref> --` for new/modified/deleted files (separate src from tests)
- Line counts: compare key files between `<ref>` and working tree (`git show <ref>:file | wc -l` vs `wc -l`)
- New public API surface: grep added lines for exported symbols, public functions, classes, interfaces (adapt the pattern to the project's language — `export`/`function`/`class`/`interface` for TS/JS, `def`/`class` for Python, `func`/`type` for Go, etc.)
- Feature inventory: grep for new actions, keybindings, config fields, event types on both sides
- Read all changed files in full — include surrounding code paths needed to validate behavior
- Check whether `CHANGELOG.md` has an entry for these changes
- Check whether `README.md` or `docs/*.md` need updates given any new or changed features
- Reconstruct decision rationale: if this work was done in the current session, mine the conversation for approaches discussed, alternatives rejected, and trade-offs made. Check for progress docs (`~/.agent/memory/{project}/progress.md`, `~/.pi/agent/memory/{project}/progress.md`) or plan files that may contain reasoning. For committed changes, read commit messages and PR descriptions.

**Verification checkpoint** — before generating HTML, produce a structured fact sheet of every claim you will present in the review:
- Every quantitative figure: line counts, file counts, function counts, test counts
- Every function, type, and module name you will reference
- Every behavior description: what code does, what changed, before vs. after
- For each, cite the source: the git command output that produced it, or the file:line where you read it
Verify each claim against the code. If something cannot be verified, mark it as uncertain rather than stating it as fact. This fact sheet is your source of truth during HTML generation — do not deviate from it.

**Diagram structure** — the page should include:
1. **Executive summary** — not just a dry before/after. Lead with the *intuition*: why do these changes exist? What problem were they solving, what was the core insight? Then the factual scope (X files, Y lines, Z new modules). Aim for "aha moment" clarity — a reader who only sees this section should understand the essence of the change. *Visual treatment: this is the visual anchor — use hero depth (larger type 20-24px, subtle accent-tinted background, more padding than other sections).*
2. **KPI dashboard** — lines added/removed, files changed, new modules, test counts. Include a **housekeeping** indicator: whether CHANGELOG.md was updated (green/red badge) and whether docs need changes (green/yellow/red).
3. **Module architecture** — how the file structure changed, with a Mermaid dependency graph of the current state. Wrap in `.mermaid-wrap` with zoom controls (+/−/reset/expand buttons), Ctrl/Cmd+scroll zoom, click-and-drag panning, and click-to-expand (opens diagram full-size in new tab). See css-patterns.md "Mermaid Zoom Controls" for the full pattern including the `openMermaidInNewTab()` function.
4. **Major feature comparisons** — side-by-side before/after panels for each significant area of change (UI, data flow, API surface, config, etc.). Overflow prevention: apply `min-width: 0` on all grid/flex children and `overflow-wrap: break-word` on panels. Never use `display: flex` on `<li>` for marker characters — use absolute positioning instead (see css-patterns.md Overflow Protection).
5. **Flow diagrams** — Mermaid flowchart, sequence, or state diagrams for any new lifecycle/pipeline/interaction patterns. Same zoom controls and click-to-expand as section 3.
6. **File map** — full tree with color-coded new/modified/deleted indicators. *Visual treatment: compact — consider `<details>` collapsed by default for pages with many sections.*
7. **Test coverage** — before/after test file counts and what's covered
8. **Code review** — structured Good/Bad/Ugly analysis of the changes:
   - **Good**: Solid choices, improvements, clean patterns worth calling out
   - **Bad**: Concrete issues — bugs, regressions, missing error handling, logic errors
   - **Ugly**: Subtle problems — tech debt introduced, maintainability concerns, things that work now but will bite later
   - **Questions**: Anything unclear or that needs the author's clarification
   - Use styled cards with green/red/amber/blue left-border accents matching the diff color language. Each item should reference specific files and line ranges. If nothing to flag in a category, say "None found" rather than omitting the section.
9. **Decision log** — for each significant design choice in the diff, a styled card with:
   - **Decision**: one-line summary of what was decided (e.g., "Promise-based deferred resolution instead of event emitters for cleanup signaling")
   - **Rationale**: why this approach — constraints, trade-offs, what it enables. Pull from conversation context if available, infer from code structure if not.
   - **Alternatives considered**: what was rejected and why, if recoverable
   - **Confidence**: whether this rationale was explicitly discussed (high — sourced from conversation/docs) or inferred from the code (medium — flagged as inference). Low confidence means the rationale couldn't be recovered at all.
   - Visual treatment by confidence level — use left-border accent colors consistent with the diff color language: **High** (sourced from conversation/docs): green left border. **Medium** (inferred from code): blue left border, labeled "inferred." **Low** (not recoverable): amber left border, "rationale not recoverable — document before committing" warning. Low-confidence cards are cognitive debt hotspots — tell the user to document the reasoning before committing.
10. **Re-entry context** — a concise "note from present-you to future-you" covering the following. *Visual treatment: compact — consider `<details>` collapsed by default for pages with many sections.*
   - **Key invariants**: assumptions the changed code relies on that aren't enforced by types or tests (e.g., "cleanup must be called before session switch or artifacts leak")
   - **Non-obvious coupling**: files or behaviors that are connected in ways that aren't visible from imports alone (e.g., "the feed renderer reads events written by the overlay — changing the event schema requires updating both")
   - **Gotchas**: things that would surprise someone modifying this code in two weeks. Edge cases, ordering dependencies, implicit contracts.
   - **Don't forget**: if the changes require follow-up work (migration, config update, docs), list it here.

**Visual hierarchy**: Sections 1-3 should dominate the viewport on load (hero depth, larger type, more padding). Sections 6+ are reference material and should feel lighter (flat or recessed depth, compact layout, collapsible where appropriate).

**Optional illustrations** — if `surf` CLI is available (`which surf`), consider generating a hero banner or conceptual illustration via `surf gemini --generate-image` when it would enhance the page. Embed as base64 data URI. See css-patterns.md "Generated Images" for container styles. Skip if surf isn't available or the diff is purely structural.

Include responsive section navigation. Use diff-style visual language throughout: red for removed/before, green for added/after, yellow for modified, blue for neutral context. Write to `~/.agent/diagrams/` and open in browser.

Ultrathink.

$@
