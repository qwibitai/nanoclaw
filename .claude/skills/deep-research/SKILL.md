---
name: deep-research
description: Conduct deep research from a single prompt — collects 200+ sources, writes a structured markdown report with citations, deploys to GitHub, then runs citation QA and document optimization. Triggers on "deep research", "research report", "write a research report", "investigate and write", "/deep-research".
---

# Deep Research

From a single prompt, this skill runs the full research pipeline:

1. **Research** — collect 200+ reputable sources via web search and content extraction
2. **Write** — produce a structured 400+ line markdown report with inline citations
3. **Deploy** — commit the report to a specified GitHub repo and folder
4. **Citation QA** — verify every link works, check citation accuracy, fix discrepancies
5. **Optimize** — compress the document 50% using clearer, shorter sentences and quantitative framing
6. **Final commit** — push the polished, verified report

**Principle:** Do not rush. Each phase must fully complete before the next begins. Quality over speed — the value is in the rigor, not the pace.

## Phase 0: Collect Inputs

Before starting, confirm the following with the user (if not already provided in the prompt):

- **Topic or URL** — the subject to research, or a specific article/paper as a starting point
- **Target GitHub repo** — where to write the report (e.g., `aslesarenko/ai-agents-platform`)
- **Output folder and filename** — where inside the repo (e.g., `research/lethal-trifecta-mitigations.md`)
- **Report title** — used as the H1 heading

Acknowledge receipt and send a brief plan to the user before starting:

> Starting deep research on: {topic}
> Target: {repo}/{path}
> I'll work through 6 phases and keep you updated at each milestone.

## Phase 1: Source Collection

**Goal: Collect at minimum 200 reputable, distinct sources relevant to the topic.**

### 1a. Initial broad search

Run multiple web searches with varied query phrasings to cast a wide net:
- Use the topic directly
- Use related technical terms and synonyms
- Search for academic papers, conference proceedings, blog posts from known practitioners
- Search for open-source tools, GitHub repos, and implementations
- Search for critique, counter-arguments, and known failure cases

For each search result, fetch the full page content where relevant.

### 1b. Deep dive on promising sources

For sources that look highly relevant:
- Fetch the full URL content
- Follow internal links to related work
- Check "References" or "Further Reading" sections for additional sources
- Use `agent-browser` for pages that require JavaScript rendering

### 1c. Source categorization

As you collect sources, maintain a working list organized by category:
- Academic papers and research
- Open-source tools and frameworks
- Practitioner blog posts and case studies
- Official documentation
- Conference talks and videos (note: link to summary/slides, not video)
- News and announcements

### 1d. Quality bar

Only include sources that meet these criteria:
- Directly relevant to the topic (not tangentially related)
- From a reputable author, institution, or publication
- Accessible via URL (not paywalled without abstract)
- Published within a reasonable recency window (prefer last 3 years, older only if foundational)

**Do not proceed to Phase 2 until you have at least 200 sources catalogued.**

Send progress update: "Phase 1 complete: collected {N} sources across {M} categories."

## Phase 2: Analysis and Synthesis

**Goal: Extract insights, identify patterns, and build the intellectual backbone of the report.**

### 2a. Thematic analysis

Group sources by the themes they address. For each theme:
- What is the core claim or finding?
- What evidence supports it?
- What are the trade-offs or limitations?
- How does it relate to other themes?

### 2b. Practical approaches identification

For each practical approach, tool, or technique found:
- What problem does it solve?
- How mature/production-ready is it?
- What are the adoption costs and risks?
- Are there quantifiable results or benchmarks?

### 2c. Back-of-envelope calculations

Where numbers exist (performance, cost, scale, adoption rates), capture them. If estimates can be made, make them explicitly with stated assumptions.

### 2d. Outline construction

Build a logical outline that:
- Starts with the problem/context
- Groups solutions by approach or category
- Places most impactful/practical items prominently
- Ends with trade-off summary or recommendations
- Includes a sources section

## Phase 3: Write the Report

**Goal: Produce a structured, citation-dense markdown report of 400+ lines.**

### Writing principles

- Every factual claim must have an inline citation: `[N]`
- Use short, declarative sentences. Avoid passive voice.
- Lead with the most important information in each section
- Use numbers whenever possible: percentages, benchmarks, counts, dates
- Express trade-offs explicitly: "X reduces Y by Z% but increases W by V%"
- Back-of-envelope style for estimates: state assumptions, show reasoning
- Avoid filler phrases ("it is worth noting that", "in conclusion", etc.)

### Structure

```markdown
# {Report Title}

## Overview
{2-3 sentences on what this report covers and why it matters}

## Problem Statement
{Specific, quantified description of the problem}

## {Category 1}
### {Subcategory 1a}
...

## {Category N}
...

## Trade-off Summary
{Table or list comparing approaches on key dimensions}

## Sources
[1] {Author/Org} — {Title} — {URL}
[2] ...
```

### Citation format

Inline: `[N]` immediately after the sentence containing the claim.
Sources section at the end: sequential numbering `[1]`, `[2]`, etc.

