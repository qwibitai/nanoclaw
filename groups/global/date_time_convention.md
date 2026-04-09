# Date/time convention for Google Sheets (ALL family sheets)

**STRICT RULE.** All timestamps written to any Portillo family Google Sheet use a single format — no ISO 8601, no `T`, no `Z`, no timezone suffix.

## Format

`YYYY-MM-DD HH:MM:SS`

Examples:
- `2026-04-07 14:30:00`
- `2026-04-07 08:15:42`

## Timezone

All sheets assume **America/Chicago**. Never mix zones in a single column. Never embed the zone in the value.

## Why

Sheets natively recognizes this format as a datetime serial — it sorts chronologically, supports `FILTER` / `QUERY` / `DATEDIF` / `TEXT` / date math, and round-trips cleanly through scripts. ISO 8601 strings (`2026-04-07T14:30:00Z`) get stored as text because of the `T` and `Z`, which breaks every date function downstream.

## Writing (from agents / scripts)

Use the Swedish locale, which outputs exactly this format:

```js
new Date().toLocaleString('sv-SE', { timeZone: 'America/Chicago' })
// → "2026-04-07 14:30:00"
```

Bash equivalent:

```bash
TZ=America/Chicago date '+%Y-%m-%d %H:%M:%S'
```

## Reading (from the Sheets API)

When fetching, request `valueRenderOption=FORMATTED_VALUE` so the string comes back as written, not as a serial number. If you get a serial number, the column was formatted as Date/Time — convert or re-request with FORMATTED_VALUE.

## Never write

- `2026-04-07T14:30:00Z`
- `2026-04-07T14:30:00-05:00`
- `4/7/2026 2:30 PM` (US format — ambiguous internationally)
- Epoch seconds
- Any value with a `T` or `Z` in it

## Affected sheets

- **Emilio Tracking** (`1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM`) — Feedings, Diaper Changes, Milk Pump, Sleep Log
- **Silverthorne Household** (`1I3YtBJkFU22xTq1CRqRDjQ1ITrs5nApsfkUV9-jQb-4`) — Chores, Chore Log, Pets, Pet Log, Announcements
- **Portillo Games** (`1ugYotsqO8UQBydtttEJ4NvnRTN1IbA0-3No7TncSeLY`) — Wordle Submissions, Panda Submissions, Panda Love Map

## Migration of existing rows

Each sheet-owning group is responsible for a one-time migration pass of its own sheet. When asked to migrate, walk every tab with timestamp columns, convert any ISO-style value in place to the format above (interpreting the instant in America/Chicago), and leave already-correct rows untouched. Do NOT drop rows. Do NOT change column headers. After migration, set the column format to Format → Number → Date time in the sheet UI so new writes display consistently.
