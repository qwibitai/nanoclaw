# Daily Note Fleeting Notes Format

This file defines the format for fleeting notes sections in daily notes.

## Structure

```markdown
## Fleeting Notes (appended {YYYY-MM-DD} ~{HH:MM} {TZ})

### Unprocessed ({count} from {source})

1. **{Item title}** ({YYYY-MM-DD}) [[Fleeting/{year}/{month}/{day}/{slug}|f-note]]
   **Notes:** {verbatim text, if short}
   **Summary:** {AI summary in 2 lines, if long}
   **Chat summary:** {summary of prior chat exchanges, if any}
   **Proposed:** {AI routing proposal}
   - [ ] Accept
   - [ ] Retire
   **Chat:**
   **Response:**

**Bulk Response:**

### Routed

- **{Item title}** → {description} — [[...|f-note]] → [[...|pr-note]] → [[...|todos]]
```

## Rules

### Item format
- Numbered list (`1.`, `2.`, etc.)
- All sub-content (Notes, Summary, Proposed, checkboxes, Response) indented with **4 spaces**. This ensures consistent alignment for both single-digit (`1.`) and double-digit (`10.`) items. Never use 3-space indentation.
- Title in bold: `**{title}**`
- Date in parentheses: `({YYYY-MM-DD})`
- Link to fleeting note file using short symbol: `[[Fleeting/{year}/{month}/{day}/{slug}|*]]`
  - The `|*` alias renders as a clickable `*` in Obsidian reading mode — minimal but navigable
  - Every item MUST have a corresponding fleeting note file and a `[[...|*]]` link
- **Notes:** (bold) — verbatim text from the source, on the next line, indented. Used when the original is 2 lines or less.
- **Summary:** (bold) — AI-generated summary, kept to 2 lines max. Used when the original is longer than 2 lines. The fleeting note file (`[[...|*]]`) always has the full verbatim text.
- **Proposed:** (bold) — AI routing proposal on the next line, indented. Must be generated for every item at ingestion time (never left as "pending"). See **Routing proposal generation** below for the method.

### Routing proposal generation

Every unprocessed item MUST have a real routing proposal when it appears in the daily note. This is the AI's job at ingestion time — not a deferred step.

```gherkin
Feature: AI routing proposal generation

  Scenario: Generating a routing proposal for a fleeting note
    Given a fleeting note with title and optional notes/body
    And the project registry is available
    When the agent creates the daily note entry
    Then the **Proposed:** field MUST contain a concrete routing proposal
    And the proposal MUST NOT be deferred (e.g. "pending", "TBD")

  Scenario: Matching to a registered project
    Given a fleeting note with content
    When the agent generates a routing proposal
    Then the agent MUST consult the project registry (aliases, routing tags, descriptions)
    And if a project matches, state it explicitly: "Project {name}."
    And if no project matches, state: "No project match."

  Scenario: Proposing a conversion path
    Given a fleeting note matched (or not) to a project
    When the agent writes the proposal
    Then the proposal MUST include one of the conversion paths:
      | Path | When to propose |
      | #task (project note) | Action items, replies, to-dos, things to do |
      | Permanent note | Insights, reflections, atomic thoughts worth keeping |
      | Literature note + permanent note | Notes referencing external sources (URLs, articles) |
      | Idea log entry | Raw ideas not yet actionable |
      | Draft | Long-form creative content needing its own directory |
      | Retire | Stale items, duplicates, test items, items with no context |
    And if the item is clearly stale (date plan from weeks ago, completed chore), pre-check Retire

  Scenario: Ambiguous items
    Given a fleeting note where the routing is unclear
    When the agent writes the proposal
    Then the agent MUST still propose a best guess with reasoning
    And offer alternatives (e.g. "Retire if context is lost, or route to X if still relevant")
    And NEVER leave the proposal blank or deferred
```

**Proposal quality guidelines:**
- Start with the project name: "Project Networking." or "No project match."
- State the conversion path: "#task —", "Permanent note —", "Idea log entry —", "Retire —"
- Add a brief description of what would be created
- For stale items (created weeks ago with no context), pre-check `[x] Retire` as a suggestion
- For items with URLs, propose literature note unless context suggests otherwise
- For items that are clearly people-related actions (reply, talk to, invite), propose Networking #task

### Per-item action controls

After **Proposed:**, each item has two inline checkboxes and an individual response area:

```markdown
   - [ ] Accept
   - [ ] Retire
   **Response:**
```

