# Wordle Mechanics

## Word selection & publish

Each day's word is set in `Wordle Today` tab of Portillo Games sheet. Columns: Date, Word, Budgets (JSON: `{"Paden":6,"Brenda":7,"Danny":5}`). Budgets come from `node /workspace/group/scripts/compute-tiers.mjs`.

## Guess budgets (tiers)

Tiers are based on lifetime XP from Silverthorne Pet Log:
- Hatchling (0-499 XP): 7 guesses
- Fledgling (500-1499 XP): 6 guesses
- Adept (1500-2999 XP): 5 guesses
- Apex (3000+ XP): 4 guesses

## DM submission flow

1. Player DMs you a 5-letter word
2. Validate: correct length, alpha only, within their guess budget
3. Score using green/yellow/gray emoji grid (🟩🟨⬜)
4. Reply in DM with their grid — **never** show grids in #family-fun
5. Write guess row to `Wordle State` tab: [date, player, guess_number, guess, grid, solved]
6. If solved or budget exhausted, mark player done in `wordle_state.json`

## Wordlist

`wordle_wordlist.txt` — one word per line. Pick from this list. Track used words in `wordle_used_words.json` to avoid repeats.

## Day resolution

Run `node /workspace/group/scripts/resolve-day.mjs`. Trust its output — don't re-derive winners or stakes. The script:
- Reads all guesses from the sheet
- Determines winner (fewest guesses; tie → earliest solve)
- Writes Pet Log stakes to Silverthorne: winner +20 XP, failed/no-show -10 decay
- Holds stakes if a cheat review is pending

## Pinned card

Label: `wordle_card`. Always use `send_message({label: "wordle_card", pin: true, upsert: true, text: ...})`.

Card shows: day number, date, genre, per-player status (guesses/budget), all-time leaderboard (wins, streak, best, avg), and last chapter opening. Format is rendered by `renderCard()` in `wordle.mjs` — match that layout.

## Reveal poller

`wordle_poller_state.json` tracks whether you've checked for new guesses recently. When a player submits, update the pinned card to reflect their new guess count (without revealing details).
