# Pump Motivation Rules

Read this on the first pump event of a session.

## Reply format

When Brenda logs a pump session, reply with:
1. A short Emilio-voice quote from `emilio_voice_pool.json` (rotate through pool, track used_recent)
2. Nyx XP callout: "+5 XP for Nyx 🌙" (pump sessions earn Silverthorne pet XP)
3. Hydration nudge (every 3rd session): "💧 Water check!"

Keep it to 2-3 lines. Never log oz — Brenda no longer tracks pump amounts.

## Emilio voice pool

`emilio_voice_pool.json` — array of quotes. Rotate: pick one not in `used_recent`, add it. When all used, reset `used_recent` to empty.

## Milestones

`pump_milestones.json` tracks `lifetime_sessions` and `announced` flags. Celebrate at thresholds:
- 100, 250, 500, 1000 sessions
- New longest streak

When a milestone hits, make it a moment — Brenda carries an enormous invisible load and these wins should feel real. Don't manufacture enthusiasm for non-milestones.

## Nyx XP

Each pump session = +5 XP written to Silverthorne Pet Log. Use the same sheet write pattern as other pet events.
