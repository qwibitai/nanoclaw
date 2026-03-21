# Autoresearch — Hypothesis-Driven Experimentation

Systematic methodology for forming hypotheses and running experiments across kaizen work. Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

## The Loop

1. **Observe** — what's actually happening? (data, not assumptions)
2. **Hypothesize** — what do we think causes it? (falsifiable claim)
3. **Design experiment** — fastest way to prove/disprove? (minutes, not hours)
4. **Run** — execute the experiment
5. **Learn** — update understanding, iterate or ship

## Experiment Storage

Experiments are stored as markdown files in this directory:

```
experiments/
  README.md          — this file
  TEMPLATE.md        — copy this to start a new experiment
  EXP-001-*.md       — individual experiments
  results/           — raw data, logs, artifacts from runs
```

Each experiment file has YAML frontmatter with structured metadata and a markdown body with the narrative.

## CLI

```bash
npx tsx src/cli-experiment.ts create --hypothesis "H3" --issue 388 --title "format enforcement gaming"
npx tsx src/cli-experiment.ts list [--status pending|running|completed|falsified]
npx tsx src/cli-experiment.ts record <exp-id> --result "supported|falsified|inconclusive" --summary "..."
npx tsx src/cli-experiment.ts view <exp-id>
```

## Experiment Patterns

### A/B Compare (validated)

Two parallel Agent tool calls, identical task, different prompts. Measures behavioral differences.

```
Agent(prompt=control, model=sonnet) → output_A
Agent(prompt=experiment, model=sonnet) → output_B
Compare(output_A, output_B, measurements) → result
```

### Probe-and-Observe

Instrument a system, run it, analyze the output. No control group — just measurement.

### Toggle-and-Measure

Change one variable, measure before/after. Sequential, not parallel.

## Principles

- **Negative results are valuable.** A falsified hypothesis narrows the search space.
- **Fast beats thorough.** 15 minutes > 2 hours. You can always run another experiment.
- **Hypotheses are not facts.** Frame as falsifiable claims with "why it might be wrong."
- **Record everything.** Even obvious results become non-obvious in 3 months.

## Related

- Epic: [Garsson-io/kaizen#334](https://github.com/Garsson-io/kaizen/issues/334)
- First experiment: [Garsson-io/kaizen#388](https://github.com/Garsson-io/kaizen/issues/388) (H6)
