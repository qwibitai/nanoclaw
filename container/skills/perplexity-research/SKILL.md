---
name: perplexity-research
description: Use Perplexity Pro for web research when tasks require extensive, multi-source research or deep analysis. Prefer this over WebSearch/WebFetch for complex research questions, market analysis, literature reviews, or anything needing comprehensive sourced answers.
allowed-tools: Bash(perplexity *)
---

# Perplexity Research

Use the `perplexity` CLI for research tasks that go beyond what WebSearch can do.

## When to Use Perplexity vs WebSearch

| Use Perplexity | Use WebSearch |
|---|---|
| Multi-source research, synthesis | Quick fact lookups |
| Deep analysis with citations | Checking a specific URL |
| Market/competitor research | Finding a specific page |
| Literature reviews | Simple current events |
| Complex multi-step questions | One-line answers |

## CLI Usage

```bash
perplexity search "What are the latest developments in AI safety?"
perplexity pro "Compare React vs Vue for enterprise apps in 2026"
perplexity deep "Comprehensive analysis of quantum computing progress"
```

| Command | Model | Use When |
|---|---|---|
| `perplexity search` | sonar | Quick research, simple factual questions |
| `perplexity pro` | sonar-pro | Better accuracy, multi-step reasoning |
| `perplexity deep` | sonar-deep-research | Comprehensive reports (slow, ~3 min) |

## Tips

- Use `perplexity pro` as the default; escalate to `perplexity deep` for topics that need comprehensive coverage
- Deep Research costs more — use it deliberately, not for simple questions
- Output includes citations with source URLs
