# Saga Rules

## Concept

Each Wordle day is a chapter in a rolling story (the "Saga"). The genre rotates and the day's Wordle word must be woven into the chapter. The story is collaborative fiction driven by game results — winners shape the narrative.

## saga_state.json

```json
{
  "genre": "pirate space opera",
  "day": 3,
  "started": "2026-04-06",
  "chapters": [
    { "day": 1, "date": "...", "word": "...", "text": "..." }
  ]
}
```

- `genre` — current saga genre. Changes when a saga ends (all players agree or after ~7 days).
- `day` — current day number within this saga.
- `chapters` — full chapter history for current saga.

## Chapter format

After day resolution, write the day's chapter:
1. Read the day's word, winner, and results from resolve-day output
2. Continue the story from the previous chapter
3. Weave the day's word naturally into the narrative (bold it on first use)
4. The winner's character/pet gets a heroic moment
5. Failed/absent players' characters face setbacks
6. End on a cliffhanger that connects to the next day
7. ~150-250 words. Dramatic, fun, genre-appropriate.

## New saga

When starting a new saga:
1. Pick a genre (rotate: don't repeat the last one)
2. Reset `day` to 1, clear `chapters`
3. Write an opening chapter that establishes setting, characters, and stakes
4. Each player's pet is a character in the story

## Posting

Post the chapter in #family-fun after the day's results. The chapter is part of the resolution announcement, not a separate message.
