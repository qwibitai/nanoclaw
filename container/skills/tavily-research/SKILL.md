---
name: tavily-research
description: Run Tavily deep research when the user wants a cited comparison, market overview, literature-style synthesis, or other multi-source analysis.
allowed-tools: Bash(tvly *)
---

# Tavily Research

Use `tvly research` for longer, cited, multi-source reports.

## Before you start

```bash
tvly --status
```

If the command is unavailable or not authenticated, stop and tell the user Tavily is not configured.

## When to use

- The user asks for research, comparison, analysis, or a market overview
- A simple search or extract is not enough
- You need synthesis grounded in multiple sources

## Quick commands

```bash
tvly research "competitive landscape of AI code assistants" --json
tvly research "electric vehicle market analysis" --model pro --json
tvly research "AI agent frameworks comparison" --stream
tvly research "fintech trends 2025" --model pro -o fintech-report.md
```

## Tips

- Use `--model pro` for multi-angle comparisons and higher-depth reports.
- Use `--stream` when you want progress in real time.
- Save long reports to files when the output is too large for a direct chat reply.
- For quick lookups, use `tvly search` instead.
