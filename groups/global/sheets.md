# Google Sheets — canonical IDs and purpose

All Portillo family data lives in three Google Sheets, authenticated as padenportillo@gmail.com via the utility library at `/workspace/global/scripts/lib/sheets.mjs`. These IDs are the source of truth — don't create duplicates.

## How to access sheets

Use the utility library via Bash:

```js
import { getAccessToken, readRange, appendRows } from '/workspace/global/scripts/lib/sheets.mjs';

// Read
const rows = await readRange('SHEET_ID', 'Tab!A:Z');

// Append
await appendRows('SHEET_ID', 'Tab!A:Z', [['col1', 'col2', ...]]);
```

Run with: `node --input-type=module -e "..."`

## Emilio Tracking

**ID:** `1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM`
**URL:** https://docs.google.com/spreadsheets/d/1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM
**Owner group:** `discord_emilio-care` (writes)
**Tabs:**
- **Feedings** — `Feed time`, `Amount (oz)` (numeric), `Source`
- **Diaper Changes** — `Feed time`, `Diaper Status`
- **Milk Pump** — session fact + duration/time only. **Brenda no longer tracks ounces** — do NOT ask for or display oz.
- **Sleep Log** — sleep tracking (open sessions auto-closed on next feeding)
- **TODOs** — family task list

## Silverthorne Household

**ID:** `1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`
**URL:** https://docs.google.com/spreadsheets/d/1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4
**Owner group:** `discord_silverthorne` (writes)
**Cross-group writers:** `discord_emilio-care` appends `Chore Log` + `Chores` rows for hydration nudges; `discord_family-fun` appends `Pet Log` rows for Saga Wordle XP/health changes.
**Tabs:** `Chores`, `Chore Log`, `Pets`, `Pet Log`, `Pet Milestones`, `Announcements`

### Pet ownership
- **Paden** → **Voss** 🌋 (volcanic/molten)
- **Brenda** → **Nyx** 🌙 (celestial/lunar)
- **Danny** → **Zima** ❄️ (icy/draconic, she/her)

## Portillo Games

**ID:** `1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY`
**URL:** https://docs.google.com/spreadsheets/d/1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY
**Owner group:** `discord_dms` (writes Wordle State + Panda Submissions from private DMs)
**Readers:** `discord_family-fun` (Wordle progress card + reveal), `discord_parents` (Panda reveal poller)
**Writers per tab:**
- `Wordle Today` — written by `discord_family-fun` (6am rollover publishes today's word)
- `Wordle State` — written by `discord_dms` (one row per scored guess)
- `Wordle Submissions` — legacy log, may still be appended for audit
- `Panda Submissions` — written by `discord_dms`
**Tabs:**
- **Wordle Today** — `date | word | budgets_json` — one row per day. Source of truth for today's puzzle. `budgets_json` is a JSON object mapping each active player to their guess budget for the day, e.g. `{"Paden":6,"Brenda":7,"Danny":5}` — derived from each pet's lifetime XP tier (see `discord_family-fun/CLAUDE.md` "Per-player guess budget"). Family-fun publishes at 6am rollover; DMs read it to score guesses and enforce per-player budgets.
- **Wordle State** — `date | player | guess_num | guess | grid | solved` — append-only, one row per scored guess. DMs write; family-fun reads to render the progress card.
- **Wordle Submissions** — `timestamp | date | user_id | name | guess | game_channel` — legacy raw submission log
- **Panda Submissions** — `timestamp | date | user_id | name | question_number | answer`
- **Panda Love Map** — long-term journal entries from Panda reveals
- **Cheat Log** — `timestamp | date | player | type | detail | guess_count | status | verdict | penalty_applied` — written by `discord_dms` (flag), updated by `discord_family-fun` (jury verdict). Status flow: `pending_review` → `awaiting_verdict` → `resolved`. See `discord_dms/CLAUDE.md` "Anti-cheat" and `discord_family-fun/CLAUDE.md` "Jury review".

## Household Discord user IDs

These IDs appear as the `sender` / `user_id` field on messages and submissions:

- **Paden** — `181867944404320256`
- **Brenda** — `350815183804825600`
- **Danny** — `280744944358916097`
