---
name: coo-briefing
description: "Generate the Proper Hospitality COO Briefing covering all 12 properties. Pulls ProfitSword P&L, Snowflake STR/ALICE/Revinate/Duetto data, formats as HTML email + Telegram summary. Trigger: 'run the COO briefing', 'generate COO report', 'morning brief', '/coo-briefing'."
---

# COO Briefing

Generate the daily COO Briefing for all 12 Proper Hospitality properties. Outputs an HTML email to Gabriel.Ratner@properhotel.com and a compact Telegram summary.

## Data Sources

| Source | Location | What it provides |
|---|---|---|
| ProfitSword Forecast | `scripts/profitsword/scripts/profitsword_api.py --dataset-id 1` | MTD Forecast (Rooms + Revenue) |
| ProfitSword Budget | `--dataset-id 2` | MTD Budget |
| ProfitSword Actuals | `--dataset-id -3 --year [current year]` | MTD Actuals (rooms sold, revenue) |
| Snowflake Duetto | `DUETTO_UPLOAD.RAW.DUETTO_BUDGET_VS_PY` | OTB by window (0-30/31-60/61-90), vs STLY, vs Budget |
| Snowflake STR Monthly | `DUETTO_UPLOAD.RAW.STR_MONTHLY` | MPI/ARI/RGI indices + rank |
| Snowflake ALICE | `DUETTO_UPLOAD.RAW.GLITCH_REPORTS_RAW` | Glitch tickets last 7d |
| Snowflake Revinate | `CORE_REVINATE.RAW_API.RAW_REVIEWS` | NPS + rating L30d/Last7d/Prior7d |
| Snowflake Lighthouse | `DUETTO_UPLOAD.RAW.LIGHTHOUSE_RATES` | Events next 7 days |

## Property Reference

Load from `references/property_mapping.json` for all name/code/tag mappings. Never hardcode property names in queries.

## Step 0: Deduplication Check

```bash
TODAY=$(date +%Y-%m-%d)
CACHE_DIR=/workspace/project/data/coo-prefetch/$TODAY
ls $CACHE_DIR/brief_sent.flag 2>/dev/null && echo "ALREADY SENT -- exiting" && exit 0
```
If flag exists, stop immediately.

## Step 1: Cache Check

```bash
ls $CACHE_DIR/manifest.json 2>/dev/null && echo "CACHE HIT" || echo "CACHE MISS"
YESTERDAY_CACHE=/workspace/project/data/coo-prefetch/$(date -d "yesterday" +%Y-%m-%d)
WEEK_AGO_CACHE=/workspace/project/data/coo-prefetch/$(date -d "7 days ago" +%Y-%m-%d)
```

Cache file locations:

| Data | Path |
|---|---|
| ProfitSword Forecast | `$CACHE_DIR/profitsword/{CODE}_fcst.csv` |
| ProfitSword Budget | `$CACHE_DIR/profitsword/{CODE}_bud.csv` |
| ProfitSword Actuals | `$CACHE_DIR/profitsword/{CODE}_act.csv` |
| Duetto Pace | `$CACHE_DIR/snowflake/duetto_pace.json` |
| STR Monthly | `$CACHE_DIR/snowflake/str_monthly.json` |
| ALICE Glitches | `$CACHE_DIR/snowflake/alice.json` |
| Revinate Reviews | `$CACHE_DIR/snowflake/revinate.json` |
| Lighthouse Events | `$CACHE_DIR/snowflake/lighthouse.json` |

If CACHE MISS (manual/daytime run), fetch live with the queries below and continue.

## Step 2: Load All Data into Memory

Load all cached files into Python dicts before generating any output. One pass through the data, no repeated file reads.

