# NanoClaw Dashboard — UI/UX Specification

A focused, single-operator orchestration console for a fleet of AI-agent groups. Built to be lived in for hours, glanced at for seconds, and never to nag.

This spec is the visual + interaction contract for the dashboard surface defined in [`./design.md`](./design.md). It is opinionated by request: one option per decision, no "could do A or B."

**Revision note (2026-05-09)**: iterated against two design audits. First pass tightened structure (Needs You as chrome-distinct band, left rail icons-only by default, status filter chips removed, Failed section dissolved into Needs You / Completed, Cmd-1/2/3/4 view nav + `g <letter>` for agent groups, progress bars removed, tool-call activity made explicit, connection-loss state specified, dependencies inlined under task title, no cost/token ticker). Second pass added: sentence-case section headers, tinted shadows, active/pressed feedback, active-rail indicator, button taxonomy, max-width container, inline failure reasons, Geist body type, Phosphor chrome icons, squircle avatar, accessibility primitives (skip-link, aria-live, aria-current), 404 view.

## 0. Frame

**Register.** Product. Design serves the task; familiarity is a feature.

**Scene sentence.** *"Dave glancing at six in-flight agent tasks on a 27-inch display at 11pm in a dim home office, between Slack messages, looking for the one task that actually needs him."* Forces dark, forces density, forces a single attention-grabbing accent that reads at a glance.

**Color strategy.** Restrained. Tinted neutrals plus a single accent below 10% surface coverage. Status uses muted semantic hues — never carnival. Linear's restraint is the floor, not the ceiling.

**Anchor references.** Linear (density, motion discipline, command palette), Raycast (keyboard-primacy, list rhythm, accent treatment), Arc (sidebar topology, soft hierarchy).

**Anti-references.** Vercel's admin (too much card-and-grid), Datadog (legible chaos, not for one operator), Notion (too soft, too many controls), Grafana (data viz first, navigation last).

**The slop test.** Would a Linear power user sit down, find Cmd-1/2/3/4 view nav, the ⌘K palette, ⏎-to-open, and / for filter without prompting? If not, it's failed.

---

## 1. Information Architecture

Four primary views. No nesting beyond two levels. No tabs that pretend to be screens.

```
NanoClaw
├── /         Tasks            (default; the workspace)
├── /tasks/:id Task detail     (transcript + steer)
├── /agents   Agent groups     (fleet inventory + config)
└── /settings Settings         (you, channels, runtime)
```

A persistent left rail holds these four (Cmd-1 through Cmd-4). A persistent top strip holds: connection dot, command palette trigger, current owner avatar. Nothing else is a top-level destination.

**Routing principles.**
- The Tasks view is `/`. Dave lands here every time. It is the dashboard.
- Task detail is a route, not a modal. It must be linkable, refreshable, copyable to Slack.
- Filters live in the URL (`?group=illysium&owner=me`) so any view can be bookmarked or shared as a deep link to himself.
- No "home" or "overview" page that summarizes other pages. The Tasks view is the overview.

**Cross-view affordances.**
- A right-side **inspector panel** can open over Tasks or Agents (toggle: `i`). It shows the selected row's detail without leaving the list. This is the Linear pattern, and it's the right one.
- A **command palette** (`⌘K` / `Ctrl-K`) is global, all four views, all states.

---

## 2. Layout Sketches

Spacing notation: a single character is roughly 8px in a real implementation; the sketches show proportion, not pixel counts.

