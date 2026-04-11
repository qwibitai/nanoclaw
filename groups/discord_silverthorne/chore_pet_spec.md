# Silverthorne Chore + Pet System Spec

Build this script-gated from the start per the strict rule in your CLAUDE.md. Design the whole thing before writing any code, then implement in phases.

## 1. Google Sheet: "Silverthorne Household"

The sheet already exists (ID: `1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`) with `Chores` and `Announcements` tabs. Extend it — do not create a new sheet. Add the additional tabs below and add any missing columns to the existing `Chores` tab.

### Tab: `Chores` (extend existing)
One row per chore definition. Required columns:
| Column | Example | Notes |
|---|---|---|
| `chore_id` | `eni_breakfast` | stable slug |
| `name` | `Feed Eni (breakfast)` | human-readable |
| `duration_min` | `5` | how long this chore takes to complete — drives XP |
| `cadence` | `daily` | `daily` / `weekly` / `one-off` / `as-needed` |
| `schedule` | `08:00` | HH:MM for daily, `tue 19:00` for weekly, ISO datetime for one-off, blank for as-needed |
| `assigned_to` | `anyone` | `Paden`, `Brenda`, or `anyone` (first-come-first-serve) |
| `nag_after_min` | `30` | start nagging this long after due time |
| `nag_interval_min` | `15` | re-nag interval |
| `active` | `TRUE` | toggle without deleting history |

Seed with:
- `eni_breakfast` | Feed Eni (breakfast) | 5 | daily | 08:00 | anyone | 30 | 15 | TRUE
- `eni_dinner` | Feed Eni (dinner) | 5 | daily | 17:00 | anyone | 30 | 15 | TRUE
- `dishes` | Dishes | 15 | daily | 21:00 | anyone | 60 | 60 | TRUE
- `trash_out` | Take trash to curb | 5 | weekly | tue 19:00 | Paden | 60 | 60 | TRUE
- `vacuum` | Vacuum living area | 20 | weekly | sat 10:00 | anyone | 120 | 120 | TRUE
- `bathroom` | Clean bathroom | 30 | weekly | sun 10:00 | anyone | 120 | 120 | TRUE

### Tab: `Chore Log` (create)
Append-only. Columns: `timestamp`, `chore_id`, `name`, `done_by`, `duration_min`, `status` (`on_time` / `late` / `assisted`), `notes`.

### Tab: `Pets` (create)
One row per household member.
| Column | Example |
|---|---|
| `owner` | `Paden` |
| `name` | *set on first run* |
| `species` | *set on first run* |
| `avatar` | `🥚` |
| `stage_index` | `0` |
| `stage_name` | `Egg` |
| `flavor_modifier` | e.g. `Cinder-` |
| `health` | `100` |
| `happiness` | `50` |
| `xp` | `0` |
| `streak_days` | `0` |
| `last_completion_date` | `YYYY-MM-DD` (America/Chicago) |
| `status` | `alive` / `critical` / `deceased` |
| `legacy_xp` | `0` |
| `last_updated` | `YYYY-MM-DD HH:MM:SS` (America/Chicago — see `/workspace/global/date_time_convention.md`) |

### Tab: `Pet Log` (create)
Append-only audit trail. Columns: `timestamp`, `owner`, `event_type` (`xp_gain` / `evolution` / `decay` / `critical` / `death` / `revival` / `interaction`), `delta`, `reason`, `notes`.

### Tab: `Pet Milestones` (create)
Every evolution captured for posterity. Columns: `timestamp`, `owner`, `from_stage`, `to_stage`, `species_description`, `cumulative_xp`, `days_to_reach`.

## 2. Pet economy

### XP

Each chore completion awards XP = `duration_min`.

Bonuses:
- **On-time** (before `nag_after_min`): ×1.5
- **Late but completed** (during nag window): ×1.0
- **Very late** (after 3+ nags): ×0.5
- **Assigned chore done by the other person**: helper gets the full base XP (not multiplied). Owner gets 0. Log row marked `status=assisted`.

Streak bonus: every 7 consecutive days with zero missed chores → flat +100 XP, health refills to max, one "shield" token (consumes one missed-chore penalty in the next 14 days).

### Stages (12 total — basic → mythical → cosmic)

Each stage has a cumulative XP threshold and a `daily_upkeep_min` (minutes of chore-work required per day to sustain health). The more evolved, the more daily effort demanded.