```python
import json, os, csv

CACHE = os.environ.get('CACHE_DIR', f'/workspace/project/data/coo-prefetch/{TODAY}')
YCACHE = YESTERDAY_CACHE  # may not exist
WCACHE = WEEK_AGO_CACHE   # may not exist

# Load duetto_pace.json (STAY_DATE rows per hotel)
with open(f'{CACHE}/snowflake/duetto_pace.json') as f:
    duetto_rows = json.load(f)

# Load revinate.json
with open(f'{CACHE}/snowflake/revinate.json') as f:
    revinate_rows = json.load(f)

# Load ALICE
with open(f'{CACHE}/snowflake/alice.json') as f:
    alice_raw = json.load(f)

# Load STR Monthly
with open(f'{CACHE}/snowflake/str_monthly.json') as f:
    str_rows = json.load(f)

# Load Lighthouse events
lh_rows = []
lh_path = f'{CACHE}/snowflake/lighthouse.json'
if os.path.exists(lh_path):
    with open(lh_path) as f:
        lh_rows = json.load(f)

# Load yesterday's and 7-day-ago Duetto for DoD/7D pickup
yd_duetto, wd_duetto = [], []
if os.path.exists(f'{YCACHE}/snowflake/duetto_pace.json'):
    with open(f'{YCACHE}/snowflake/duetto_pace.json') as f:
        yd_duetto = json.load(f)
if os.path.exists(f'{WCACHE}/snowflake/duetto_pace.json'):
    with open(f'{WCACHE}/snowflake/duetto_pace.json') as f:
        wd_duetto = json.load(f)
```

## Step 3: Compute Per-Hotel Data

For each hotel, compute all metrics before generating HTML. Stored in a dict indexed by hotel code.

### Pickup & Pace (from Duetto)

The Duetto file contains one row per STAY_DATE per SEGMENT per HOTEL_CODE. Filter to Total segment only for the Pickup & Pace table.

Compute four windows per hotel (Total segment):
- **MTD**: STAY_DATE >= first day of current month AND <= today
- **0-30**: STAY_DATE >= today+1 AND <= today+30
- **31-60**: STAY_DATE >= today+31 AND <= today+60
- **61-90**: STAY_DATE >= today+61 AND <= today+90

Per window: sum OTB_ROOMS, sum OTB_REVENUE, STLY_REVENUE, BUDGET_REVENUE. ADR = OTB_REVENUE / OTB_ROOMS.

vs STLY % = (OTB_REVENUE - STLY_REVENUE) / STLY_REVENUE. If STLY_REVENUE = 0, show "--".
vs Budget % = (OTB_REVENUE - BUDGET_REVENUE) / BUDGET_REVENUE. If BUDGET_REVENUE = 0, show "--".

**DoD Delta Rev**: Compare today's OTB_REVENUE for each window against yesterday's cache (same hotel, same window definition). If yesterday's cache is missing, show "--".

**7D Pickup Rev**: Compare today's OTB_REVENUE for the 0-30 window against the 7-day-ago cache. If week-ago cache is missing, fall back to DoD delta * 7 (mark as "~est"). If neither is available, show "--".

MTD has no 7D Pickup (it shifts each day); show DoD delta only for MTD.

### Forecast Accuracy MTD (from ProfitSword)

Load `{CODE}_act.csv`, `{CODE}_fcst.csv`, `{CODE}_bud.csv`. Filter to current month rows.

Extract:
- Rooms Actual = RF0001 Stat from actuals CSV (current month, current year)
- Rooms Forecast = RF0001 Stat from fcst CSV
- Rooms Budget = RF0001 Stat from bud CSV
- Revenue Actual = TOTOPRV Amt from actuals CSV
- Revenue Forecast = TOTOPRV Amt from fcst CSV
- Revenue Budget = TOTOPRV Amt from bud CSV

vs Fcst % = (Actual - Forecast) / Forecast. vs Budget % = (Actual - Budget) / Budget.

If actuals CSV is missing (prefetch didn't run today's actuals call), show "Actuals pending".

### STR (from str_daily.json + str_monthly.json)

Three periods required: **CurrWk**, **R28**, **YTD**. Three segments: **Total**, **Transient**, **Group**.

**CurrWk and R28 -- computed from str_daily.json:**

STR publishes with ~7 day lag. Find the max DATE in str_daily.json -- that is the latest published date. Then:
- **CurrWk**: rows where DATE >= (max_date - 6). Average OCC_INDEX, ADR_INDEX, REVPAR_INDEX across those 7 days per hotel per segment.
- **R28**: rows where DATE >= (max_date - 27). Average OCC_INDEX, ADR_INDEX, REVPAR_INDEX across up to 28 days per hotel per segment. If fewer than 20 days of data are available for a hotel, append "(partial N days)" to the R28 row.

