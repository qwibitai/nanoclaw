---
name: perplexity-research
description: Use Perplexity Pro for web research when tasks require extensive, multi-source research or deep analysis. Prefer this over WebSearch/WebFetch for complex research questions, market analysis, literature reviews, or anything needing comprehensive sourced answers.
allowed-tools: Bash(perplexity:*)
---

# Perplexity Research

Use the Perplexity API for research tasks that go beyond what WebSearch can do. The API key is available as `$PERPLEXITY_API_KEY`.

## When to Use Perplexity vs WebSearch

| Use Perplexity | Use WebSearch |
|---|---|
| Multi-source research, synthesis | Quick fact lookups |
| Deep analysis with citations | Checking a specific URL |
| Market/competitor research | Finding a specific page |
| Literature reviews | Simple current events |
| Complex multi-step questions | One-line answers |

## Models

| Model | Use When |
|---|---|
| `sonar` | Quick research, simple factual questions |
| `sonar-pro` | Better accuracy, multi-step reasoning, pro search |
| `sonar-deep-research` | Comprehensive reports, complex topics, extensive synthesis |

## API Usage

The API is OpenAI-compatible at `https://api.perplexity.ai/chat/completions`.

### Standard Research (sonar / sonar-pro)

```bash
perplexity:search() {
curl -s https://api.perplexity.ai/chat/completions \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonar-pro",
    "messages": [
      {"role": "system", "content": "Be thorough and cite sources."},
      {"role": "user", "content": "YOUR RESEARCH QUESTION"}
    ]
  }' | jq -r '.choices[0].message.content'
}
```

### Deep Research (sonar-deep-research)

Deep Research autonomously searches, reads, and evaluates many sources. It takes longer (up to ~3 minutes) but produces comprehensive reports with citations.

```bash
perplexity:deep-research() {
curl -s https://api.perplexity.ai/chat/completions \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonar-deep-research",
    "messages": [
      {"role": "system", "content": "Produce a comprehensive research report with citations."},
      {"role": "user", "content": "YOUR RESEARCH QUESTION"}
    ]
  }' | jq -r '.choices[0].message.content'
}
```

### With Citations Extracted

```bash
perplexity:search-with-citations() {
curl -s https://api.perplexity.ai/chat/completions \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonar-pro",
    "messages": [
      {"role": "user", "content": "YOUR RESEARCH QUESTION"}
    ]
  }' | jq '{answer: .choices[0].message.content, citations: .citations}'
}
```

## Tips

- Frame research questions clearly and specifically for best results
- Use `sonar-pro` as the default; escalate to `sonar-deep-research` for topics that need comprehensive coverage
- Deep Research costs more (search query fees + reasoning tokens) — use it deliberately, not for simple questions
- The API returns markdown-formatted responses with inline citations
