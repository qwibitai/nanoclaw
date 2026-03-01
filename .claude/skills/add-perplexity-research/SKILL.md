---
name: add-perplexity-research
description: Add Perplexity Pro web research to NanoClaw. Gives the container agent access to sonar, sonar-pro, and sonar-deep-research models for comprehensive multi-source research with citations.
---

# Add Perplexity Research

Gives the container agent access to the Perplexity API for web research tasks that go beyond what WebSearch can do — multi-source synthesis, deep analysis, market research, literature reviews.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `perplexity-research` is in `applied_skills`, skip to Phase 3 (Verify).

### Get a Perplexity API key

1. Go to [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
2. Create an API key
3. Add it to your `.env` file:

```
PERPLEXITY_API_KEY=pplx-...
```

## Phase 2: Apply Code Changes

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-perplexity-research
```

This:
- Adds `container/skills/perplexity-research/SKILL.md` — agent-facing docs with API examples
- Modifies `src/container-runner.ts` — passes `PERPLEXITY_API_KEY` to containers via stdin

### Build and restart

```bash
npm run build
```

Linux:
```bash
systemctl --user restart nanoclaw
```

macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 3: Verify

Ask the agent to do a research task:

```
Research the latest developments in [topic] using Perplexity
```

The agent should use `curl` to call the Perplexity API with `$PERPLEXITY_API_KEY` and return a sourced answer.

## Troubleshooting

### "PERPLEXITY_API_KEY not set"

Ensure the key is in your `.env` file (not `process.env`). NanoClaw reads secrets from `.env` at container spawn time.

### API errors

- Check your Perplexity account has API credits
- Verify the key starts with `pplx-`
- `sonar-deep-research` takes up to 3 minutes — don't timeout too early