**YTD -- from str_monthly.json:**

PERIOD_TYPE in this table is year-labelled (e.g. "2026 YTD"). Use the row where PERIOD_TYPE contains the current year and "YTD" -- e.g. `PERIOD_TYPE == '2026 YTD'`. Per hotel per segment, read OCC_INDEX, ADR_INDEX, REVPAR_INDEX directly.

**RANK:** Present in STR_DAILY as `"RANK"` (double-quoted -- it is a SQL reserved word). Do NOT average rank. Take the value from the single most recent DATE row per hotel per segment. If the cached str_daily.json was fetched without the RANK column (legacy cache), show "--" for rank cells.

**Data freshness:** Show "(as of [max_date])" in the STR section header. If max_date < today - 14, add "(stale -- no recent STR data)".

If a hotel has no entries at all in either file, show "(no STR data)" for that hotel's section.

### Guest Experience -- Revinate

**IMPORTANT: This table uses CORE_REVINATE.RAW_API.RAW_REVIEWS (NOT PROD.FACT_REVIEWS).**

Deduplicate by (HOTEL_NAME, DATE_REVIEW, REVIEW_SOURCE) before computing averages.

Three windows:
- L30d: reviews where DATE_REVIEW >= today-30
- Last 7d: reviews where DATE_REVIEW >= today-7
- Prior 7d: reviews where DATE_REVIEW >= today-14 AND < today-7

Per window compute:
- NPS: average of NPS column (NPS is only populated for Survey source, not Google/Booking)
- Rating: average of RAW_JSON:rating (1-5 scale, populated for all external reviews)
- Review count

WoW NPS delta = Last 7d NPS - Prior 7d NPS (show with sign, e.g. "+0.8" or "-1.2").

If L30d review count < 5, show NPS as "--" (not statistically meaningful).

### Operations -- ALICE (Glitch Tickets, Last 7d)

**DATA QUALITY: GLITCH_REPORTS_RAW pipeline loads each day 20-35x. Always deduplicate before counting.**

```python
seen = set()
dedup_alice = []
for r in alice_raw:
    key = (r['PROPERTY'], r.get('PARSED_DATE', r.get('DATE','')), r['TYPE'], r['GLITCH_ISSUE'])
    if key not in seen:
        seen.add(key)
        dedup_alice.append(r)
```

Filter to last 7 days by parsed date. Per hotel:
- Tickets: total count
- Resolved: count where STATUS in ('Resolved', 'Closed', 'Completed') -- check actual values first

- Est. Comp: sum of TRY_TO_NUMBER(REPLACE(REPLACE(COMPENSATION,'$',''),',',''))
- Top Issue: most frequent GLITCH_ISSUE with count

If no ALICE data for hotel, show "--" in all columns.

Max date of ALICE data: if more than 14 days old, show "(pipeline stale)" in section header.

### Events (from Lighthouse, next 7 days)

From lighthouse.json, filter to IS_OWN_HOTEL=TRUE, LOS=1, dates in next 7 days. Deduplicate on EVENT_NAME + DATE.

Show: Date | Event | Type

If Lighthouse cache is missing, show "Events: data not available."

---

## Report Structure

### HTML Email Format

```
COO Daily Briefing -- [Day of week], [Month] [Date], [Year]
Portfolio view across 12 properties · Pace, Forecast Accuracy, Guest Experience, Ops · Day-over-Day deltas vs yesterday
```

