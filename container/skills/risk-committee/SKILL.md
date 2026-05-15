---
name: risk-committee
description: Safe multi-lens risk review for trade ideas. Use when Ilan asks Analyst to run a risk committee, pressure-test a trade, decide pass/watch/reject, assess portfolio fit, or produce kill criteria for a Trade Lab idea.
---

# Risk Committee

Use this skill when Ilan asks to run a risk committee on a trade idea.

This is the safe native version of the useful AutoHedge pattern: multiple specialist lenses reviewing one idea. It deliberately excludes the dangerous parts: no hedge-fund automation, no broker connectivity, no order execution, no autonomous trading, no generated strategy code.

## Main Command

Idea from Trade Idea OS:

```bash
NODE_NO_WARNINGS=1 node /app/skills/risk-committee/scripts/risk-committee.mjs review --idea <idea-id> --strategy ma-cross --range 1y --save
```

Manual idea:

```bash
NODE_NO_WARNINGS=1 node /app/skills/risk-committee/scripts/risk-committee.mjs review --title "Long copper supply squeeze" --asset COPPER --direction long --strategy breakout --range 1y --save
```

Utilities:

```bash
NODE_NO_WARNINGS=1 node /app/skills/risk-committee/scripts/risk-committee.mjs doctor
NODE_NO_WARNINGS=1 node /app/skills/risk-committee/scripts/risk-committee.mjs lenses
```

## Workflow

The command does the safe sequence:

1. Runs Trade Lab, or reads an existing `--lab-json` file.
2. Reviews the idea through fixed lenses:
   - Bull case
   - Bear case
   - Macro/regime
   - Positioning/crowding
   - Portfolio fit
   - Kill criteria
3. Produces a verdict: `pass`, `watch`, or `reject`.
4. Saves a markdown memo and JSON artifact when `--save` is used.

## Verdict Meaning

- `pass`: pass to deeper human/Analyst work. This is not permission to trade.
- `watch`: plausible, but missing confirmation or too much risk.
- `reject`: evidence/risk balance does not justify more work right now.

Never mark a Trade Idea OS item `active` from this skill. Only Ilan can promote an idea to `active`.

## Safety Rules

- No broker APIs.
- No order routing.
- No autonomous execution.
- No generated strategy code.
- No external AutoHedge code.
- Trade Lab templates only.
- Output is research support, not a recommendation.