### 2.1 Tasks (`/`) — the home view

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ◉  nanoclaw                                            ⌘K  search            ◐  D  │  ← top strip (40px)
├────┬───────────────────────────────────────────────────────────────────────────────┤
│    │  Tasks                                                  [All ▾]   [Owner ▾]   │
│ ⌂  ├───────────────────────────────────────────────────────────────────────────────┤
│ ⊞  │┌─────────────────────────────────────────────────────────────────────────────┐│
│ ⊟  ││ • Needs you · 3                                                             ││ ← chrome band:
│ ⚙  ││ ●  illysium       Approve write to prod DB         waiting 4m  [Approve]    ││   bg-elev,
│    ││ ●  axie-dev       Question: stub or real fixtures? waiting 1h  [Answer]     ││   1.25× row,
│ ─  ││ ✕  axie-dev       Vercel deploy (auth error)       failed 10m  [Retry]     ││   no caret,
│    ││    401 Unauthorized at api.vercel.com/v1/deployments                         ││   never collapses
│    │└─────────────────────────────────────────────────────────────────────────────┘│
│ ◉  │                                                                               │
│ ●  │  ▾ · Running · 6                                                              │  ← active group:
│ ◉  │  ◐  madison-reed   Refactor checkout to use SKU map            running 3m     │     1.5× dot
│ ◉  │  ◐  number-drinks  Daily revenue digest                        running 12s    │     + 1px ring
│ ◉  │  ◐  axis-labs      Migrate analytics to dbt cloud              running 47m    │
│ ◉  │  ◐  sunday         Investigate flaky integration test          running 2m     │
│ ◉  │  ⏸  video-agent    Render weekly recap MP4         (blocked by · sunday)      │
│ ◉  │  ◐  xerus          Index repo into gitnexus                    running 18m    │
│ ◉  │                                                                               │
│ ◉  │  ▾ · Completed today · 11                                                     │
│ ◉  │  ✓  main           Triage GitHub PRs                              5m  · 4:32 │
│ ◉  │  ✓  dirt-market    Pull listing comps for 12 zips               14m  · 2:08 │
│ ◉  │  ✓  xzo            Generate demo storyboard                      3m  · 1:47 │
│    │  ⋯ 8 more                                                                     │
└────┴───────────────────────────────────────────────────────────────────────────────┘
```

**Left rail — icons by default.** The four primary view icons sit at the top (Phosphor: House, SquaresFour, Stack, Gear). Below the divider, eleven colored dots represent the eleven agent groups (one dot per group, color-coded so shape-recognition works). Hover expands the rail to show full names; expansion is a width transition only, no entrance choreography. The 3-letter slug is *not* used in the rail — it lives only as `<GroupTag>` chips inline in task rows. The rail's job is glanceable presence + click target, not text identification.

**Active rail indicator.** The current view's icon renders in `accent` color with a 1px left border in `accent` flush to the rail edge. The currently-filtered agent group's dot renders at 1.5× size with a 1px `accent` ring. Both expose `aria-current="page"` for screen readers and keyboard users.

**Section semantics.** Tasks always sort into the same three sections in this order: **Needs you**, **Running**, **Completed today**. There is no separate Failed section — untriaged failures appear in Needs you until you ack them; acknowledged failures move to Completed (with `✕` instead of `✓`). Section headers render in sentence case, `text-md` weight 550, with a leading `accent`-colored dot and a thin disclosure caret. A section with zero items collapses to a one-line dim header rather than disappearing — Dave should not have to wonder whether a section exists. **Needs you never collapses** and is rendered as a chrome-distinct band (`bg-elev` background, full-bleed under the filter row, 1.25× row height, no disclosure caret). Hierarchy must match function.

**Filter chips.** Two only: `[All ▾]` (group filter) and `[Owner ▾]` (assignee). Status filtering is what the section model is for — adding a `[Running ▾]` chip duplicates a slicing axis and forces the user to mentally compose two filters at once. Single slicing axis per axis.

**Row anatomy.** A status glyph (●◐⏸✓✕), an agent group tag (`<GroupTag>`, 3-letter), a single-line task title, a status string (waiting 4m / running 3m / blocked-by reference / completed-at timestamp), and trailing actions only when relevant. **No progress bars** — the duration string carries enough signal, and step-bar resolution is too coarse to add value (see §5 for the per-row breathing indicator that conveys "alive vs stuck"). No avatars, no thumbnails, no chips that don't earn their pixels.

**Responsive.** Below 1080px wide, the left rail stays icons-only (no expansion possible — the rail is *already* its compact form). Below 720px, it becomes a slide-over (`g` then a letter to switch to an agent group, Cmd-1..4 for views). The status string truncates before the title does. Above 1800px wide, the body content is constrained to `max-width: 1680px` and centers between the rail (pinned left) and the inspector (pinned right when open) — prevents row text from sprawling on ultra-wide monitors. The dashboard isn't designed to be the primary mobile surface — Slack already is.

**Failure rows in Needs you.** Failed tasks render their actual failure reason inline (`text-xs danger` on a second line under the title), not just the `✕` glyph. The reason should be the real first-line of the error (HTTP code + endpoint, exception class + message, exit code + command), not a generic "task failed." If the agent itself produced a structured failure summary in `task_complete`, prefer that.

### 2.2 Task Detail (`/tasks/:id`)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ◉  nanoclaw            ←  Tasks                                          ⌘K   ◐  D │
├────┬─────────────────────────────────────────────┬───────────────────────────────┤
│    │  Refactor checkout to use SKU map            │  RUN INFO                     │
│ ⌂  │  madison-reed · ◐ running · 3m · ↓ blocks    │  Started      11:42 PM        │
│ ⊞  │   video-agent (weekly recap)                 │  Elapsed      00:03:18        │
│ ⊟  │  ─────────────────────────────────────────   │  Tokens       142k in / 8k    │
│ ⚙  │                                              │  Cost         $0.41           │
│    │  11:42  you (orchestrator → mr)              │  Container    nc-mr-7a2c      │
│ ─  │   "Replace the per-line product fetch in     │  Branch       feat/sku-map    │
│    │    cart-service with the SKU lookup map.     │                               │
│ ◉  │    Tests first. Don't merge."                │  ARTIFACTS                    │
│ ◉  │                                              │  ⎘ branch diff                │
│ ◉  │  11:42  madison-reed                         │  ⎘ test output                │
│ ◉  │   reading src/cart-service/index.ts ▾        │  ⎘ this transcript            │
│ ◉  │                                              │                               │
│ ◉  │  11:43  madison-reed                         │                               │
│ ◉  │   ▾ ran 3 tools                              │                               │
│ ◉  │                                              │                               │
│ ◉  │  ◐ running: bash · pnpm test (24s)           │  ← live tool-call ticker      │
│ ◉  │                                              │                               │
│ ◉  │  ─────────────────────────────────────────   │                               │
│ ◉  │  Steer this task                             │                               │
│    │ ┌─────────────────────────────────────────┐  │                               │
│    │ │ tests should also cover the empty       │  │                               │
│    │ │ cart case_                              │  │                               │
│    │ └─────────────────────────────────────────┘  │                               │
│    │  ⏎ send   ⌘⏎ send + pause   esc to list      │                               │
└────┴─────────────────────────────────────────────┴───────────────────────────────┘
```