- **Accept** — checking this tells the agent to execute the proposal as-is. No further input needed.
- **Retire** — checking this tells the agent to retire the note (mark as retired, no downstream notes created).
- **Response:** — free-text area for the user to give custom routing instructions for this specific item. Overrides both checkboxes if filled in. Used when the user wants something different from the proposal (e.g. route to a different project, create a permanent note instead, etc.).

Only one action per item: Accept, Retire, Response, or Chat. If multiple are filled in, **Chat** takes priority, then **Response**, then **Accept**, then **Retire**.

### Chat field (future feature)

```markdown
    **Chat:**
```

When the user's reaction to a note is not a routing decision but a question or conversation starter, they use the **Chat:** field instead of **Response:**.

```gherkin
Feature: Chat field for fleeting note conversation

  Scenario: User wants to discuss a note before routing
    Given an unprocessed fleeting note with a **Chat:** entry
    When the agent processes the daily note
    Then the agent creates an LLM response to the user's question/prompt
    And appends the conversation (user question + LLM response) to the fleeting note file
    And the fleeting note status remains "raw" (NOT updated to completed/retired)
    And the note continues to appear in Unprocessed on the next day
    And the user can then route it after seeing the LLM's response

  Scenario: Chat conversation accumulates over multiple days
    Given a fleeting note with an existing chat conversation
    And the user adds another **Chat:** entry in the daily note
    When the agent processes it
    Then the new exchange is appended to the fleeting note
    And the note remains unprocessed until explicitly routed
```

This separates two modes of interaction:
- **Response:** = routing decision (executes immediately, note moves to Routed)
- **Chat:** = conversation (LLM responds, note stays unprocessed for future routing)

### Bulk Response

After all numbered items, a **Bulk Response:** area allows the user to give routing decisions for multiple items at once (e.g. a voice transcript covering several notes). This is the original response mechanism.

```markdown
**Bulk Response:**
```

- Bulk Response applies to all items that don't already have an individual action (checkbox or per-item Response).
- If an item has an individual action AND appears in the Bulk Response, the individual action takes priority.

### Processing flow

The human response is recorded in two places:
- **Daily note** — the visible narrative record of what was decided (stays in the response area or gets captured in the Routed entry)
- **Fleeting note frontmatter** — the machine-readable outcome (`status`, `converted_to`, `project`)

When the agent processes responses (individual or bulk), it:
1. Reads each item's action: checked Accept, checked Retire, per-item Response, or Bulk Response
2. Creates a **routing session note** at `Fleeting/{year}/{month}/{day}/_routing-session-{NNN}.md`
   - Contains all human responses verbatim (both individual and bulk)
   - Table of all routing decisions: item, action source (accept/retire/response/bulk), decision, destination
   - Links to all affected fleeting notes and their destinations
3. Executes the routing (creates project/permanent/literature notes, updates fleeting note frontmatter)
4. Adds `routing_session:` to each fleeting note's frontmatter, linking back to the session note
5. Moves items from Unprocessed to Routed
6. Clears per-item **Response:** text and unchecks checkboxes (decisions now live in routing session note)
7. Adds a `[[...|*]]` link to the routing session note in the daily note
8. The Routed entry + routing session note serve as the permanent record of the decisions

### Sections
- **Unprocessed** — items awaiting triage. Header includes count and source.
- **Routed** — items that have been processed. Single-line format:

```markdown
- **{title}** → {description} — [[...|f-note]] → [[...|pr-note]] → [[...|todos]]
```

Each entry has:
  - Title in bold + arrow `→` + description (project name, routing type)
  - Em dash `—` separator
  - Link chain showing the full path from source to destination, using short labels:
    - `f-note` = fleeting note (source)
    - `pr-note` = project note
    - `pe-note` = permanent note
    - `l-note` = literature note
    - `todos` = project todos.md
  - Links use `→` between steps, `+` when multiple destinations (e.g. permanent + literature)
  - For retired items: only the `f-note` link (no destination)

Examples:
```markdown
- **Pedro reply** → Networking as #task — [[...|f-note]] → [[...|pr-note]] → [[...|todos]]
- **Hannibal on Ai** → AI Safety as permanent + literature note — [[...|f-note]] → [[...|pe-note]] + [[...|l-note]]
- **Apply?** → retired — [[...|f-note]]
```

### Movement
- Items move from Unprocessed to Routed as they are processed
- When an item is routed, it is removed from Unprocessed and appended to Routed
- The Unprocessed count is updated
- This gives a visual sense of flow in the daily note