**CSS rules:**
- Black default text for all numbers. Red for negative variance only. Green for positive variance only. Never color by magnitude -- direction determines color.
- Section headers: dark bold (#1a1a1a, font-weight 700).
- Tables: full-width, no two-column layout.
- ALICE section: amber card class.
- Revinate section: green card class.

---

### 1. Top 5 Portfolio Takeaways

Auto-generate five specific, data-driven bullets from the full computed dataset. Each bullet = one finding. Priority order: biggest DoD mover, biggest pace gap, NPS drops, RGI watchlist items, strong performers.

Format: "[Hotel short name] [specific metric and direction] -- [one-line context]."

Example bullets:
- "Avalon PS pacing -20% vs STLY (0-30d) -- biggest gap in portfolio."
- "Santa Monica leads 7-day pickup at $463K in 0-30d window."
- "Shelborne NPS dropped -1.2 WoW (last 7d 7.8 vs prior 9.0)."
- "Day-over-day: Shelborne shed $140K in 0-30d revenue since yesterday."

Do not pad with generic observations. If fewer than 5 meaningful signals, use 4 or 3.

---

### 2. Executive Summary

Seven cross-portfolio tables. Use the full computed dataset -- no extra API calls.

**Table 1 -- 7-Day Pickup Leaders (0-30d window)**

| Hotel | 7D Pickup Rev |
|---|---|

Show top 5 hotels by 7D Pickup Rev in the 0-30d window, descending.

**Table 2 -- Largest Pace Gaps vs STLY (0-30d)**

| Hotel | Revenue | STLY Revenue | Gap % |
|---|---|---|---|

Show hotels where 0-30d vs STLY % < -10%. Sort by gap % ascending (most negative first). If fewer than 3 hotels qualify, show top 3 by largest negative gap.

**Table 3 -- Day-over-Day Revenue Movers (0-30d)**

| Hotel | Today | Yesterday | Change |
|---|---|---|---|

Show top 5 DoD movers by absolute change (both positive and negative). Sort by absolute value of change, descending. Label gains with "+" and losses with "-".

**Table 4 -- Forecast Accuracy MTD (largest variances)**

| Hotel | Actual MTD | Forecast MTD | Variance |
|---|---|---|---|

Show hotels sorted by absolute variance %, largest first. Show top 6. Variance = Revenue Actual vs Revenue Forecast.

**Table 5 -- RGI Watchlist (YTD Total RevPAR Index < 90)**

| Hotel | RevPAR Index (YTD) | RevPAR Index (R28) | Rank |
|---|---|---|---|

Show all hotels where Total/YTD RevPAR Index < 90. Include R28 for trend direction and latest-day rank. If none, omit this table.

**Table 6 -- Guest Experience WoW NPS Drops (Last 7d vs Prior 7d)**

| Hotel | Last 7d NPS | Prior 7d NPS | Delta |
|---|---|---|---|

Show hotels where WoW NPS delta < -0.5. Sort by delta ascending (largest drop first). Omit table if no drops.

**Table 7 -- Operations: ALICE Ticket Volume (last 7d)**

| Hotel | Tickets | Est. Comp | Top Issue |
|---|---|---|---|

Show all hotels that had any ALICE tickets in last 7d, sorted by ticket count descending.

---

### 3. Property Detail

For each hotel in portfolio order (SMP, DTLA, HJL, HJM, ATX, SFP, SHEL, MYC, TCH, ING, AVBH, AVPS):

**Hotel header:** Full name (from property_mapping.json) + room count. Example: "Austin Proper (Rooms: 238)".

#### 3a. Top 5 Takeaways

Auto-generate 5 hotel-specific bullets from its computed data. Examples of what to look for:
- 0-30d pace vs STLY with pickup direction
- MTD revenue vs STLY and vs budget
- STR RGI vs 90 threshold and rank
- Forward window (31-60 or 61-90) signals
- DoD revenue delta
- NPS WoW direction with context (review count)
- Upcoming demand events

Format: one sentence per bullet, specific numbers, no filler.

#### 3b. Pickup & Pace

| Window | OTB Rooms | OTB Rev | ADR | vs STLY | vs Budget | 7D Pickup | DoD Delta Rev |
|---|---|---|---|---|---|---|---|
| MTD | | | | | | -- | |
| 0-30 | | | | | | | |
| 31-60 | | | | | | | |
| 61-90 | | | | | | | |

All values from Total segment Duetto data.

#### 3c. Forecast Accuracy (MTD)

| Metric | Actual | Forecast | Budget | vs Fcst | vs Budget |
|---|---|---|---|---|---|
| Rooms | | | | | |
| Revenue | | | | | |

#### 3d. STR

Three sub-tables, one per segment: Total, Transient, Group.

Single 9-row x 8-column table. Rows = 3 segments x 3 periods. Rank = latest-day value from STR_DAILY (not averaged); show "--" if not in cache.

| Segment | Period | Occ Index | ADR Index | RevPAR Index | Occ Rank | ADR Rank | RevPAR Rank |
|---|---|---|---|---|---|---|---|
| Total | CurrWk | | | | | | |
| Total | R28 | | | | | | |
| Total | YTD | | | | | | |
| Transient | CurrWk | | | | | | |
| Transient | R28 | | | | | | |
| Transient | YTD | | | | | | |
| Group | CurrWk | | | | | | |
| Group | R28 | | | | | | |
| Group | YTD | | | | | | |

If any RevPAR Index < 90, add "(watchlist)" in red. Do NOT revert to the old single-line MPI/ARI/RGI format.

#### 3e. Guest Experience -- Revinate (last 30d and WoW)

| Metric | L30d | Last 7d | Prior 7d | WoW Delta |
|---|---|---|---|---|
| NPS | | | | |
| Rating (0-5) | | | | |
| Reviews | | | | |

NPS WoW delta in red if < -0.5, green if > +0.5.
If L30d NPS < 7.5, note in amber "(below threshold)".

#### 3f. Operations -- ALICE (last 7d)

| Tickets | Resolved | Est. Comp | Top Issue |
|---|---|---|---|
| | | | |

If no ALICE data, show one row: "-- | -- | -- | No ALICE data"

#### 3g. Events (next 7 days)

| Date | Event | Type |
|---|---|---|

From Lighthouse. If no events, show "None listed."

---

## Output

**HTML email** to Gabriel.Ratner@properhotel.com ONLY via `mcp__outlook__send-email`.
Subject: "COO Briefing -- [Month Day, Year]".

**ABSOLUTE RULE: NO CC, NO BCC, ever.** One recipient: Gabriel.Ratner@properhotel.com. No exceptions.

**Telegram** via `send_message`. Under 4000 chars. Format:
- Header: "COO Briefing [Date]"
- Top 5 Portfolio Takeaways (bullets)
- Per hotel one line each: hotel short name + worst metric (DoD delta, or pace gap, or NPS if flagged). Skip hotels with nothing noteworthy.

**After both email and Telegram are sent**, write the completion flag:
```bash
touch /workspace/project/data/coo-prefetch/$TODAY/brief_sent.flag
```

## Data Quality Rules

- **ALICE dedup is mandatory.** Raw counts are 20-35x inflated. Always dedup on (PROPERTY, DATE, TYPE, GLITCH_ISSUE) before any count.
- **EBLSFFE not EBITDA.** If showing EBITDA anywhere, always use the EBLSFFE ItemTag. The EBITDA tag is pre-reserve and overstates by $50K-$300K.
- **Actuals dataset.** Current-year Actuals = dataset -3 with year=CURRENT_YEAR. These are fetched as `{CODE}_act.csv` in the prefetch. If missing, show "Actuals pending" for that hotel.
- **Revinate table.** Always use CORE_REVINATE.RAW_API.RAW_REVIEWS, NOT PROD.FACT_REVIEWS.
- **STAY_DATE in Duetto.** Format is YYYYMMDD integer. Convert to date before comparing to CURRENT_DATE.
- **No em dashes.** Use " -- " or colons.
- **No exclamation marks.**
- **Numbers:** always with commas and $ where appropriate.

## SPELLING AND NAMING -- CRITICAL

Use FULL NAME from property_mapping.json. Never abbreviate. Specifically:
- "The Shelborne By Proper" -- NOT "Shelborne South Beach", "Shelborne Miami", etc.
- "The Culver Hotel" -- NOT "TCH"
- "Montauk Yacht Club" -- NOT "MYC"
- "Ingleside Estate" -- NOT "ING"
- "Avalon Hotel and Bungalows Palm Springs" -- NOT "Avalon PS" (only in takeaway bullets for brevity)