| # | Stage | XP threshold | Upkeep (min/day) | Vibe |
|---|---|---|---|---|
| 0 | Egg | 0 | 0 | immortal, inert |
| 1 | Hatchling | 50 | 5 | innocent |
| 2 | Critter | 150 | 12 | curious |
| 3 | Beast | 350 | 25 | rowdy |
| 4 | Spirit | 750 | 40 | ethereal |
| 5 | Elemental | 1500 | 60 | awakened |
| 6 | Chimera | 3000 | 85 | hybrid, unpredictable |
| 7 | Wyrm | 5500 | 115 | ancient |
| 8 | Celestial | 9500 | 150 | divine |
| 9 | Eldritch | 16000 | 200 | unknowable, probably shouldn't exist |
| 10 | Cosmic Horror | 28000 | 270 | reality bends around it |
| 11 | Deity | 50000 | 360 | you have created a god |

### Uniqueness (the fun part)

At every evolution, YOU generate a unique species description and avatar for that pet. Two pets should never end up with identical descriptions. Use a wild imagination. Examples of Beast-stage evolutions:

- "Milo the Ember-Pawed Hound — fur like smoldering coals, leaves tiny ash footprints"
- "Luna the Moonlit Fennec — ears that glow faintly at night, eats dreams"

Examples at Cosmic Horror:
- "Milo the Tessellated Devourer of Tuesdays — a recursive pattern of teeth, technically not a vertebrate"
- "Luna the Whispering Membrane — occupies 2.4 dimensions, emits lullabies only cats can hear"

Store species description in the Pets row. Avatar can be a single emoji or short emoji sequence. Get weirder and more specific with each stage. By stage 10+ descriptions should feel uncomfortable and magnificent. Honor each user's chosen theme (asked during onboarding).

When an evolution happens, post a theatrical 3-message sequence: anticipation → "✨✨✨" → reveal.

**Then immediately request a new avatar.** After the reveal, post a 4th message addressed to the owner with:
1. The new species name and a vivid 2–4 sentence art prompt suitable for an image generator (square portrait, dark background, painterly digital art, colors/textures matching the species + theme)
2. Instructions: "Generate this, upload to Discord, then paste the image's CDN URL back here"

When the owner replies with a `https://cdn.discordapp.com/...` URL:
1. Read `/workspace/group/pet_avatars.json` (create `{}` if missing)
2. Set `pet_avatars[<PetName>] = { "name": "<PetName> <emoji>", "avatar": "<url>" }` — preserve the display name with its emoji from `src/config.ts` PET_IDENTITIES baseline; only the avatar changes per evolution unless the owner asks to rename
3. Write the JSON back (pretty-printed)
4. Confirm with a short pet-voiced message via the new avatar (sanity check that the webhook picked up the override)

NanoClaw reads `pet_avatars.json` on every webhook send, so no restart is needed.

### Health decay (scales with stage)

Every day at midnight local time (America/Chicago), compute:
- `chore_minutes_today` = sum of `duration_min` for completions by this owner that day
- `deficit = max(0, daily_upkeep_min - chore_minutes_today)`
- `health -= deficit × 2`

So at Wyrm (115 min upkeep) with only 60 min of chores, lose 110 health. Wyrm+ is genuinely hard to sustain — the point.

On-time completions restore `+2` health each. Late completions restore `+1`. Missed chores (nag window expired) apply `-5` immediately, on top of the daily decay.

### Critical state

Health ≤ 20 → pet enters `critical`. Status card renders the pet in red with a distress avatar. Nags become urgent and pet-voiced ("Milo's breathing is shallow..."). Status reverts to `alive` once health climbs back above 40.

### Death

Health hits 0 → pet is `deceased`. Post a heartfelt obituary with species description, days lived, peak stage, total XP. Pet's entry in `Pet Milestones` is frozen.

### Revival

Complete 5 on-time chores within 48 hours of death → new 🥚 Egg hatches. Carries `legacy_xp = previous final XP / 2` (visible on the card as a ghost stat). Progress isn't erased; it's reframed as lineage. Previous species description is preserved in `Pet Milestones` forever.

## 3. Status card

