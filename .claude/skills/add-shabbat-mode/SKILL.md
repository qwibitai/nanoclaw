---
name: add-shabbat-mode
description: "Pause all activity during Shabbat and Yom Tov"
---

# Add Shabbat Mode

This skill pauses all NanoClaw outbound activity during Shabbat and Yom Tov. Messages received during these times are stored in the database but not processed. After Shabbat/Yom Tov ends, the message loop picks up queued messages on its next poll cycle.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `shabbat-mode` is in `applied_skills`, skip to Phase 3 (Generate Schedule). The code changes are already in place.

### Ask the user

1. **Location** — latitude, longitude, and timezone for zmanim calculation. Default: Crown Heights, Brooklyn (40.669, -73.943, America/New_York).
2. **Elevation** — meters above sea level. Default: 25m.
3. **Tzeis buffer** — extra minutes after tzeis hakokhavim before resuming. Default: 18 minutes.

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
- Adds `src/shabbat.ts` (runtime module with `isShabbatOrYomTov()` binary search)
- Adds `src/shabbat.test.ts` (9 test cases for boundary conditions)
- Adds `scripts/generate-zmanim.ts` (schedule generator using `@hebcal/core`)
- Three-way merges Shabbat guards into `src/index.ts` (message loop + processGroupMessages)
- Three-way merges Shabbat guard into `src/task-scheduler.ts` (scheduler loop)
- Three-way merges Shabbat guard into `src/ipc.ts` (IPC watcher)
- Installs `@hebcal/core` as dev dependency
- Adds `generate-zmanim` npm script
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

All 9 shabbat tests must pass, full suite must pass, and build must be clean before proceeding.

## Phase 3: Generate Schedule

### Set location (if not default)

If the user provided custom coordinates, set environment variables before generating:

```bash
export SHABBAT_LAT=<lat>
export SHABBAT_LNG=<lng>
export SHABBAT_TIMEZONE=<tz>
export SHABBAT_ELEVATION=<meters>
export SHABBAT_BUFFER=<minutes>
export SHABBAT_LOCATION="<name>"
```

### Generate the schedule

```bash
npm run generate-zmanim
```

Expected output: `data/shabbat-schedule.json` with 300+ windows covering 5 years.

### Sanity-check

Verify the output:
- Has 300+ windows
- First upcoming Friday window starts at correct shkiya time for the location
- Yom Tov events are present (Rosh Hashana, Pesach, Sukkos, Shavuos, Yom Kippur)
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

The schedule file doesn't exist. Generate it:

```bash
npm run generate-zmanim
```

Then restart the service.

### "Shabbat schedule expires soon!"

Regenerate the schedule:

```bash
npm run generate-zmanim
```

Then restart the service. The new schedule covers 5 years from the current date.

### Messages not being processed after Shabbat

Check that `data/shabbat-schedule.json` has correct tzeis times for your location. The buffer (default 18 min) is added after tzeis hakokhavim at 8.5 degrees below horizon.

### Wrong times for location

Regenerate with correct coordinates:

```bash
SHABBAT_LAT=<lat> SHABBAT_LNG=<lng> SHABBAT_TIMEZONE=<tz> npm run generate-zmanim
```
