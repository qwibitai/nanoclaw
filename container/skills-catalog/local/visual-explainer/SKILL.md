---
name: visual-explainer
description: Generate beautiful, self-contained HTML pages that visually explain systems, code changes, plans, and data. Use when the user asks for a diagram, architecture overview, diff review, plan review, project recap, comparison table, or any visual explanation of technical concepts. Also use proactively when you are about to render a complex ASCII table (4+ rows or 3+ columns) — present it as a styled HTML page instead.
license: MIT
compatibility: Requires a browser to view generated HTML files. Optional surf-cli for AI image generation.
metadata:
  author: nicobailon
  version: "0.5.1"
---

# Visual Explainer

Generate self-contained HTML files for technical diagrams, visualizations, and data tables. Always open the result in the browser. Never fall back to ASCII art when this skill is loaded.

**Proactive table rendering.** When you're about to present tabular data as an ASCII box-drawing table in the terminal (comparisons, audits, feature matrices, status reports, any structured rows/columns), generate an HTML page instead. The threshold: if the table has 4+ rows or 3+ columns, it belongs in the browser. Don't wait for the user to ask — render it as HTML automatically and tell them the file path. You can still include a brief text summary in the chat, but the table itself should be the HTML page.

## Available Commands

Detailed prompt templates in `./commands/`. In Pi, these are slash commands (`/diff-review`). In Claude Code, namespaced (`/visual-explainer:diff-review`). In Codex, use `/prompts:diff-review` (if installed to `~/.codex/prompts/`) or invoke `$visual-explainer` and describe the workflow.

| Command | What it does |
|---------|-------------|
| `generate-web-diagram` | Generate an HTML diagram for any topic |
| `generate-visual-plan` | Generate a visual implementation plan for a feature |
| `generate-slides` | Generate a magazine-quality slide deck |
| `diff-review` | Visual diff review with architecture comparison and code review |
| `plan-review` | Compare a plan against the codebase with risk assessment |
| `project-recap` | Mental model snapshot for context-switching back to a project |
| `fact-check` | Verify accuracy of a document against actual code |
| `share` | Deploy an HTML page to Vercel and get a live URL |

## Workflow

### 1. Think (5 seconds, not 5 minutes)

Before writing HTML, commit to a direction. Don't default to "dark theme with blue accents" every time.

**Visual is always default.** Even essays, blog posts, and articles get visual treatment — extract structure into cards, diagrams, grids, tables.

Prose patterns (lead paragraphs, pull quotes, callout boxes) are **accent elements** within visual pages, not a separate mode. Use them to highlight key points or provide breathing room, but the page structure remains visual.

For prose accents, see "Prose Page Elements" in `./references/css-patterns.md`. For everything else, use the standard freeform approach with aesthetic directions below.

**Who is looking?** A developer understanding a system? A PM seeing the big picture? A team reviewing a proposal? This shapes information density and visual complexity.

**What type of content?** Architecture, flowchart, sequence, data flow, schema/ER, state machine, mind map, class diagram, C4 architecture, data table, timeline, dashboard, or prose-first page. Each has distinct layout needs and rendering approaches (see Diagram Types below).

**What aesthetic?** Pick one and commit. The constrained aesthetics (Blueprint, Editorial, Paper/ink) are safer — they have specific requirements that prevent generic output. The flexible ones (IDE-inspired) require more discipline.

**Constrained aesthetics (prefer these):**
- Blueprint (technical drawing feel, subtle grid background, deep slate/blue palette, monospace labels, precise borders) — see `websocket-implementation-plan.html` for reference
- Editorial (serif headlines like Instrument Serif or Crimson Pro, generous whitespace, muted earth tones or deep navy + gold)
- Paper/ink (warm cream `#faf7f5` background, terracotta/sage accents, informal feel)
- Monochrome terminal (green/amber on near-black, monospace everything, CRT glow optional)

**Flexible aesthetics (use with caution):**
- IDE-inspired (borrow a real, named color scheme: Dracula, Nord, Catppuccin Mocha/Latte, Solarized Dark/Light, Gruvbox, One Dark, Rosé Pine) — commit to the actual palette, don't approximate
- Data-dense (small type, tight spacing, maximum information, muted colors)