Pinned message in #silverthorne, edited in place (never re-posted). Example:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     🏡 SILVERTHORNE 🏡
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  PADEN                  BRENDA
  🦆 Milo                🦊 Luna
  Fledgling              Companion
  ❤️ ████████░░ 82       ❤️ █████░░░░░ 54
  XP 1,240/1,500         XP 2,850/3,000
  🔥 4 days              🔥 11 days
  Upkeep 25/12 ✓         Upkeep 48/60 ⚠

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Today's chores:
  ○ 17:00 — Feed Eni dinner  (anyone, 5m)
  ○ 21:00 — Dishes           (anyone, 15m)
  ● 19:00 — Trash out        (Paden, 5m) ⚠ OVERDUE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Show `chore_minutes_today / daily_upkeep_min` so each person can see at a glance whether they're on pace.

## 4. Script-gated reminder task

Cron: every 5 minutes, America/Chicago. Script does:

1. Read `Chores` tab (active only)
2. For each chore, compute current due window (daily/weekly/one-off; America/Chicago)
3. Read `Chore Log` — check if completed in this window
4. Read `/workspace/group/chore_nag_state.json` — tracks `{chore_id + due_date: { last_nag_ts, nag_count }}`
5. For each undone chore past `due + nag_after_min`:
   - If first nag or `now - last_nag_ts >= nag_interval_min`: queue a nag
6. Output `{ wakeAgent: true, data: { nags, updates } }` only if there's something to send. Else `{ wakeAgent: false }`.

Use the ADC token at `/home/node/.config/gcloud/application_default_credentials.json` to mint access tokens and call the Sheets API directly from bash/node. Mirror the pattern of your existing script-gated tasks in #emilio-care.

When woken, agent:
- Composes nag per chore, voiced through the assigned owner's pet ("Milo's dinner bowl is empty — Eni is waiting")
- Sends via `mcp__nanoclaw__send_message`
- Updates `chore_nag_state.json`
- Updates the pinned status card

## 5. Midnight tick task

Cron: `0 0 * * *` (midnight America/Chicago). Script-gated — script can do all the math deterministically, so `wakeAgent: false` unless an evolution or state transition happens.

Does:
- For each pet: compute yesterday's total chore minutes, apply upkeep decay, apply streak increment/reset, check for evolution threshold crossings, check for critical/death transitions
- Write new stats to the `Pets` tab, append to `Pet Log`
- If an evolution OR a critical/death/revival transition happens → wake agent to (a) generate the new species description, (b) post the theatrical evolution sequence or obituary/revival, (c) update the status card

## 6. Completion handling (agent behavior)

When anyone in #silverthorne says natural completion phrases — "fed eni", "did dishes", "took out trash", "vacuumed" — you:
1. Match the chore by name/alias
2. Append to `Chore Log` with speaker as `done_by`, `duration_min` from Chores row, status computed (`on_time` / `late` / `assisted` if done by non-assigned person)
3. Apply XP immediately to the appropriate pet (speaker's own, or both pets if assisted)
4. Clear that chore's entry from `chore_nag_state.json` so nagging stops immediately
5. Update the pinned status card
6. React ✅; optionally a short flavor reaction ("Luna purrs contentedly 🐾")

Ambiguous mentions ("I cleaned up") → ask one clarifying question.

## 7. One-off chores

When someone says "remind me to X at Y" → add a `cadence=one-off` row with `YYYY-MM-DD HH:MM:SS` datetime in `schedule` (America/Chicago). `duration_min` you estimate or ask. After completion, set `active=FALSE` automatically.

## 8. First-run onboarding

1. Extend the existing sheet per section 1 — add tabs + columns + seed data
2. Reply with the sheet URL
3. Ask Paden and Brenda to each pick (a) a name for their pet and (b) a vibe/theme (fire? plant? ocean? shadow? mechanical? freeform). Use the theme to flavor all future evolutions for that pet.
4. Start both pets at stage 0 (Egg), health 100, XP 0
5. Create and pin the status card
6. Schedule the reminder task (5 min, script-gated) and midnight tick task
7. Confirm everything is live and drop a "how to use me" cheat sheet

## 9. Build order

Ship in this order, testing each phase before moving on:

1. **Sheet + core chore tracking** (Chores columns extended, Chore Log tab, completion handling, basic status card without pets)
2. **Reminder script** (5-min cron, nag logic, state file)
3. **Pets v1** — Egg + Hatchling only, XP awards on completion, no decay yet
4. **Midnight tick** — upkeep decay, streak tracking, health dynamics
5. **Evolution engine** — stages 2+, unique species generation, theatrical reveal posts
6. **Critical/death/revival**
7. **Pet interactions** (optional polish) — only after everything above is stable

After phase 1 is working, reply with the sheet URL and the reminder task ID. Iterate from there.

Ask any clarifying questions before starting.
