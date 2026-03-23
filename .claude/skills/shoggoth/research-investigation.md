---
name: research-investigation
description: >
  Deep investigation of a research idea using sub-agents for literature
  search, conceptual framing, and methodology. Only runs on explicit
  researcher confirmation. Produces a structured investigation note.
---

# Research Investigation

A thorough exploration of a research idea, combining literature search, conceptual framing, and methodological analysis. This is an expensive operation — multiple sub-agents, API calls, and extended reasoning. Never run without explicit confirmation from the researcher.

## Prerequisites

- An idea to investigate (usually from an `ideas/` note or a conversation)
- Explicit researcher confirmation ("yes, investigate this" or equivalent)
- The idea should be substantive enough to warrant investigation — a vague interest doesn't justify the cost

## Process

1. **Read context:**
   - `mcp__mcpvault__read_note` on `_meta/researcher-profile.md` for methods, interests, career stage
   - `mcp__mcpvault__read_note` on `_meta/top-of-mind.md` for current priorities
   - If the idea originated from an existing note, read it via `mcp__mcpvault__read_note`

2. **Spawn sub-agents** (via NanoClaw agent teams) for parallel work:

   **Literature agent:** Search for relevant papers using web search and academic databases. Find 10-20 relevant papers spanning:
   - Direct precedents (who has studied this question?)
   - Methodological exemplars (who has used similar methods on adjacent questions?)
   - Theoretical foundations (what frameworks apply?)
   - Recent work (last 2 years, to establish the frontier)

   **Framing agent:** Develop 2-3 theoretical framings for the idea, drawing on the researcher's known expertise and methods. Each framing should identify: the core question it asks, what theory it draws on, what it would contribute if successful, and what data/methods it requires.

   **Methods agent:** For each framing, assess feasibility given the researcher's resources (simulation platforms, available data, collaborator network). Identify the most tractable path to a publishable contribution.

3. **Synthesize** — Combine sub-agent outputs into a single investigation note.

4. **Write the investigation** — `mcp__mcpvault__write_note` to `ideas/YYYY-MM-DD-slug.md` (update existing note if one exists, or create new):

   Body sections:
   - `# [Title]: Research Investigation`
   - `## Literature Landscape` — What exists, what's missing, where the gap is. Cite specific papers with author-year.
   - `## Theoretical Framings` — 2-3 angles, each with core question, theoretical basis, expected contribution, and requirements.
   - `## Feasibility Assessment` — Which framing is most tractable? What does the researcher already have (data, tools, collaborators)? What's missing?
   - `## Recommended Next Steps` — 3-5 concrete actions, ordered by priority. First step should be achievable in a single work session.
   - `## Papers to Read` — Prioritized list: Must-Read (3-5), Should-Read (5-8), Background (rest). Include titles and one-line relevance notes.

5. **Update the idea's frontmatter** — `mcp__mcpvault__update_frontmatter` to change `status: spark` to `status: investigated` and add `investigated: 'YYYY-MM-DD'`.

6. **Update the registry** — Move the idea from "spark" to "investigated" in `ideas/_registry.md`.

7. **Report back** — Summarize key findings conversationally. Highlight the most promising framing and the immediate next step.

## Quality bar

- Literature citations must be real papers (verify via web search, don't hallucinate)
- Framings must connect to the researcher's actual methods and expertise
- Feasibility must be honest — don't oversell tractability
- Next steps must be concrete enough to act on without further planning

## What not to do

- Don't run without explicit confirmation
- Don't hallucinate paper citations — if you can't find relevant literature, say so
- Don't recommend methods the researcher has no experience with unless you flag the learning curve
- Don't overwrite the original idea note without preserving the raw capture
