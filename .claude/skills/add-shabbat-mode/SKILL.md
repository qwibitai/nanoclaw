---
name: add-shabbat-mode
description: "Pause all activity during Shabbat and Yom Tov"
---

# Add Shabbat Mode

Pauses all NanoClaw outbound activity during Shabbat and Yom Tov. Messages received during these times are stored but not processed. After Shabbat ends, the message loop picks up queued messages on its next poll cycle. Optionally sends candle lighting reminders every erev Shabbat and erev Yom Tov.

## Timing Reference

- **Candle lighting**: 18 minutes before shkiya (sunset). This is when Shabbat/Yom Tov begins in practice.
- **Shkiya** (sunset): the halachic start boundary used by this system.
- **Tzeit hakochavim** (nightfall): calculated at 8.5 degrees below horizon.
- **Resume time**: tzeit + configurable buffer (default 18 minutes) on motzaei Shabbat/Yom Tov.

Note: the system activates at shkiya rather than candle lighting because candle lighting is preparation, while the halachic prohibition begins at shkiya. The system pauses 18 minutes *after* the household has already lit candles.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `shabbat-mode` is in `applied_skills`, skip to Phase 3 (Generate Schedule). The code changes are already in place.

### Ask the user

1. **Location** — latitude, longitude, and timezone for zmanim calculation. No default — the user must provide their location.
2. **Israel or Diaspora** — determines Yom Tov observance. Israel keeps 1-day Yom Tov, diaspora keeps 2 days.
3. **Candle lighting notifications** — send a reminder to the user every erev Shabbat and erev Yom Tov with the candle lighting time? Default: yes.
4. **Elevation** — meters above sea level. Default: 0m.
5. **Tzeit buffer** — extra minutes after tzeit hakochavim before resuming. Default: 18 minutes.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-shabbat-mode
```

This deterministically:
- Adds `src/shabbat.ts` (runtime module with `isShabbatOrYomTov()` binary search + candle lighting notifier)
- Adds `src/shabbat.test.ts` (12 test cases for boundary conditions and candle lighting)
- Adds `scripts/generate-zmanim.ts` (standalone schedule generator using `@hebcal/core`)
- Three-way merges Shabbat guards into `src/index.ts` (message loop + processGroupMessages)
- Three-way merges Shabbat guard into `src/task-scheduler.ts` (scheduler loop)
- Three-way merges Shabbat guard into `src/ipc.ts` (IPC watcher)
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — guard points in message loop and processGroupMessages
- `modify/src/task-scheduler.ts.intent.md` — guard point in scheduler loop
- `modify/src/ipc.ts.intent.md` — guard point in IPC watcher

### Validate code changes

```bash
npx vitest run src/shabbat.test.ts
npm test
npm run build
```

All 12 shabbat tests must pass, full suite must pass, and build must be clean before proceeding.

## Phase 3: Generate Schedule

### Install hebcal (one-time)

`@hebcal/core` is a standalone dependency for the generator script, not a project dependency:

```bash
npm install --no-save @hebcal/core
```

### Generate the schedule

```bash
SHABBAT_LAT=<lat> SHABBAT_LNG=<lng> SHABBAT_TIMEZONE=<tz> SHABBAT_IL=<true|false> npx tsx scripts/generate-zmanim.ts
```

| Variable | Required | Description |
|----------|----------|-------------|
| `SHABBAT_LAT` | Yes | Latitude |
| `SHABBAT_LNG` | Yes | Longitude |
| `SHABBAT_TIMEZONE` | Yes | IANA timezone (e.g. `America/New_York`, `Asia/Jerusalem`) |
| `SHABBAT_IL` | No | `true` for Israel (1-day Yom Tov), default `false` (diaspora) |
| `SHABBAT_LOCATION` | No | Cosmetic label for logs |
| `SHABBAT_ELEVATION` | No | Meters above sea level (default 0) |
| `SHABBAT_BUFFER` | No | Minutes after tzeit before resuming (default 18) |
| `SHABBAT_YEARS` | No | Years of schedule to generate (default 5) |

Expected output: `data/shabbat-schedule.json` with 300+ windows covering 5 years.

### Sanity-check

Verify the output:
- Has 300+ windows
- First upcoming Friday window starts at correct shkiya time for the location
- Yom Tov events are present (Rosh Hashana, Pesach, Sukkot, Shavuot, Yom Kippur)
- Multi-day Yom Tov merged into single windows
- Adjacent Shabbat+Yom Tov merged

## Phase 4: Build and Restart

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

## Phase 5: Verify

### Check logs

```bash
grep -i shabbat logs/nanoclaw.log | tail -5
```

Look for:
- `Shabbat schedule loaded` with window count — successful initialization
- `Shabbat schedule expires soon!` — schedule nearing expiration, regenerate

### Test behavior

During Shabbat: messages arrive in DB but no agent containers spawn, no outbound messages sent, no scheduled tasks execute, no IPC processed.

After Shabbat: message loop picks up queued messages, scheduler fires due tasks, IPC watcher processes pending files.

## Troubleshooting

### "No Shabbat schedule found, Shabbat mode disabled"

The schedule file doesn't exist. Generate it (see Phase 3), then restart the service.

### "Shabbat schedule expires soon!"

Regenerate the schedule (see Phase 3), then restart. The new schedule covers 5 years from the current date.

### Wrong times for location

Regenerate with correct coordinates (see Phase 3).
