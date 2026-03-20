---
name: literature-monitoring
description: >
  Weekly scan for new papers matching researcher interests. Searches academic
  APIs, produces a tiered reading list in literature/, and updates the queue.
---

# Literature Monitoring

Scheduled weekly (Monday mornings). Searches for recent papers relevant to the researcher's interests and produces a tiered reading list.

## Process

1. **Read researcher context:**
   - `mcp__mcpvault__read_note` on `_meta/researcher-profile.md` for research interests, methods, and domain keywords
   - `mcp__mcpvault__read_note` on `_meta/top-of-mind.md` for current priorities (weight results toward active concerns)

2. **Search for recent papers:**
   - Use web search to query Semantic Scholar API and OpenAlex for papers published in the last 7-14 days
   - Search terms derived from: researcher interests, active project topics, and top-of-mind priorities
   - Cast a wide net (multiple queries), then filter aggressively
   - Target 15-30 candidate papers before filtering

3. **Filter and tier:**
   - **Must-Read** (2-5 papers): Directly relevant to active projects or top-of-mind priorities. The researcher would want to know about these immediately.
   - **Should-Read** (3-8 papers): Relevant to broader interests, useful methods, or adjacent fields. Worth reading within the month.
   - **Skim** (remainder): Peripherally relevant. Abstracts are enough unless something catches the researcher's eye.

   Filtering criteria: relevance to researcher's specific work (not just the field broadly), methodological novelty, publication venue quality, recency.

4. **Write the weekly note** — `mcp__mcpvault__write_note` to `literature/weekly-YYYY-WNN.md`:

   ```yaml
   ---
   week: YYYY-WNN
   generated: 'YYYY-MM-DD'
   papers_found: <N>
   must_read: <N>
   ---
   ```

   Body structure:
   - `# Literature Monitor — Week NN, YYYY`
   - For each tier, list papers with: **Title** (linked if URL available), Authors (first author et al.), Venue/preprint, and a 1-2 sentence note on why it's relevant *to this researcher specifically*.
   - End with `## Connections to Active Work` — brief notes on how any must-read papers relate to current projects.

5. **Update the reading queue** — `mcp__mcpvault__read_note` on `literature/queue.md`, then append must-read papers via `mcp__mcpvault__write_note` (append mode) or `mcp__mcpvault__patch_note`.

6. **Add must-read papers to Zotero** — for each Must-Read paper:
   - Check if already in Zotero via `zotero-cli search "<title>"` (avoid duplicates)
   - If not present, call `zotero-cli add --title "..." --authors "..." --doi "..." --collection "To Read" --note "<relevance note from step 4>"` with the same relevance explanation written in the weekly report
   - If `zotero-cli` fails (network, auth), skip this step and note the failure — do not abort the rest of the skill

7. **Report back** — Brief summary: "Found N papers this week. M are must-reads." Highlight the single most important paper and why.

## Quality bar

- Every paper must be real and verifiable — don't hallucinate citations
- Relevance notes must be specific to *this* researcher, not generic ("relevant to content moderation" is useless; "uses the same community-level ABM approach as your community-sorting project" is useful)
- Must-Read tier should be genuinely urgent — if nothing qualifies, say so rather than inflating the tier
- Don't repeat papers from previous weeks — check recent weekly notes

## What not to do

- Don't include papers older than 30 days unless they were missed in prior weeks
- Don't pad the list with tangentially related papers to look comprehensive
- Don't include papers the researcher has already cited (check `literature/notes/` for existing entries)
- Don't generate the note if no relevant papers were found — just report "quiet week"