### Length target

Aim for 400–600 lines. If the topic warrants more, write more — do not artificially truncate. If less is genuinely sufficient (sparse topic), note this.

**Do not proceed to Phase 4 until the draft is complete and saved to a local workspace file.**

## Phase 4: Deploy to GitHub

**Goal: Commit the initial draft to the target repository.**

### 4a. Clone or access the repo

```bash
cd /workspace/group
git clone https://github.com/{repo}.git repo-work
cd repo-work
```

If the repo is already cloned in the workspace, use it directly.

### 4b. Write the file

```bash
mkdir -p {folder}
# Write the report content to {folder}/{filename}.md
```

### 4c. Commit and push

```bash
git config user.email "andy@nanoclaw"
git config user.name "Andy"
git add {path}
git commit -m "research: add {title} draft"
git push
```

### 4d. Report the link

Send the user the GitHub URL to the committed file:

> Draft committed: https://github.com/{repo}/blob/main/{path}

## Phase 5: Citation QA

**Goal: Verify every citation is accurate — the link works AND the cited text matches the source.**

This phase is sequential and methodical. Do not batch or skip steps.

### 5a. For each citation [N]:

1. **Fetch the URL** — try to read its content. If it 404s or is unreachable, mark as broken.
2. **Read the citation context** — find the sentence(s) in the document that reference [N].
3. **Verify alignment** — does the claim in the document accurately reflect what the source says?
   - Correct: source clearly supports the claim
   - Partial: source relates to topic but doesn't directly support the specific claim
   - Wrong: source does not support the claim, or contradicts it
   - Broken: URL is dead

4. **For each discrepancy** (partial, wrong, or broken):
   - Think through the citation context: what was the author trying to support?
   - If source is wrong: find a better source for that claim, or rewrite the claim to match the source
   - If source is broken: find a replacement URL for the same content, or remove the citation
   - Make the correction

5. **Propagation check** — after each correction:
   - Search the rest of the document for related claims that may rely on the same incorrect assumption
   - Correct any propagated errors

6. **Repeat** the process until all citations have been verified.

### 5b. Renumber citations

After all corrections:
- Ensure citation numbers are sequential starting from [1]
- No gaps in numbering
- Sources section matches inline citations exactly
- Remove any orphaned citations (cited but no matching source entry)

### 5c. Commit the QA'd version

```bash
git add {path}
git commit -m "research: citation QA — verified {N} links, fixed {M} discrepancies"
git push
```

Send update: "Phase 5 complete: verified {N} citations, fixed {M} issues."

## Phase 6: Optimize

**Goal: Compress the document to ~50% of its current size without losing substance.**

### Optimization principles

- **Shorter sentences** — split compound sentences, remove subordinate clauses
- **Remove redundancy** — if the same point appears twice, keep the strongest version
- **Numbers over prose** — replace "significantly faster" with "3x faster"
- **Active voice** — "X does Y" not "Y is done by X"
- **Remove scaffolding** — transition phrases, obvious conclusions, context already established
- **Preserve structure** — same headings, same section order, same trade-off table
- **Preserve all citations** — do not remove any [N] citation in the process of compression
- **Preserve all source entries** — the Sources section must remain complete

### Process

1. Measure current line count
2. Work section by section, compressing each
3. After each section, verify: does it still convey the key information?
4. Target: 50% of original line count (±10%)

### Final commit

```bash
git add {path}
git commit -m "research: optimize — compressed {before}→{after} lines, preserved {N} citations"
git push
```

## Phase 7: Final Report to User

Send the user a summary:

> Research complete. Here's what was done:
>
> *Report:* {title}
> *Location:* https://github.com/{repo}/blob/main/{path}
>
> *Phase 1:* {N} sources collected across {M} categories
> *Phase 3:* {N} line draft written with {M} citations
> *Phase 5:* {N} citations verified, {M} fixed
> *Phase 6:* Compressed {before}→{after} lines ({pct}% reduction)
>
> Final commit: {commit hash}

## Troubleshooting

### URL fetch fails

Use `agent-browser` for JavaScript-rendered pages:
```bash
agent-browser open {url}
agent-browser snapshot
```

For paywalled content, use the abstract/summary URL instead, or find a preprint/open version.

### GitHub push fails

Check `GH_TOKEN` is set:
```bash
echo $GH_TOKEN | head -c 10
```

Use token-authenticated remote:
```bash
git remote set-url origin https://$GH_TOKEN@github.com/{repo}.git
```

### Fewer than 200 sources found

Expand search strategy:
- Try Google Scholar queries: `site:scholar.google.com {topic}`
- Search GitHub directly: `gh search repos {topic} --limit 30`
- Check awesome-lists: search for `awesome {topic}` on GitHub
- Look at references sections of the best sources found so far

### Report under 400 lines

Do not pad. Instead, check:
- Are all major categories of approaches covered?
- Is the problem statement fully quantified?
- Are all trade-offs explicitly compared?
- Is there a concrete examples or case study section?

If still under 400 after honest coverage, note the topic is narrower than average and proceed.
