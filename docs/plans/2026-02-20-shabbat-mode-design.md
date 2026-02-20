# Shabbat Mode Design

## Summary

NanoClaw pauses all outbound activity during Shabbat and Yom Tov. Messages received during these times are queued and processed after Shabbat/Yom Tov ends.

## Timing

- **Start**: shkiya (sunset) on erev Shabbat/Yom Tov
- **End**: 18 minutes after tzeis hakokhavim (nightfall) on Motzei Shabbat/Yom Tov
- **Location**: Crown Heights, Brooklyn (40.669, -73.943)
- **Multi-day Yom Tov**: treated as one continuous window (e.g. first days Sukkos = one window from erev through tzeis + 18 of second day)

## Holidays Observed

Shabbat (every week) plus Yom Tov:
- Rosh Hashana (2 days)
- Yom Kippur
- Sukkos (first 2 days + Shmini Atzeres/Simchas Torah)
- Pesach (first 2 days + last 2 days)
- Shavuos (2 days)

Not observed: Chol HaMoed, fast days, minor holidays.

## Architecture

### Generator Script (`scripts/generate-zmanim.ts`)

- Dev dependency: `@hebcal/core`
- Generates 5 years of Shabbat/Yom Tov windows
- Output: `data/shabbat-schedule.json`
- Run via `npm run generate-zmanim`
- Re-run when schedule approaches expiration

### Schedule File (`data/shabbat-schedule.json`)

```json
{
  "location": "Crown Heights, Brooklyn",
  "coordinates": [40.669, -73.943],
  "generatedAt": "2026-02-20T...",
  "expiresAt": "2031-02-20T...",
  "windows": [
    { "start": "2026-02-20T17:23:00-05:00", "end": "2026-02-21T18:49:00-05:00", "type": "shabbat" },
    { "start": "2026-03-13T18:52:00-04:00", "end": "2026-03-14T19:10:00-04:00", "type": "yomtov" }
  ]
}
```

### Runtime Module (`src/shabbat.ts`)

- Loads schedule JSON at startup
- Exposes `isShabbatOrYomTov(): boolean`
- Binary search on sorted windows array for O(log n) lookup
- Logs warning at startup if schedule expires within 30 days

### Guard Points

1. **`src/index.ts` — `processGroupMessages()`**: Skip processing; don't advance per-group cursor so messages queue naturally
2. **`src/task-scheduler.ts` — `runTask()`**: Skip execution; don't update `next_run` so task fires again after
3. **`src/ipc.ts` — `processIpcFiles()`**: Skip sending; leave files in place for post-Shabbat processing

## Behavior During Shabbat

- Incoming messages are received and stored in the database (WhatsApp connection stays open)
- No agent containers are spawned
- No outbound messages are sent
- No scheduled tasks execute
- No IPC messages are processed
- After Shabbat ends, the message loop picks up queued messages on its next poll cycle