The transcript center column owns the screen. The right-hand metadata column is 280px and can be hidden (`m` toggles meta). The steer composer is pinned to the bottom of the transcript column, not the page; the page itself doesn't scroll, the transcript does. New messages stream in at the bottom; the view auto-pins to bottom only if the user is already at the bottom — Slack rule, the right one.

**Dependencies inline under title** as a one-liner (`↑ blocked by · X` or `↓ blocks · Y`). Right column is pure run telemetry + artifacts; one job, well done.

**Tool calls render as collapsible groups.** Three or more tool calls in a row collapse to "ran N tools ▾" by default. The agent's prose is what Dave reads at a glance; the tool noise is recoverable.

**Live tool-call ticker** (the missing-state fix from the audit): when the agent has an in-flight tool call but no streaming text, a single replacing line above the composer shows `◐ running: <verb> · <args> (<elapsed>)`. The line replaces itself rather than scrolling — the transcript stays clean. The breathing glyph rotates at 1Hz only when a tool call is genuinely in flight.

**Code blocks** use a syntax-tinted muted palette — never high-saturation. A copy button appears on hover at the right edge.

**Steer composer** is a single `<textarea>` that auto-grows to 6 rows then scrolls. ⏎ sends, ⌘⏎ sends and pauses the agent (queue the message but stop the next tool call), Esc returns to the list. No formatting toolbar. No file attachments in v1.

### 2.3 Agent Groups (`/agents`)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ◉  nanoclaw                                            ⌘K                    ◐  D │
├────┬───────────────────────────────────────────────────────────────────────────────┤
│    │  Agent groups                                                  + new group    │
│ ⌂  ├───────────────────────────────────────────────────────────────────────────────┤
│ ⊞  │  GROUP            STATE   SESSIONS  LAST ACTIVE   PROVIDER   CONTAINER        │
│ ⊟  │  axie-dev         idle    0/3       2m ago        claude     nanoclaw-agent   │
│ ⚙  │  axis-labs        active  1/3       now           claude     nanoclaw-agent   │
│    │  dirt-market      idle    0/3       1h ago        claude     nanoclaw-agent   │
│    │  illysium         active  2/3       now           claude     nanoclaw-agent   │
│    │  madison-reed     active  1/3       now           claude     nanoclaw-agent   │
│    │  main             idle    0/3       4m ago        claude     nanoclaw-agent   │
│    │  number-drinks    idle    0/3       12m ago       claude     nanoclaw-agent   │
│    │  sunday           active  1/3       now           opencode   nanoclaw-agent   │
│    │  video-agent      blocked 1/3       waiting       claude     nanoclaw-agent   │
│    │  xerus            idle    0/3       18m ago       claude     nanoclaw-agent   │
│    │  xzo-demo-builder idle    0/3       2h ago        claude     nanoclaw-agent   │
│    │                                                                               │
└────┴───────────────────────────────────────────────────────────────────────────────┘
```

A real table — not a card grid. Sortable by clicking column headers. Selecting a row (`⏎`) opens the right inspector with: CLAUDE.md preview, channel wirings, MCP tools enabled, container config, last 10 sessions. Editing CLAUDE.md is in v2 — for now, the inspector is read-only with a "Open in editor" button that copies the path.

Density target: 11 rows fit above the fold at 1440×900 with room to breathe.

### 2.4 Tasks view with Inspector open

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ◉  nanoclaw                                            ⌘K                    ◐  D │
├────┬─────────────────────────────────────────────┬───────────────────────────────┤
│    │  Tasks                       [All ▾] [Owner]│  Refactor checkout to SKU map  │
│ ⌂  ├─────────────────────────────────────────────┤  madison-reed · ◐ running · 3m │
│ ⊞  │┌───────────────────────────────────────────┐│  ──────────────────────────── │
│ ⊟  ││ • Needs you · 3                           ││                               │
│ ⚙  ││ ●  illysium  Approve write...   [Approve] ││  RUN INFO                     │
│    ││ ●  axie-dev  Question...        [Answer]  ││  Started   11:42 PM           │
│ ─  ││ ✕  axie-dev  Vercel deploy      [Retry]   ││  Elapsed   00:03:18           │
│    │└───────────────────────────────────────────┘│  Tokens    142k in / 8k       │
│ ◉  │                                             │  Cost      $0.41              │
│ ●  │  ▾ · Running · 6                            │                               │
│ ◉  │  ◐  madison-reed   Refactor… selected ▶    │  ARTIFACTS                    │
│ ◉  │  ◐  number-drinks  Daily revenue digest    │  ⎘ branch diff                │
│ ◉  │  ◐  axis-labs      Migrate analytics       │  ⎘ test output                │
│ ◉  │  ◐  sunday         Flaky test investigate  │                               │
│ ◉  │  ⏸  video-agent    Render weekly recap     │                               │
│ ◉  │  ◐  xerus          Index repo              │  ⏎ open in detail             │
└────┴─────────────────────────────────────────────┴───────────────────────────────┘
```

