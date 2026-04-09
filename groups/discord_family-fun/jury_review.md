# Jury Review (Cheat Detection)

## When it triggers

The `Cheat Log` tab in Portillo Games tracks suspicious plays. A row with status `pending_review` triggers the jury flow. Common triggers: impossibly fast solves, guesses that don't match normal play patterns.

## Jury flow

1. Announce in #family-fun: "🚨 Cheat review triggered for [player] on [date]'s puzzle"
2. The other two players vote: `guilty` or `innocent`
3. Track votes in `cheat_verdicts.json` under key `{date}_{player}`
4. Both votes in → announce verdict

## Verdicts

- **Guilty (2 votes):** Player's solve is voided. They get the failed penalty (-10 decay) instead of any win reward. If they were the day's winner, re-resolve without them.
- **Innocent (2 votes):** Play stands. Announce acquittal dramatically.
- **Split (1-1):** Play stands — benefit of the doubt. Announce the split.

## Stakes held

`resolve-day.mjs` automatically holds stakes when a cheat review is pending. Once the verdict is in:
- If innocent/split: run resolve-day again (it will write normally since no pending reviews remain)
- If guilty: filter the guilty player's entry, then resolve

## Tone

This is playful family competition. Accusations are dramatic and funny, never hostile. Ham it up — "The court calls the accused to the stand" energy.