### Carryover
- Unprocessed items carry forward to the next day's daily note until they are routed
- Each day's Fleeting Notes section shows BOTH:
  - New fleeting notes added that day (from Things Today or other sources)
  - Previously unprocessed fleeting notes from prior days that still haven't been routed
- The source of truth for what's unprocessed is the fleeting note frontmatter (`status: raw`)
- Items do not disappear just because a new day starts — they repeat until acted on

### Fleeting note link requirement
- Every item in the daily note MUST link to a fleeting note file via `[[Fleeting/{year}/{month}/{day}/{slug}|*]]`
- The fleeting note file is the ground truth for the item
- If no fleeting note file exists yet, one must be created before the item appears in the daily note

### Fleeting note content completeness

Constraints use Gherkin format where appropriate.

```gherkin
Feature: Fleeting note ingestion from Things

  Scenario: Ingesting a Things item with both title and notes
    Given a Things item with a non-empty "title" field
    And the Things item has a non-empty "notes" field
    When the item is ingested as a fleeting note
    Then the fleeting note heading MUST contain the full title verbatim
    And the fleeting note body MUST contain the full notes text verbatim
    And neither title nor notes may be truncated or omitted

  Scenario: Ingesting a Things item with title only
    Given a Things item with a non-empty "title" field
    And the Things item has an empty "notes" field
    When the item is ingested as a fleeting note
    Then the fleeting note heading MUST contain the full title verbatim
    And the body may be empty

  Scenario: Daily note summary references fleeting note content
    Given a fleeting note with body content
    When creating the daily note entry
    Then the Notes/Summary field MUST reflect the full content (title + body)
    And the fleeting note link provides access to the complete verbatim text
```

Implementation note: Things CLI `--format json` output includes a `notes` field. Always use JSON format when ingesting to capture both `title` and `notes`. The default table view omits notes.

### Things lifecycle

When a Things item is ingested as a fleeting note in Obsidian, it must be marked as completed in Things. The three places fleeting notes exist:

1. **Things** — the capture source (where the note originates)
2. **Obsidian fleeting note file** — the ground truth (`Fleeting/{year}/{month}/{day}/{slug}.md`)
3. **Obsidian daily note** — the visible summary surface

```gherkin
Feature: Things item completion on ingestion

  Scenario: Things item is ingested as a fleeting note
    Given a Things item in Today (or being processed from Ingested)
    When the item is ingested and a fleeting note file is created in the vault
    Then the Things item MUST be marked as completed
    And the fleeting note file is now the source of truth for the item
    And the Things item serves only as an origin record

  Scenario: Things item already has a fleeting note
    Given a Things item whose UUID matches an existing fleeting note
    And the fleeting note has status "raw", "completed", or "retired"
    When the sync runs
    Then the Things item MUST be marked as completed if it is not already
    And no duplicate fleeting note is created
```

Implementation note: `things update --id <UUID> --completed` requires a Things auth token. Run `things auth` or set `THINGS_AUTH_TOKEN` environment variable. See Things > Settings > General > Things URLs.

### Integrity checks (post-processing)

After processing a batch of routing decisions, run these checks:

```gherkin
Feature: Fleeting notes pipeline integrity

  Scenario: No orphan completed notes
    Given all fleeting notes have been processed
    When an integrity check runs
    Then every note with `status: completed` MUST have a `converted_to:` field
    And the file referenced by `converted_to:` MUST exist on disk
    And the destination note MUST have a `fleeting:` field pointing back

  Scenario: No raw notes remain after batch processing
    Given a batch of routing decisions has been executed
    When the batch is fully processed
    Then zero fleeting notes should have `status: raw`
    And the daily note Unprocessed count should be 0

  Scenario: Case-consistent paths
    Given a destination note is created
    When the directory path is constructed
    Then directory names MUST use lowercase (e.g. `notes/`, not `Notes/`)
    And this MUST match the wiki link path exactly
    And case mismatches will break on case-sensitive filesystems (Linux containers)
```

**Known issue (2026-03-07):** 8 orphan notes found with `status: completed` but missing `converted_to:`. Root cause: batch processing in earlier sessions marked status without adding the link field. Fixed retroactively. The checks above prevent recurrence.

### Append behavior
- Start new sections with `---` separator
- Section headers include a timestamp of when the append happened
- If updating an existing section, add `updated ~{HH:MM} {TZ}` to the header
- Never rewrite or delete existing content — only append and move between sections