The Inspector is a 320px right panel — same `<Inspector>` component used on Agents view. On Tasks view it shows the selected row's detail (without leaving the list); ⏎ opens the row in `/tasks/:id`. The Inspector and the Task Detail right metadata column are the *same* component (one variant `task` for both contexts). Toggle with `i`. Closing returns focus to the originating row.

### 2.5 Settings (`/settings`)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ◉  nanoclaw                                            ⌘K                    ◐  D │
├────┬───────────────────────────────────────────────────────────────────────────────┤
│    │  You                                                                          │
│ ⌂  │  ─────                                                                        │
│ ⊞  │  Owner          slack:U073KQH6Q  ·  discord:dave#3471                         │
│ ⊟  │  DM channel     slack                                                         │
│ ⚙  │                                                                               │
│    │  Channels                                                                     │
│    │  ────────                                                                     │
│    │  slack          connected   workspace illysium     ◉ healthy                  │
│    │  discord        connected   2 servers              ◉ healthy                  │
│    │  telegram       connected   @dave_bot              ◉ healthy                  │
│    │  github         connected   davekim917             ◉ healthy                  │
│    │                                                                               │
│    │  Runtime                                                                      │
│    │  ────────                                                                     │
│    │  Container       docker 27.4 · nanoclaw-agent:latest                          │
│    │  OneCLI          1.3.0  ·  gateway healthy                                    │
│    │  Memory (host)   118 MB  ·  uptime 4d 11h                                     │
│    │  Database        v2.db · 14 MB · last sweep 12s ago                           │
│    │                                                                               │
│    │  Theme           ◉ Dark   ◯ Light   ◯ System                                  │
└────┴───────────────────────────────────────────────────────────────────────────────┘
```

A long single page, sectioned by horizontal rule + heading. Rule: **Settings never grows beyond a single 1080p viewport**. If a fifth section is needed, something else gets cut or pushed to its own skill flow. Editable settings are inline; structural settings (channel wiring) link out to the existing skill flows (`/customize`, `/manage-channels`).

---

## 3. Visual System

### Typography

One family. **Geist Variable** for body and chrome, with `font-feature-settings: "tnum", "cv11"` enabled — `tnum` (tabular numbers) is required because timestamps, durations, and message counts are everywhere. Code blocks use `JetBrains Mono`. Geist over Inter: same UI density credentials, slightly more identity, ships with a closer-to-monospace numeric set when `tnum` is on.

| Token | Size | Weight | Line height | Tracking | Use |
|---|---|---|---|---|---|
| `text-xs` | 11px | 500 | 16px | +0.01em | Metadata, timestamps, group tags |
| `text-sm` | 13px | 450 | 20px | 0 | Body, list rows, labels |
| `text-base` | 14px | 450 | 22px | 0 | Transcript prose |
| `text-md` | 15px | 550 | 22px | 0 | Section headers |
| `text-lg` | 18px | 600 | 26px | -0.01em | View titles |
| `text-xl` | 22px | 650 | 30px | -0.015em | Empty-state headlines |
| `mono` | 12.5px | 450 | 20px | 0 | Code, paths, IDs |

Scale ratio averages 1.18, tight on purpose. No display fonts. No fluid clamping. Headings sit on the same baseline grid as body.

### Color — OKLCH tokens, dark primary

Neutrals tinted toward a cool blue (`hue 250`, chroma 0.005). Not gray, not slate, not pure black. Light theme is a mirror of the same tokens, not a separate palette.

| Token | Dark (OKLCH) | Light (OKLCH) | Use |
|---|---|---|---|
| `bg` | `0.14 0.005 250` | `0.99 0.003 250` | Page background |
| `bg-elev` | `0.17 0.006 250` | `0.97 0.004 250` | Sidebar, top strip, **Needs You band** |
| `bg-sunken` | `0.12 0.004 250` | `1.00 0.002 250` | Nested wells, code blocks |
| `border` | `0.24 0.008 250` | `0.91 0.005 250` | Hairlines |
| `border-strong` | `0.32 0.010 250` | `0.84 0.007 250` | Active borders, focus |
| `fg` | `0.96 0.005 250` | `0.18 0.006 250` | Primary text |
| `fg-muted` | `0.70 0.008 250` | `0.42 0.008 250` | Secondary text |
| `fg-faint` | `0.50 0.008 250` | `0.58 0.008 250` | Tertiary, timestamps, stale-state |
| `accent` | `0.78 0.16 245` | `0.55 0.18 245` | Single accent — selection, focus, primary action |
| `success` | `0.78 0.13 155` | `0.50 0.16 155` | ✓ completed |
| `warning` | `0.82 0.14 75` | `0.62 0.17 75` | Needs attention |
| `danger` | `0.70 0.16 25` | `0.52 0.19 25` | Failed, error |

Total accent surface coverage stays under 8%. Saturated color is for status semantics, not decoration. Hover is a 4–6% lightness lift on background, never a color swap. Each agent group has its own dot color in the rail (a muted hue from a curated 11-color palette derived from the OKLCH chroma scale; assignment is stable).

### Spacing scale

Multiples of 4px. `0, 1=4, 2=8, 3=12, 4=16, 5=20, 6=24, 8=32, 10=40, 12=48, 16=64`. Sections rest on `6` between, rows on `1.5` (6px) within. Needs You band rows sit at row-height × 1.25 (10px vertical padding instead of 8) to give the band physical weight.

### Border radius

`0, 2px, 4px, 6px, 999px (pill)`. Cards round at 6, inputs at 4, the avatar pill at 999. Nothing rounds at 8+.

### Elevation

Two shadows total, both **tinted** to carry the cool-blue chroma rather than neutral black:

- `shadow-sm`: `0 4px 16px oklch(0.05 0.005 250 / 0.45)` — inspector panel, command palette
- `shadow-md`: `0 12px 32px oklch(0.05 0.005 250 / 0.55)` — palette dropdown over the palette

No elevation on rows, cards, or buttons. Light-theme shadows use the same hue at lower lightness/alpha (`oklch(0.40 0.005 250 / 0.18)`).

---

## 4. Component Inventory

| Primitive | Variants | Notes |
|---|---|---|
| `<StatusGlyph>` | running (◐), paused (⏸), blocked (⏸), complete (✓), failed (✕), waiting-on-you (●) | Single character rendered in semantic color. Always 12px. The breathing variant (1Hz rotation) renders only when the agent has an in-flight tool call. |
| `<GroupTag>` | inline-row (3-letter chip), rail-dot (1-color dot), rail-dot-active (1.5× + ring) | Inline: 3-letter abbreviation, monospace, `bg-sunken` chip with 1px border, hover reveals full name. Rail: a 6px colored dot, hover expands rail to show full name. Active variant scales to 9px with a 1px `accent` ring. |
| `<RailIcon>` | default, active | Phosphor icon (House, SquaresFour, Stack, Gear) at 16px stroke 1.5. Active variant: `accent` color + 1px left border in `accent` flush to rail edge + `aria-current="page"`. |
| `<Button>` | primary, destructive, secondary | Primary: filled `accent`, white-on-accent text, used at most once per row (e.g., `[Approve]`). Destructive: filled `danger`, used for irreversible actions (`[Retry]` on a failed task is destructive only if it re-runs side effects; otherwise secondary). Secondary: text-only `fg-muted` with hover underline. All buttons get `:active` press feedback (see §5). |
| `<TaskRow>` | default, hover, selected, focused, needs-you (in band) | Single line, glyph-tag-title-status-actions. Selectable with arrow keys. |
| `<NeedsYouBand>` | default | Wraps the Needs-You section in `bg-elev` full-bleed panel under the filter row. No disclosure caret. Never collapses. |
| `<SectionHeader>` | default, empty, persistent (Needs you) | Sentence case, `text-md` weight 550, leading `accent` dot, thin disclosure caret. Empty section dims the count and disables the caret. Persistent variant has no caret and never collapses. |
| `<MessageBubble>` | user, agent, system | No actual bubble — just a left-aligned avatar character + name + indented body. |
| `<ToolCallGroup>` | collapsed, expanded | "ran 3 tools ▾" header, list of `verb · args` rows, inline output with truncation. |
| `<ToolCallTicker>` | running | Single replacing line above the composer when an agent has an in-flight tool call. `◐ running: <verb> · <args> (<elapsed>)`. Replaces itself; never scrolls. |
| `<CodeBlock>` | inline, block | Mono, `bg-sunken`, hover reveals copy button at right edge. Six-color muted syntax theme. |
| `<CommandPalette>` | navigation, action, search | One component, three modes by leading character: nothing = navigation, `>` = action, `?` = search. |
| `<Inspector>` | task, agent | Right-side 320px panel. Slides from `translateX(8px) opacity-0` to home. Same component used as the Task Detail right column. |
| `<Composer>` | steer | Auto-growing textarea, no toolbar. Returns its own keyboard shortcut hints under the box. |
| `<Toast>` | success, info, error | Bottom-right, 4s linger, max one at a time. Stack of two if a second arrives. |
| `<Avatar>` | owner only | A single character on a 28px **squircle** (border-radius 8px on a 28px element), `bg-elev`, no image. There is one user. |
| `<KbdHint>` | inline | `<kbd>⌘K</kbd>` rendered as 11px mono, 1px border, 4px radius. |
| `<EmptyState>` | tasks-zero, agents-zero, search-zero | A single line of secondary text plus one keyboard hint. No illustration. No graphic. |
| `<ConnectionState>` | live, reconnecting, offline | Top-strip dot + optional one-line `bg-elev` banner under the strip. See §5 loading states for behavior. |

Anti-inventory (deliberately not built): cards-with-icon-and-heading, hero metric tiles, decorative dividers, animated illustrations, badge stacks, gradient buttons, drop-cap headings, **progress bars** (the duration string + breathing glyph carry the signal).

---

## 5. Interaction Patterns

### Keyboard shortcuts — the spine

For four primary destinations, single-press keys (Cmd-1..4) beat chords. Reserve `g <letter>` for the eleven agent groups, where chords actually pay for themselves.

| Keys | Action | Scope |
|---|---|---|
| `j` / `k` | next / previous row | List views |
| `⏎` | open selected | List views |
| `Esc` | close inspector or return to list | Detail / inspector |
| `⌘1` / `Ctrl-1` | go to Tasks | Global |
| `⌘2` / `Ctrl-2` | go to Agents | Global |
| `⌘3` / `Ctrl-3` | go to Settings | Global |
| `g i` | jump to illysium tasks | Global |
| `g a` | jump to axie-dev tasks (then `axis-labs` on second press, etc. — disambiguates by frequency) | Global |
| `g <letter>` | jump to agent group whose name starts with that letter; second press cycles through ties | Global |
| `/` | focus filter input | Tasks, Agents |
| `i` | toggle inspector | Tasks, Agents |
| `m` | toggle metadata column | Task detail |
| `r` | retry failed task | Task row, Task detail |
| `p` | pause running task | Task row, Task detail |
| `a` | approve waiting request | When focus is on a Needs-You row |
| `⌘K` / `Ctrl-K` | command palette | Global |
| `⌘⏎` / `Ctrl-⏎` | send + pause | Composer |

The palette's grammar is Raycast-shaped: type to filter, ⏎ to run, ⇧⏎ to run in a new tab if relevant. `>` switches to actions only (kill task, restart container, open logs). `?` switches to full-text transcript search.

### Click vs hover, press feedback

Clicks select, double-clicks open. Hover reveals: row actions (right-aligned, fade-in over 80ms), copy buttons on code blocks, full names on group tags. Hover never reveals destructive actions; those are always visible or behind a confirm.

**Press feedback** (the missing :active state): all buttons and clickable rows get `transform: translateY(1px)` on `:active`, with a 60ms ease-out return. This is the physical-click cue that separates a tool from a slide deck. Keyboard equivalents (`⏎` on a focused row) get the same feedback for one frame so the keyboard path doesn't feel ghostly.

### Focus management and accessibility

A visible focus ring is mandatory: 2px `accent` outline at 2px offset on `bg`. Clicking does not blur the focused row — keyboard users can mouse without losing their place. Opening the inspector sets focus to the inspector header; closing it returns focus to the originating row.

**Accessibility primitives** (non-negotiable):
- **Skip-to-content link**: visually hidden by default, becomes visible on first `Tab`, jumps focus past the rail and top strip directly to the main content region. Required for keyboard-only operators.
- **`aria-current="page"`** on the active rail icon and `aria-current="true"` on the active agent-group dot. Screen readers announce the current location without requiring sighted context.
- **`aria-live="polite"`** on the connection-state banner and the toast container. Status changes (Reconnecting, Offline, task-complete toast) reach screen readers without stealing focus.
- **`role="status"`** on the per-row tool-call ticker so screen readers can opt into hearing it without it being announced on every tick.
- **All interactive elements reachable by keyboard** — palette → list → row → action button → composer, in a logical Tab order that mirrors visual reading order.

### Per-row tool-call activity

The single biggest "is this thing alive" question for a long-running task. Resolution:

- The `<StatusGlyph>` for a running task is `◐`. When the agent has an in-flight tool call (verified via session state, not heartbeat), the glyph rotates at 1Hz: ◐ ◓ ◑ ◒ ◐. When no tool call is in flight (agent is reasoning, or between calls), the glyph is static `◐`.
- In the task detail view, the ToolCallTicker (single line above the composer) shows the active tool with elapsed time. It replaces itself rather than streaming into the transcript.
- This means a long bash/test run is visibly working from the row in the list AND from the task detail, without polluting the transcript.

### Loading and connection states

- **Initial load**: skeleton rows for the Tasks view (8 rows of `bg-sunken` with shimmer-free dim pulse).
- **Per-row updates**: animate the status string only — never the whole row.
- **SSE drop / reconnecting**: connection dot in top strip flips to amber. List rows fade to 70% opacity. Each row's status string suffixes with `(stale)` in `fg-faint`. A one-line `bg-elev` banner appears under the top strip: `Reconnecting…`. No modal. No layout shift. Reconnection is automatic with backoff 1s → 2s → 5s → 5s.
- **Offline (reconnect failed)**: dot turns red. Banner becomes `Offline — last update <Xm ago>`. Steer composer disables (queue-on-reconnect is v2). Existing data stays visible (don't blank the screen).
- **No spinner**: a spinning glyph appears nowhere.

### Empty and not-found states

- **Tasks empty**: *"No tasks running. Start one from Slack, or press ⌘K → New task."* Single line, secondary text, one kbd hint.
- **Search empty**: *"Nothing matches. Try a group name or status."*
- **Task not found** (`/tasks/:id` for a deleted or non-existent ID): *"That task doesn't exist or was deleted."* + a `← Back to Tasks` text link. Uses `<EmptyState>` with the `tasks-zero` variant and a `not-found` modifier for the copy.
- **Route not found** (any other unmatched path): same shape, copy *"That page doesn't exist."* + Tasks link. No branded 404 illustration.

### Real-time

Server-Sent Events from the host: `task.started`, `task.progress`, `task.tool_started`, `task.tool_finished`, `task.message`, `task.completed`, `task.failed`, `approval.requested`. The client maintains a single EventSource; the dashboard re-renders only the affected rows via fine-grained subscription. Target: <250ms from DB write to pixel update.

### Motion discipline

- Inspector slide-in: 180ms ease-out-quart, opacity + 8px X-translate. That's it.
- Row enter (new task arrives): 120ms fade in, no slide. New rows do not push existing rows around — they insert at the section's top with a 1-frame highlight on the `accent` color, decaying over 600ms.
- Section collapse/expand: height transitions are banned. Use `display: grid; grid-template-rows: 0fr | 1fr` transition.
- Breathing glyph (tool-call activity): 1Hz, no easing, immediate visual response when state changes.
- No celebratory motion on completion. ✓ appears, the row reorders. That is the celebration.

---

## 6. What We Explicitly Do Not Build

A short, opinionated kill list. Each is a thing a Linear-fluent designer would propose by reflex; each was rejected for a specific reason.

1. **No notifications panel or bell icon.** Slack is the notification channel — that's the whole point of NanoClaw. A second notification surface fragments attention. The Needs You band at the top of Tasks is the only attention anchor.

2. **No card grid for agent groups.** A grid of eleven identical cards is impeccable's "identical card grids" ban applied directly. Agents are rows in a sortable table because they are a list of similar things, and tables beat cards for that.

3. **No analytics view, no cost ticker.** No charts of "messages per day," "tasks completed this week," "token spend over time," and no top-strip "tokens today / cost today" line. Single-operator vanity metrics. If Dave wants a number, he can ask in chat or check the OneCLI dashboard.

4. **No drag-and-drop reordering of tasks.** Order is determined by status section then last-activity. User-controlled order is a feature for shared tools where order is a social signal. Here it would just be a way to lie to himself about priority.

5. **No multi-select bulk actions on tasks.** "Pause 5 tasks at once" sounds powerful and is almost always a mistake. Force one-at-a-time. If it becomes a real pain, revisit, but only then.

6. **No theme customization beyond dark / light / system.** No accent picker, no font-size slider, no density toggle. The design has one density. Chrome already has zoom.

7. **No in-app onboarding tour, tooltip layer, or "what's new" panel.** Dave built the system. Onboarding is the README. Changelogs live on GitHub.

8. **No inline editing of CLAUDE.md or per-group config in v1.** The dashboard is read + steer, not author. Authoring still belongs to the editor and the existing skills (`/customize`, `/manage-channels`).

9. **No progress bars on task rows.** Stepped 7-cell bars read as 1990s shareware. The duration string + breathing glyph carry the "alive vs stuck" signal more honestly.

10. **No separate Failed section.** Untriaged failures appear in Needs You (they require Dave's attention). Acknowledged failures move to Completed with a `✕` glyph. Failed-as-section duplicates the Needs You attention anchor and weakens both.

11. **No Settings page that grows beyond a 1080p viewport.** Adding a fifth section means cutting something else or pushing to a skill flow. The hard cap forces discipline.

---

## 7. Implementation Posture

- **Stack.** Vite + React + TypeScript. `react-router` for routing, `tanstack/query` for SSE-fed cache, `clsx` and `class-variance-authority` for variants. No UI kit — Radix primitives where accessibility is non-trivial (palette, inspector, listbox), hand-built everything else. No Tailwind UI templates. No shadcn block dumps.
- **Fonts.** `geist` (Geist Variable) + `geist/mono` for `JetBrains Mono`-equivalent monospace, OR self-hosted Geist Variable + JetBrains Mono Variable from `@fontsource-variable/*` to avoid runtime fetches.
- **Icons.** `@phosphor-icons/react` (regular weight, stroke 1.5) for chrome icons (rail, palette, button trailing). Status glyphs (`◐ ⏸ ✓ ✕ ●`) stay as unicode characters in semantic-colored spans — they're glyphs, not icons.
- **Styling.** CSS variables for the OKLCH tokens, vanilla CSS modules per component. Use `min-height: 100dvh` (not `100vh`) for any full-screen panel — iOS Safari viewport bug.
- **Memory.** Vite's production bundle for this surface area lands well under the 100–150MB target. Skip framer-motion (use Web Animations API for the two motions that need it). Skip moment / dayjs (use `Intl.RelativeTimeFormat`).
- **Static assets.** Branded favicon (16/32/180 + SVG), no other graphics. No social-share Open Graph tags — the dashboard is localhost-only and never linked externally.
- **Server.** A new `src/dashboard/` module on the host: a small Node `http`-based server (mirrors the existing `src/webhook-server.ts` / `src/channels/chat-sdk-bridge.ts` pattern; `undici` is client-only and was wrongly cited in the prior revision). One SSE endpoint, ~8 JSON endpoints, plus a static handler for the built bundle. Runs on `127.0.0.1:7457` by default.
- **Auth.** Three layers, applied to **every** API endpoint (read AND mutating):
  - Bind to `127.0.0.1` only, never `0.0.0.0`.
  - Random bearer token generated at host startup (stored at `data/dashboard-token`, printed once to setup logs). The dashboard's first load shows a minimal `/login` page accepting the token; on success, the host issues a session cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`). All subsequent JSON and SSE requests authenticate via the cookie. The bearer token is also accepted via `Authorization: Bearer …` for non-browser clients.
  - `Origin` header allowlist (`http://127.0.0.1:7457` only) AND `Host` header allowlist (`127.0.0.1:7457` only) on every request. Defeats DNS rebinding; combined with `SameSite=Strict` cookie, satisfies OWASP CSRF defense-in-depth.
  - Static asset serving (the SPA bundle) is the only unauthenticated surface — no data exposed there.
  See `design.md` §Dashboard for full rationale (closes review M3 / cycle-2 M6 / M7).

---

## 8. Open questions / deferred decisions

- **OQ-UI-1**: Light theme. The OKLCH palette has both, but the design is dark-primary. Light theme tokens are spec'd but not visually validated. Will need a 20-minute pass when implementation reaches a working build.
- **OQ-UI-2**: `g <letter>` collision handling. With agent groups starting with `a` (axie-dev, axis-labs), `m` (madison-reed, main), the second-press cycle behavior may feel weird. Validate in build with a real keyboard test before locking it in.

---

## Notes

This spec was produced via the `/impeccable` skill (one-shot, locked decisions) and then hardened by an external audit that ran the `/bootstrap-domain:jony-ive` lens. PRODUCT.md and DESIGN.md don't yet exist in the repo. If/when this dashboard moves to implementation, the right next step is `/impeccable teach` to commit PRODUCT.md + DESIGN.md from this spec, then `/impeccable craft` for the build phase.
