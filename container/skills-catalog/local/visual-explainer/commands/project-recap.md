---
description: Generate a visual HTML project recap — rebuild mental model of a project's current state, recent decisions, and cognitive debt hotspots
---
Load the visual-explainer skill, then generate a comprehensive visual project recap as a self-contained HTML page.

Follow the visual-explainer skill workflow. Read the reference template, CSS patterns, and mermaid theming references before generating. Use a warm editorial or paper/ink aesthetic with muted blues and greens, but vary fonts and palette from previous diagrams.

**Time window** — determine the recency window from `$1`:
- Shorthand like `2w`, `30d`, `3m`: parse to git's `--since` format (`2w` → `"2 weeks ago"`, `30d` → `"30 days ago"`, `3m` → `"3 months ago"`)
- If `$1` doesn't match a time pattern, treat it as free-form context and use the default window
- No argument: default to `2w` (2 weeks)

**Data gathering phase** — run these first to understand the project:

1. **Project identity.** Read `README.md`, `CHANGELOG.md`, `package.json` / `Cargo.toml` / `pyproject.toml` / `go.mod` for name, description, version, dependencies. Read the top-level file structure.

2. **Recent activity.** `git log --oneline --since=<window>` for commit history. `git log --stat --since=<window>` for file-level change scope. `git shortlog -sn --since=<window>` for contributor activity. Identify which areas of the codebase were most active.

3. **Current state.** Check for uncommitted changes (`git status`). Check for stale branches (`git branch --no-merged`). Look for TODO/FIXME comments in recently changed files. Read progress docs if they exist (`~/.agent/memory/{project}/progress.md`, `~/.pi/agent/memory/{project}/progress.md`, `.pi/todos/`, or similar).

4. **Decision context.** Read recent commit messages for rationale. If running in the same session as recent work, mine the conversation history. Read any plan docs, RFCs, or ADRs in the project directory.

5. **Architecture scan.** Read key source files to understand the module structure and dependencies. Focus on entry points, public API surface, and the files most frequently changed in the time window.

**Verification checkpoint** — before generating HTML, produce a structured fact sheet of every claim you will present in the recap:
- Every quantitative figure: commit counts, file counts, line counts, branch counts
- Every module, function, and type name you will reference
- Every behavior and architecture description
- For each, cite the source: the git command output that produced it, or the file:line where you read it
Verify each claim against the code. If something cannot be verified, mark it as uncertain rather than stating it as fact. This fact sheet is your source of truth during HTML generation — do not deviate from it.

**Optional hero image** — if `surf` CLI is available (`which surf`), generate a hero banner via `surf gemini --generate-image --aspect-ratio 16:9` that visually captures the project's identity or domain. Match the style to the page's palette. Embed as base64 data URI using the `.hero-img-wrap` pattern from css-patterns.md. Place above or just below the title. Skip if surf isn't available — the page should stand on its own.

**Diagram structure** — the page should include:
1. **Project identity** — not the README blurb. A *current-state* summary: what this project does, who uses it, what stage it's at (early dev, stable, actively shipping features). Include version, key dependencies, and the one-sentence "elevator pitch" for someone who forgot what they were building.
2. **Architecture snapshot** — Mermaid diagram of the system as it exists today. Focus on the conceptual modules and their relationships, not every file. Label nodes with what they do, not just file names. Wrap in `.mermaid-wrap` with zoom controls (+/−/reset/expand buttons), Ctrl/Cmd+scroll zoom, click-and-drag panning, and click-to-expand (opens diagram full-size in new tab). See css-patterns.md "Mermaid Zoom Controls" for the full pattern including the `openMermaidInNewTab()` function. *Visual treatment: this is the visual anchor — use hero depth (elevated container, larger padding, subtle accent-tinted background). The rest of the page hangs off this diagram.*
3. **Recent activity** — not raw git log. A human-readable narrative grouped by theme: feature work, bug fixes, refactors, infrastructure. Timeline visualization with the most significant changes called out. For each theme, a one-sentence summary of what happened and why it mattered.
4. **Decision log** — key design decisions from the time window. Extracted from commit messages, conversation history, plan docs, progress docs. Each entry: what was decided, why, what was considered. This is the highest-value section for fighting cognitive debt — the reasoning that evaporates first.
5. **State of things** — *visual treatment: use the KPI card pattern from css-patterns.md — large hero numbers for working/broken/blocked/in-progress counts, with color-coded trend indicators.* A dashboard of:
   - What's working (stable, shipped, tested)
   - What's in progress (uncommitted work, open branches, active TODOs)
   - What's broken or degraded (known bugs, failing tests, tech debt items)
   - What's blocked (waiting on external input, dependencies, decisions)
6. **Mental model essentials** — the 5-10 things you need to hold in your head to work on this project effectively:
   - Key invariants and contracts (what must always be true)
   - Non-obvious coupling (things connected in ways you wouldn't guess from the file tree)
   - Gotchas (common mistakes, easy-to-forget requirements, things that break silently)
   - Naming conventions or patterns the codebase follows
7. **Cognitive debt hotspots** — *visual treatment: use amber-tinted cards with severity indicators (colored left border: red for high, amber for medium, blue for low).* Areas where understanding is weakest:
   - Code that changed recently but has no documented rationale
   - Complex modules with no tests
   - Areas where multiple people (or agents) made overlapping changes
   - Files that are frequently modified but poorly understood
   - Flag each with a severity and a concrete suggestion (e.g., "add a doc comment to `buildCoordinationInstructions` explaining the 4 coordination levels — this function is called from 3 places and the behavior is non-obvious")
8. **Next steps** — inferred from recent activity, open TODOs, project trajectory. Not prescriptive — just "here's where the momentum was pointing when you left." Include any explicit next-step notes from progress docs or plan files.

Include responsive section navigation. Use a warm, approachable visual language: muted blues and greens for architecture, amber callouts for cognitive debt hotspots, green/blue/amber/red for state-of-things status. Overflow prevention on any side-by-side or grid-based sections: apply `min-width: 0` on all grid/flex children and `overflow-wrap: break-word`. Never use `display: flex` on `<li>` for marker characters — use absolute positioning instead (see css-patterns.md Overflow Protection). Write to `~/.agent/diagrams/` and open in browser.

Ultrathink.

$@