**Explicitly forbidden:**
- Neon dashboard (cyan + magenta + purple on dark) — always produces AI slop
- Gradient mesh (pink/purple/cyan blobs) — too generic
- Any combination of Inter font + violet/indigo accents + gradient text

Vary the choice each time. If the last diagram was dark and technical, make the next one light and editorial. The swap test: if you replaced your styling with a generic dark theme and nobody would notice the difference, you haven't designed anything.

### 2. Structure

**Read the reference material** before generating. Don't memorize it — read it each time to absorb the patterns.
- For text-heavy architecture overviews (card content matters more than topology): read `./templates/architecture.html`
- For flowcharts, sequence diagrams, ER, state machines, mind maps, class diagrams, C4: read `./templates/mermaid-flowchart.html`
- For data tables, comparisons, audits, feature matrices: read `./templates/data-table.html`
- For slide deck presentations (when `--slides` flag is present or `/generate-slides` is invoked): read `./templates/slide-deck.html` and `./references/slide-patterns.md`
- For prose-heavy publishable pages (READMEs, articles, blog posts, essays): read the "Prose Page Elements" section in `./references/css-patterns.md` and "Typography by Content Voice" in `./references/libraries.md`

**For CSS/layout patterns and SVG connectors**, read `./references/css-patterns.md`.

**For pages with 4+ sections** (reviews, recaps, dashboards), also read `./references/responsive-nav.md` for section navigation with sticky sidebar TOC on desktop and horizontal scrollable bar on mobile.

**Choosing a rendering approach:**

| Content type | Approach | Why |
|---|---|---|
| Architecture (text-heavy) | CSS Grid cards + flow arrows | Rich card content (descriptions, code, tool lists) needs CSS control |
| Architecture (topology-focused) | **Mermaid** | Visible connections between components need automatic edge routing |
| Flowchart / pipeline | **Mermaid** | Automatic node positioning and edge routing |
| Sequence diagram | **Mermaid** | Lifelines, messages, and activation boxes need automatic layout |
| Data flow | **Mermaid** with edge labels | Connections and data descriptions need automatic edge routing |
| ER / schema diagram | **Mermaid** | Relationship lines between many entities need auto-routing |
| State machine | **Mermaid** | State transitions with labeled edges need automatic layout |
| Mind map | **Mermaid** | Hierarchical branching needs automatic positioning |
| Class diagram | **Mermaid** | Inheritance, composition, aggregation lines with automatic routing |
| C4 architecture | **Mermaid** | Use `graph TD` + `subgraph` for C4 (not native `C4Context` — it ignores themes) |
| Data table | HTML `<table>` | Semantic markup, accessibility, copy-paste behavior |
| Timeline | CSS (central line + cards) | Simple linear layout doesn't need a layout engine |
| Dashboard | CSS Grid + Chart.js | Card grid with embedded charts |

**Mermaid theming:** Always use `theme: 'base'` with custom `themeVariables` so colors match your page palette. Use `layout: 'elk'` for complex graphs (requires the `@mermaid-js/layout-elk` package — see `./references/libraries.md` for the CDN import). Override Mermaid's SVG classes with CSS for pixel-perfect control. See `./references/libraries.md` for full theming guide.

**Mermaid containers:** Always center Mermaid diagrams with `display: flex; justify-content: center;`. Add zoom controls (+/−/reset/expand) to every `.mermaid-wrap` container. Include the click-to-expand JavaScript so clicking the diagram (or the ⛶ button) opens it full-size in a new tab.

**⚠️ Never use bare `<pre class="mermaid">`.** It renders but has no zoom/pan controls — diagrams become tiny and unusable. Always use the full `diagram-shell` pattern from `templates/mermaid-flowchart.html`: the HTML structure (`.diagram-shell` > `.mermaid-wrap` > `.zoom-controls` + `.mermaid-viewport` > `.mermaid-canvas`), the CSS, and the ~200-line JS module for zoom/pan/fit. Copy it wholesale.

**Mermaid scaling:** Diagrams with 10+ nodes render too small by default. For 10-12 nodes, increase `fontSize` in themeVariables to 18-20px and set `INITIAL_ZOOM` to 1.5-1.6. For 15+ elements, don't try to scale — use the hybrid pattern instead (simple Mermaid overview + CSS Grid cards). See "Architecture / System Diagrams" below.

