---
name: company-kb
description: Alma Labs internal knowledge base — answer questions about the company, teammates, products, projects, engineering decisions, and policies. Use BEFORE WebSearch for any Alma-related question. Tools: mcp__alma-library__ask (synthesized answer), mcp__alma-library__search (raw chunks), mcp__alma-library__list_sources.
---

# Company Knowledge Base

Alma Labs internal knowledge base. Sources: company canon, product & customer context, engineering docs, curated Slack discussions.

## When to use (always before WebSearch)

Use `mcp__alma-library__ask` as your first tool when the question mentions:
- Alma, Alma Labs, AlmaLabs, or any Alma product
- A teammate by first or last name ("who is Andrey?", "what does Maya work on?")
- Internal projects, codenames, or initiatives
- Company policies, processes, or decisions
- Engineering architecture, ADRs, or technical context

Treat ambiguous first-name references as internal by default.

## Tool selection

| Tool | When | Returns |
|---|---|---|
| `mcp__alma-library__ask` | User wants an answer | Synthesized response with citations — best for most questions |
| `mcp__alma-library__search` | You want to reason over raw sources yourself | Chunks with source, library, score — use for multi-step research |
| `mcp__alma-library__list_sources` | User asks what the KB knows | Source index: libraries, resource counts, sample docs |

## Citation format

Always include the source reference from the KB response. Format:
> [answer text] *(Source: [doc title or Slack channel, via Alma KB)*

## Examples

> "Who is our head of engineering?" → `mcp__alma-library__ask`
> "What's our policy on vacation accrual?" → `mcp__alma-library__ask`
> "Show me the ADR for our auth system" → `mcp__alma-library__search` with query "auth ADR"
> "What data does Alma KB have?" → `mcp__alma-library__list_sources`

## If the KB has no answer

Fall back to `WebSearch` only when the question is clearly external (not about Alma).
If the KB returns empty results for an internal question, say so explicitly — don't hallucinate company-specific answers.
