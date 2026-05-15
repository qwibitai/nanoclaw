---
name: trade-video-director
description: One-command safe trade idea video production for Builder. Use when Ilan asks Builder to make a trade idea video, market explainer, Remotion storyboard, narrated finance clip, or video based on an Analyst/Trade Lab idea.
---

# Trade Video Director

Use this skill when Ilan asks for a trade idea video, narrated market explainer, or Remotion storyboard based on market data.

This is the safe native version of the useful Hyperframes pattern: agent-first video CLI, deterministic scene blocks, production manifest, lint/doctor checks, media preprocessing, and one non-interactive render command. Do not import Hyperframes code, run arbitrary HTML/React, execute generated strategy code, or fetch random video components.

## Main Command

Builder should prefer the single director command:

```bash
NODE_NO_WARNINGS=1 node /app/skills/trade-video-director/scripts/trade-video-director.mjs make --idea <idea-id> --strategy ma-cross --range 1y --render
```

Manual idea:

```bash
NODE_NO_WARNINGS=1 node /app/skills/trade-video-director/scripts/trade-video-director.mjs make --title "Long copper supply squeeze" --asset COPPER --direction long --strategy breakout --range 1y --render
```

First-pass cheap mode, no TTS or render:

```bash
NODE_NO_WARNINGS=1 node /app/skills/trade-video-director/scripts/trade-video-director.mjs make --asset NVDA --direction long --title "Long NVDA compute demand" --no-tts
```

## Workflow

The command does the safe sequence:

1. Runs Trade Lab for live tape, trend/risk, and fixed-template backtest.
2. Builds a deterministic video brief from the run card.
3. Writes narration text.
4. Generates safe storyboard JSON using whitelisted Remotion scene types only.
5. Optionally generates OpenAI TTS narration through Builder's existing helper.
6. Optionally renders with `/workspace/agent/bin/render-safe-storyboard.sh`.
7. Verifies the MP4 with `ffprobe` when available.
8. Writes a production manifest and returns paths.

## Utilities

```bash
NODE_NO_WARNINGS=1 node /app/skills/trade-video-director/scripts/trade-video-director.mjs doctor
NODE_NO_WARNINGS=1 node /app/skills/trade-video-director/scripts/trade-video-director.mjs catalog
NODE_NO_WARNINGS=1 node /app/skills/trade-video-director/scripts/trade-video-director.mjs lint /workspace/agent/projects/<slug>/storyboard.json
```

## Output Discipline

Do not paste the full storyboard, full narration, or full logs into Telegram. Return only:

- project directory
- storyboard path
- narration path
- MP4 path, if rendered
- one-line verification summary

## Safety Rules

- Use only `SafeStoryboard` scene JSON.
- Use fixed Trade Lab templates only.
- Never import external video code.
- Never execute generated HTML, JSX, React, or strategy code.
- Never call broker/order endpoints.
- Treat Trade Lab output as research support and video input, not a recommendation.