**Mermaid layout direction:** Prefer `flowchart TD` (top-down) over `flowchart LR` (left-to-right) for complex diagrams. LR spreads horizontally and makes labels unreadable when there are many nodes. Use LR only for simple 3-4 node linear flows. See `./references/libraries.md` "Layout Direction: TD vs LR".

**Mermaid line breaks in flowchart labels:** Use `<br/>` inside quoted labels. Never use escaped newlines like `\n` (Mermaid renders them as literal text in HTML output). Example: `A["Copilot Backend<br/>/api + /api/voicebot"]`.

**Mermaid CSS class collision constraint:** Never define `.node` as a page-level CSS class. Mermaid.js uses `.node` internally on SVG `<g>` elements with `transform: translate(x, y)` for positioning. Page-level `.node` styles (hover transforms, box-shadows) leak into diagrams and break layout. Use the namespaced `.ve-card` class for card components instead. The only safe way to style Mermaid's `.node` is scoped under `.mermaid` (e.g., `.mermaid .node rect`).

**AI-generated illustrations (optional).** If [surf-cli](https://github.com/nicobailon/surf-cli) is available, you can generate images via Gemini and embed them in the page for creative, illustrative, explanatory, educational, or decorative purposes. Check availability with `which surf`. If available:

```bash
# Generate to a temp file (use --aspect-ratio for control)
surf gemini "descriptive prompt" --generate-image /tmp/ve-img.png --aspect-ratio 16:9

# Base64 encode for self-containment (macOS)
IMG=$(base64 -i /tmp/ve-img.png)
# Linux: IMG=$(base64 -w 0 /tmp/ve-img.png)

# Embed in HTML and clean up
# <img src="data:image/png;base64,${IMG}" alt="descriptive alt text">
rm /tmp/ve-img.png
```

See `./references/css-patterns.md` for image container styles (hero banners, inline illustrations, captions).

**When to use:** Hero banners that establish the page's visual tone. Conceptual illustrations for abstract systems that Mermaid can't express (physical infrastructure, user journeys, mental models). Educational diagrams that benefit from artistic or photorealistic rendering. Decorative accents that reinforce the aesthetic.

**When to skip:** Anything Mermaid or CSS handles well. Generic decoration that doesn't convey meaning. Data-heavy pages where images would distract. Always degrade gracefully — if surf isn't available, skip images without erroring. The page should stand on its own with CSS and typography alone.

**Prompt craft:** Match the image to the page's palette and aesthetic direction. Specify the style (3D render, technical illustration, watercolor, isometric, flat vector, etc.) and mention dominant colors from your CSS variables. Use `--aspect-ratio 16:9` for hero banners, `--aspect-ratio 1:1` for inline illustrations. Keep prompts specific — "isometric illustration of a message queue with cyan nodes on dark navy background" beats "a diagram of a queue."

### 3. Style

Apply these principles to every diagram:

**Typography is the diagram.** Pick a distinctive font pairing from the list in `./references/libraries.md`. Every page should use a different pairing from recent generations.

**Forbidden as `--font-body`:** Inter, Roboto, Arial, Helvetica, system-ui alone. These are AI slop signals.

**Good pairings (use these):**
- DM Sans + Fira Code (technical, precise)
- Instrument Serif + JetBrains Mono (editorial, refined)
- IBM Plex Sans + IBM Plex Mono (reliable, readable)
- Bricolage Grotesque + Fragment Mono (bold, characterful)
- Plus Jakarta Sans + Azeret Mono (rounded, approachable)

Load via `<link>` in `<head>`. Include a system font fallback in the `font-family` stack for offline resilience.

**Color tells a story.** Use CSS custom properties for the full palette. Define at minimum: `--bg`, `--surface`, `--border`, `--text`, `--text-dim`, and 3-5 accent colors. Each accent should have a full and a dim variant (for backgrounds). Name variables semantically when possible (`--pipeline-step` not `--blue-3`). Support both themes.

**Forbidden accent colors:** `#8b5cf6` `#7c3aed` `#a78bfa` (indigo/violet), `#d946ef` (fuchsia), the cyan-magenta-pink combination. These are Tailwind defaults that signal zero design intent.

**Good accent palettes (use these):**
- Terracotta + sage (`#c2410c`, `#65a30d`) — warm, earthy
- Teal + slate (`#0891b2`, `#0369a1`) — technical, precise
- Rose + cranberry (`#be123c`, `#881337`) — editorial, refined
- Amber + emerald (`#d97706`, `#059669`) — data-focused
- Deep blue + gold (`#1e3a5f`, `#d4a73a`) — premium, sophisticated

Put your primary aesthetic in `:root` and the alternate in the media query:

```css
/* Light-first (editorial, paper/ink, blueprint): */
:root { /* light values */ }
@media (prefers-color-scheme: dark) { :root { /* dark values */ } }

/* Dark-first (neon, IDE-inspired, terminal): */
:root { /* dark values */ }
@media (prefers-color-scheme: light) { :root { /* light values */ } }
```

**Surfaces whisper, they don't shout.** Build depth through subtle lightness shifts (2-4% between levels), not dramatic color changes. Borders should be low-opacity rgba (`rgba(255,255,255,0.08)` in dark mode, `rgba(0,0,0,0.08)` in light) — visible when you look, invisible when you don't.

**Backgrounds create atmosphere.** Don't use flat solid colors for the page background. Subtle gradients, faint grid patterns via CSS, or gentle radial glows behind focal areas. The background should feel like a space, not a void.

**Visual weight signals importance.** Not every section deserves equal visual treatment. Executive summaries and key metrics should dominate the viewport on load (larger type, more padding, subtle accent-tinted background zone). Reference sections (file maps, dependency lists, decision logs) should be compact and stay out of the way. Use `<details>/<summary>` for sections that are useful but not primary — the collapsible pattern is in `./references/css-patterns.md`.

**Surface depth creates hierarchy.** Vary card depth to signal what matters. Hero sections get elevated shadows and accent-tinted backgrounds (`ve-card--hero` pattern). Body content stays flat (default `.ve-card`). Code blocks and secondary content feel recessed (`ve-card--recessed`). See the depth tiers in `./references/css-patterns.md`. Don't make everything elevated — when everything pops, nothing does.

**Animation earns its place.** Staggered fade-ins on page load are almost always worth it — they guide the eye through the diagram's hierarchy. Mix animation types by role: `fadeUp` for cards, `fadeScale` for KPIs and badges, `drawIn` for SVG connectors, `countUp` for hero numbers. Hover transitions on interactive-feeling elements make the diagram feel alive. Always respect `prefers-reduced-motion`. CSS transitions and keyframes handle most cases. For orchestrated multi-element sequences, anime.js via CDN is available (see `./references/libraries.md`).

**Forbidden animations:**
- Animated glowing box-shadows (`@keyframes glow { box-shadow: 0 0 20px... }`) — this is AI slop
- Pulsing/breathing effects on static content
- Continuous animations that run after page load (except for progress indicators)

Keep animations purposeful: entrance reveals, hover feedback, and user-initiated interactions. Nothing should glow or pulse on its own.

### 4. Deliver

**Output location:** Write to `~/.agent/diagrams/`. Use a descriptive filename based on content: `modem-architecture.html`, `pipeline-flow.html`, `schema-overview.html`. The directory persists across sessions.

**Open in browser:**
- macOS: `open ~/.agent/diagrams/filename.html`
- Linux: `xdg-open ~/.agent/diagrams/filename.html`

**Tell the user** the file path so they can re-open or share it.

## Diagram Types

### Architecture / System Diagrams
Three approaches depending on complexity:

**Simple topology (under 10 elements):** Use Mermaid. A `graph TD` with custom `themeVariables` produces readable diagrams with automatic edge routing.

**Text-heavy overviews (under 15 elements):** CSS Grid with explicit row/column placement. Sections as rounded cards with colored borders and monospace labels. Vertical flow arrows between sections. The reference template at `./templates/architecture.html` demonstrates this pattern. Use when cards need descriptions, code references, tool lists, or other rich content that Mermaid nodes can't hold.

**Complex architectures (15+ elements):** Use the **hybrid pattern** — a simple Mermaid overview (5-8 nodes showing module relationships) followed by detailed CSS Grid cards for each module's internals. This gives you visual topology AND readable details. The overview diagram uses module names with `<small>` tags for key function names. The cards below show full function lists with new/modified badges. Never try to cram 15+ elements into a single Mermaid diagram — it will render unreadably small even with zoom controls.

### Flowcharts / Pipelines
**Use Mermaid.** Automatic node positioning and edge routing produces proper diagrams with connecting lines, decision diamonds, and parallel branches — dramatically better than CSS flexbox with arrow characters. Prefer `graph TD` (top-down); use `graph LR` only for simple 3-4 node linear flows. Color-code node types with Mermaid's `classDef` or rely on `themeVariables` for automatic styling.

### Sequence Diagrams
**Use Mermaid.** Lifelines, messages, activation boxes, notes, and loops all need automatic layout. Use Mermaid's `sequenceDiagram` syntax. Style actors and messages via CSS overrides on `.actor`, `.messageText`, `.activation` classes.

### Data Flow Diagrams
**Use Mermaid.** Data flow diagrams emphasize connections over boxes — exactly what Mermaid excels at. Use `graph TD` (or `graph LR` for simple linear flows) with edge labels for data descriptions. Thicker, colored edges for primary flows. Source/sink nodes styled differently from transform nodes via Mermaid's `classDef`.

### Schema / ER Diagrams
**Use Mermaid.** Relationship lines between entities need automatic routing. Use Mermaid's `erDiagram` syntax with entity attributes. Style via `themeVariables` and CSS overrides on `.er.entityBox` and `.er.relationshipLine`.

### State Machines / Decision Trees
**Use Mermaid.** Use `stateDiagram-v2` for states with labeled transitions. Supports nested states, forks, joins, and notes. Decision trees can use `graph TD` with diamond decision nodes.

**`stateDiagram-v2` label caveat:** Transition labels have a strict parser — colons, parentheses, `<br/>`, HTML entities, and most special characters cause silent parse failures ("Syntax error in text"). If your labels need any of these (e.g., `cancel()`, `curate: true`, multi-line labels), use `flowchart TD` instead with rounded nodes and quoted edge labels (`|"label text"|`). Flowcharts handle all special characters and support `<br/>` for line breaks. Reserve `stateDiagram-v2` for simple single-word or plain-text labels.

### Mind Maps / Hierarchical Breakdowns
**Use Mermaid.** Use `mindmap` syntax for hierarchical branching from a root node. Mermaid handles the radial layout automatically. Style with `themeVariables` to control node colors at each depth level.

### Class Diagrams
**Use Mermaid.** Use `classDiagram` syntax for domain modeling, OOP design, and entity relationships with typed properties and methods. Supports relationships: association (`-->`), composition (`*--`), aggregation (`o--`), and inheritance (`<|--`). Add multiplicity labels (e.g., `"1" --> "*"`) and abstract/interface markers (`<<interface>>`, `<<abstract>>`). For simple entity boxes without OOP semantics (no methods, no inheritance), prefer `erDiagram` instead — it produces cleaner output for pure data modeling.

### C4 Architecture Diagrams
**Use Mermaid flowchart syntax — NOT native C4.** Use `graph TD` with `subgraph` blocks for C4 boundaries. Native `C4Context` hardcodes sharp corners, its own font, blue icons, and inline SVG colors that ignore `themeVariables` — it always clashes with custom palettes.

**Flowchart-as-C4 pattern:** Persons → rounded nodes `(("Name"))`, systems → rectangles `["Name"]`, databases → cylinders `[("Name")]`, boundaries → `subgraph` blocks, relationships → labeled arrows `-->|"protocol"|`. Use `classDef` + `:::className` to visually differentiate external systems (e.g., dashed borders). This inherits `themeVariables`, `fontFamily`, and CSS overrides like every other Mermaid diagram.

### Data Tables / Comparisons / Audits
Use a real `<table>` element — not CSS Grid pretending to be a table. Tables get accessibility, copy-paste behavior, and column alignment for free. The reference template at `./templates/data-table.html` demonstrates all patterns below.

**Use proactively.** Any time you'd render an ASCII box-drawing table in the terminal, generate an HTML table instead. This includes: requirement audits (request vs plan), feature comparisons, status reports, configuration matrices, test result summaries, dependency lists, permission tables, API endpoint inventories — any structured rows and columns.

Layout patterns:
- Sticky `<thead>` so headers stay visible when scrolling long tables
- Alternating row backgrounds via `tr:nth-child(even)` (subtle, 2-3% lightness shift)
- First column optionally sticky for wide tables with horizontal scroll
- Responsive wrapper with `overflow-x: auto` for tables wider than the viewport
- Column width hints via `<colgroup>` or `th` widths — let text-heavy columns breathe
- Row hover highlight for scanability

Status indicators (use styled `<span>` elements, never emoji):
- Match/pass/yes: colored dot or checkmark with green background
- Gap/fail/no: colored dot or cross with red background
- Partial/warning: amber indicator
- Neutral/info: dim text or muted badge

Cell content:
- Wrap long text naturally — don't truncate or force single-line
- Use `<code>` for technical references within cells
- Secondary detail text in `<small>` with dimmed color
- Keep numeric columns right-aligned with `tabular-nums`

### Timeline / Roadmap Views
Vertical or horizontal timeline with a central line (CSS pseudo-element). Phase markers as circles on the line. Content cards branching left/right (alternating) or all to one side. Date labels on the line. Color progression from past (muted) to future (vivid).

### Dashboard / Metrics Overview
Card grid layout. Hero numbers large and prominent. Sparklines via inline SVG `<polyline>`. Progress bars via CSS `linear-gradient` on a div. For real charts (bar, line, pie), use **Chart.js via CDN** (see `./references/libraries.md`). KPI cards with trend indicators (up/down arrows, percentage deltas).

### Implementation Plans

For visualizing implementation plans, extension designs, or feature specifications. The goal is **understanding the approach**, not reading the full source code.

**Don't dump full files.** Displaying entire source files inline overwhelms the page and defeats the purpose of a visual explanation. Instead:
- Show **file structure with descriptions** — list functions/exports with one-line explanations
- Show **key snippets only** — the 5-10 lines that illustrate the core logic
- Use **collapsible sections** for full code if truly needed

**Code blocks require explicit formatting.** Without `white-space: pre-wrap`, code runs together into an unreadable wall. See the "Code Blocks" section in `./references/css-patterns.md` for the correct pattern.

**Structure for implementation plans:**
1. Overview/purpose (what problem does this solve?)
2. Flow diagram (Mermaid or CSS cards)
3. File structure with descriptions (not full code)
4. Key implementation details (snippets)
5. API/interface summary
6. Usage examples

### Documentation (READMEs, Library Docs, API References)

When visualizing documentation, extract structure into visual elements:

| Content | Visual Treatment |
|---------|------------------|
| Features | Card grid (2-3 columns) |
| Install/setup steps | Numbered cards or vertical flow |
| API endpoints/commands | Table with sticky header |
| Config options | Table |
| Architecture | Mermaid diagram or CSS card layout |
| Comparisons | Side-by-side panels or table |
| Warnings/notes | Callout boxes |

Don't just format the prose — transform it. A feature list becomes a card grid. Install steps become a numbered flow. An API reference becomes a table.

### Prose Accent Elements

Use these sparingly within visual pages to highlight key points or provide breathing room. See "Prose Page Elements" in `./references/css-patterns.md` for CSS patterns.

- **Lead paragraph** — larger intro text to set context before diving into cards/grids
- **Pull quote** — highlight a key insight; one per page maximum
- **Callout box** — warnings, tips, important notes
- **Section divider** — visual break between major sections

**When to use:** A visual page explaining an essay might use a lead paragraph for the thesis, then cards for key arguments. A README visualization might use callout boxes for warnings but otherwise stay card/table-focused.

## Slide Deck Mode

An alternative output format for presenting content as a magazine-quality slide presentation instead of a scrollable page. **Opt-in only** — the agent generates slides when the user invokes `/generate-slides`, passes `--slides` to an existing prompt (e.g., `/diff-review --slides`), or explicitly asks for a slide deck. Never auto-select slide format.

**Before generating slides**, read `./references/slide-patterns.md` (engine CSS, slide types, transitions, nav chrome, presets) and `./templates/slide-deck.html` (reference template showing all 10 types). Also read `./references/css-patterns.md` for shared patterns and `./references/libraries.md` for Mermaid/Chart.js theming.

**Slides are not pages reformatted.** They're a different medium. Each slide is exactly one viewport tall (100dvh) with no scrolling. Typography is 2–3× larger. Compositions are bolder. The agent composes a narrative arc (impact → context → deep dive → resolution) rather than mechanically paginating the source.

**Content completeness.** Changing the medium does not mean dropping content. Follow the "Planning a Deck from a Source Document" process in `slide-patterns.md` before writing any HTML: inventory the source, map every item to slides, verify coverage. Every section, decision, data point, specification, and collapsible detail from the source must appear in the deck. If a plan has 7 sections, the deck covers all 7. If there are 6 decisions, present all 6 — not the 2 that fit on one slide. Collapsible details in the source become their own slides. Add more slides rather than cutting content. A 22-slide deck that covers everything beats a 13-slide deck that looks polished but is missing 40% of the source.

**Slide types (10):** Title, Section Divider, Content, Split, Diagram, Dashboard, Table, Code, Quote, Full-Bleed. Each has a defined layout in `slide-patterns.md`. Content that exceeds a slide's density limit splits across multiple slides — never scrolls within a slide.

**Visual richness:** Check `which surf` at the start. If surf-cli is available, generate 2–4 images (title slide background, full-bleed background, optional content illustrations) before writing HTML — see the Proactive Imagery section in `slide-patterns.md` for the workflow. Also use SVG decorative accents, per-slide background gradients, inline sparklines, and small Mermaid diagrams. Visual-first, text-second.

**Compositional variety:** Consecutive slides must vary spatial approach — centered, left-heavy, right-heavy, split, edge-aligned, full-bleed. Three centered slides in a row means push one off-axis.

**Curated presets:** Four slide-specific presets as starting points (Midnight Editorial, Warm Signal, Terminal Mono, Swiss Clean) plus the existing 8 aesthetic directions adapted for slides. Pick one and commit. See `slide-patterns.md` for preset CSS values.

**`--slides` flag on existing prompts:** When a user passes `--slides` to `/diff-review`, `/plan-review`, `/project-recap`, or other prompts, the agent gathers data using the prompt's normal data-gathering instructions, then presents the content as a slide deck instead of a scrollable page. The slide version tells the same story with different structure and pacing — but the same breadth of coverage. Don't use the slide format as an excuse to summarize or skip sections that the scrollable version would have included.

## File Structure

Every diagram is a single self-contained `.html` file. No external assets except CDN links (fonts, optional libraries). Structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Descriptive Title</title>
  <link href="https://fonts.googleapis.com/css2?family=...&display=swap" rel="stylesheet">
  <style>
    /* CSS custom properties, theme, layout, components — all inline */
  </style>
</head>
<body>
  <!-- Semantic HTML: sections, headings, lists, tables, inline SVG -->
  <!-- No script needed for static CSS-only diagrams -->
  <!-- Optional: <script> for Mermaid, Chart.js, or anime.js when used -->
</body>
</html>
```

## Sharing Pages

Share visual explainer pages instantly via Vercel. No account or authentication required.

**Usage:**
```bash
bash {{skill_dir}}/scripts/share.sh <html-file>
```

**Example:**
```bash
bash {{skill_dir}}/scripts/share.sh ~/.agent/diagrams/my-diagram.html

# Output:
# ✓ Shared successfully!
# Live URL:  https://skill-deploy-abc123.vercel.app
# Claim URL: https://vercel.com/claim-deployment?code=...
```

**How it works:**
1. Copies HTML file to temp directory as `index.html`
2. Deploys via the vercel-deploy skill (zero-auth claimable deployment)
3. URL is live immediately — works in any browser

**Requirements:**
- vercel-deploy skill (should be pre-installed; if not: `pi install npm:vercel-deploy`)

**Notes:**
- Deployments are public — anyone with the URL can view
- Preview deployments have configurable retention (default: 30 days)
- Claim URL lets you transfer the deployment to your Vercel account

See `./commands/share.md` for the `/share` command template.

## Quality Checks

Before delivering, verify:
- **The squint test**: Blur your eyes. Can you still perceive hierarchy? Are sections visually distinct?
- **The swap test**: Would replacing your fonts and colors with a generic dark theme make this indistinguishable from a template? If yes, push the aesthetic further.
- **Both themes**: Toggle your OS between light and dark mode. Both should look intentional, not broken.
- **Information completeness**: Does the diagram actually convey what the user asked for? Pretty but incomplete is a failure.
- **No overflow**: Resize the browser to different widths. No content should clip or escape its container. Every grid and flex child needs `min-width: 0`. Side-by-side panels need `overflow-wrap: break-word`. Never use `display: flex` on `<li>` for marker characters — it creates anonymous flex items that can't shrink, causing lines with many inline `<code>` badges to overflow. Use absolute positioning for markers instead. See the Overflow Protection section in `./references/css-patterns.md`.
- **Mermaid zoom controls**: Every `.mermaid-wrap` container must have zoom controls (+/−/reset/expand buttons), Ctrl/Cmd+scroll zoom, click-and-drag panning, and click-to-expand (clicking without dragging opens the diagram full-size in a new tab). The expand button (⛶) provides the same functionality. See `./references/css-patterns.md` for the full pattern including the `openMermaidInNewTab()` function.
- **File opens cleanly**: No console errors, no broken font loads, no layout shifts.

## Anti-Patterns (AI Slop)

These patterns are explicitly forbidden. They signal "AI-generated template" and undermine the skill's purpose of producing distinctive, high-quality diagrams. Review every generated page against this list.

### Typography

**Forbidden fonts as primary `--font-body`:**
- Inter — the single most overused AI default
- Roboto, Arial, Helvetica — generic system fallbacks promoted to primary
- system-ui, sans-serif alone — no character, no intent

**Required:** Pick from the font pairings in `./references/libraries.md`. Every generation should use a different pairing from the last.

### Color Palette

**Forbidden accent colors:**
- Indigo-500/violet-500 (`#8b5cf6`, `#7c3aed`, `#a78bfa`) — Tailwind's default purple range
- The cyan + magenta + pink neon gradient combination (`#06b6d4` → `#d946ef` → `#f472b6`)
- Any palette that could be described as "Tailwind defaults with purple/pink/cyan accents"

**Forbidden color effects:**
- Gradient text on headings (`background: linear-gradient(...); background-clip: text;`) — this screams AI-generated
- Animated glowing box-shadows on cards (`box-shadow: 0 0 20px var(--glow); animation: glow 2s...`)
- Multiple overlapping radial glows in accent colors creating a "neon haze"

**Required:** Build palettes from the reference templates (terracotta/sage, teal/cyan, rose/cranberry, slate/blue) or derive from real IDE themes (Dracula, Nord, Solarized, Gruvbox, Catppuccin). Accents should feel intentional, not default.

### Section Headers

**Forbidden:**
- Emoji icons in section headers (🏗️, ⚙️, 📁, 💻, 📅, 🔗, ⚡, 🔧, 📦, 🚀, etc.)
- Section headers that all use the same icon-in-rounded-box pattern

**Required:** Use styled monospace labels with colored dot indicators (see `.section-label` in templates), numbered badges (`section__num` pattern), or asymmetric section dividers. If an icon is genuinely needed, use an inline SVG that matches the palette — not emoji.

### Layout & Hierarchy

**Forbidden:**
- Perfectly centered everything with uniform padding
- All cards styled identically with the same border-radius, shadow, and spacing
- Every section getting equal visual treatment — no hero/primary vs. secondary distinction
- Symmetric layouts where left and right halves mirror each other

**Required:** Vary visual weight. Hero sections should dominate (larger type, more padding, accent-tinted background). Reference sections should feel compact. Use the depth tiers (hero → elevated → default → recessed). Asymmetric layouts create interest.

### Template Patterns

**Forbidden:**
- Three-dot window chrome (red/yellow/green dots) on code blocks — this is a cliché
- KPI cards where every metric has identical gradient text treatment
- "Neon Dashboard" as an aesthetic choice — it always produces generic results
- Gradient meshes with pink/purple/cyan blobs in the background

**Required:** Code blocks use a simple header with filename or language label. KPI cards vary by importance — hero numbers for the primary metric, subdued treatment for supporting metrics. Pick aesthetics with natural constraints: Blueprint (must feel technical/precise), Editorial (must have generous whitespace and serif typography), Paper/ink (must feel warm and informal).

### The Slop Test

Before delivering, apply this test: **Would a developer looking at this page immediately think "AI generated this"?** The telltale signs:

1. Inter or Roboto font with purple/violet gradient accents
2. Every heading has `background-clip: text` gradient
3. Emoji icons leading every section
4. Glowing cards with animated shadows
5. Cyan-magenta-pink color scheme on dark background
6. Perfectly uniform card grid with no visual hierarchy
7. Three-dot code block chrome

If two or more of these are present, the page is slop. Regenerate with a different aesthetic direction — Editorial, Blueprint, Paper/ink, or a specific IDE theme. These constrained aesthetics are harder to mess up because they have specific visual requirements that prevent defaulting to generic patterns.
