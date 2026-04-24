---
name: coo-briefing
description: "Generate the Proper Hospitality COO Briefing covering all 12 properties. Pulls ProfitSword P&L, Snowflake STR/ALICE/Revinate/Duetto data, Toast F&B, formats as HTML email + Telegram summary. Trigger: 'run the COO briefing', 'generate COO report', 'morning brief', '/coo-briefing'."
---

# COO Briefing

Generate the daily COO Briefing for all 12 Proper Hospitality properties. Outputs an HTML email to Gabriel.Ratner@properhotel.com and a compact Telegram summary.

## Data Sources

| Source | Location | What it provides |
|---|---|---|
| ProfitSword API | `/workspace/project/scripts/profitsword/scripts/profitsword_api.py` | P&L: Forecast, Budget, Actuals, Prior Year |
| Snowflake STR_DAILY | `DUETTO_UPLOAD.RAW.STR_DAILY` | Competitive index (MPI/ARI/RGI) -- always included |
| Snowflake STR_MONTHLY | `DUETTO_UPLOAD.RAW.STR_MONTHLY` | YTD competitive index -- always included |
| Snowflake ALICE | `DUETTO_UPLOAD.RAW.GLITCH_REPORTS_RAW` | Guest glitches, compensation |
| Snowflake Revinate | `CORE_REVINATE.RAW_API.RAW_REVIEWS` (NOT PROD -- RAW is 6x more data + current) | Guest review scores, sub-ratings from RAW_JSON |
| Snowflake Duetto Pace | `DUETTO_UPLOAD.RAW.DUETTO_BUDGET_VS_PY` | OTB pace vs STLY/Forecast/Budget |
| Toast POS API | `/workspace/project/scripts/toast/scripts/toast_api.py` | F&B revenue by outlet |

## Property Reference

Load from `references/property_mapping.json` for all name mappings. Do NOT hardcode property names in queries -- always reference the mapping file.

## Deduplication Check -- DO THIS FIRST

Check if the brief already ran today. If it did, exit immediately without sending anything.

```bash
TODAY=$(date +%Y-%m-%d)
CACHE_DIR=/workspace/project/data/coo-prefetch/$TODAY
ls $CACHE_DIR/brief_sent.flag 2>/dev/null && echo "ALREADY SENT TODAY -- exiting" || echo "NOT YET SENT -- proceeding"
```

**If flag exists:** Stop. Do not generate or send anything. The brief was already delivered today.

## Cache Check -- DO THIS SECOND BEFORE ANY DATA FETCHING

Check whether the pre-fetch job cached all data:

```bash
TODAY=$(date +%Y-%m-%d)
CACHE_DIR=/workspace/project/data/coo-prefetch/$TODAY
ls $CACHE_DIR/manifest.json 2>/dev/null && echo "CACHE HIT" || echo "CACHE MISS"
```

**If CACHE HIT:** Read all data from cached files instead of making live API calls. This is the normal path (runs every night at 3:45am after the 3am pre-fetch).

| Data Source | Cached File Path |
|---|---|
| ProfitSword Forecast | `$CACHE_DIR/profitsword/{CODE}_fcst.csv` |
| ProfitSword Budget | `$CACHE_DIR/profitsword/{CODE}_bud.csv` |
| ProfitSword Actuals | `$CACHE_DIR/profitsword/{CODE}_act.csv` |
| ProfitSword Last Year | `$CACHE_DIR/profitsword/{CODE}_ly.csv` |
| STR Daily | `$CACHE_DIR/snowflake/str_daily.json` |
| STR Monthly | `$CACHE_DIR/snowflake/str_monthly.json` |
| ALICE Glitches | `$CACHE_DIR/snowflake/alice.json` |
| Revinate Reviews | `$CACHE_DIR/snowflake/revinate.json` |
| Duetto Pace | `$CACHE_DIR/snowflake/duetto_pace.json` |
| Toast F&B | `$CACHE_DIR/toast/sales_summary.csv` |

Read cached files with:
```bash
python3 -c "import json; data=json.load(open('$CACHE_DIR/snowflake/str_daily.json')); print(f'{len(data)} rows')"
```

Snowflake JSON files contain arrays of row objects -- filter by hotel name/code as needed when building each hotel section. Property code-to-name mapping is in `references/property_mapping.json`.

**If CACHE MISS (manual/daytime run):** Proceed with live API calls as documented in each section below. Add note "Running without cache -- live data fetch" in the Telegram summary.

## Report Mode

Check the day of week before building the report:

```bash
DOW=$(date +%u)  # 1=Monday ... 7=Sunday
[ "$DOW" = "1" ] && REPORT_MODE="full" || REPORT_MODE="delta"
echo "Report mode: $REPORT_MODE (DOW=$DOW)"
```

- **Monday (REPORT_MODE=full):** All 6 sections per hotel at full depth, same as the spec below.
- **Tuesday-Sunday (REPORT_MODE=delta):** Only show what moved since yesterday. Each section has a "Daily mode" note. Yesterday's prefetch cache:

```bash
YESTERDAY_CACHE=/workspace/project/data/coo-prefetch/$(date -d "yesterday" +%Y-%m-%d)
```

If yesterday's cache does not exist for a section, fall back to full mode for that section and note "First run -- no prior cache."

## HTML Styling

- Title: "COO Briefing" in large DARK font (#1a1a1a, font-weight 700, 28px)
- All section headers: dark font, bold, clearly readable (never light gray)
- Each hotel: FULL NAME as header (e.g., "Santa Monica Proper Hotel" not "SMP")
- Every data section: full-width card, NO two-column layout
- Layout order per hotel: P&L > STR > Duetto Pace > ALICE > Revinate > Toast F&B > COO Actions
- CSS classes: ALICE = `section-card alice-card` (amber), Revinate = `section-card revinate-card` (green)
- **Color rule: use black as the default text color for all numbers.** Use red ONLY for negative variances or negative trends. Use green ONLY for positive variances or positive trends. Never color a number red or green just because it is large or small -- only based on direction of variance.

## Sections (per hotel)

### 1. P&L Snapshot (ProfitSword)

Current month + next month side by side (2 months only). Compare: Forecast vs Budget vs Prior Year.

Run via Bash for each property. Pull BOTH MONTHS IN ONE CALL (more efficient, fewer timeouts):
```bash
# Primary Forecast (both months at once)
python3 /workspace/project/scripts/profitsword/scripts/profitsword_api.py \
  --endpoint monthly_extended --site-tag [TAG] --dataset-id 1 \
  --year 2026 --begmonth [CURRENT_MONTH] --endmonth [CURRENT_MONTH+1] \
  --include-totals Y --output /tmp/ps_fcst_[TAG].csv

# Budget (both months at once)
python3 /workspace/project/scripts/profitsword/scripts/profitsword_api.py \
  --endpoint monthly_extended --site-tag [TAG] --dataset-id 2 \
  --year 2026 --begmonth [CURRENT_MONTH] --endmonth [CURRENT_MONTH+1] \
  --include-totals Y --output /tmp/ps_bud_[TAG].csv
```

Also pull Last Year (LY) for the same months from prior year:
```bash
# LY (same months, year-1)
python3 /workspace/project/scripts/profitsword/scripts/profitsword_api.py \
  --endpoint monthly_extended --site-tag [TAG] --dataset-id -3 \
  --year 2025 --begmonth [CURRENT_MONTH] --endmonth [CURRENT_MONTH+1] \
  --include-totals Y --output /tmp/ps_ly_[TAG].csv
```

That is 3 calls per property (36 total): Primary Forecast + Budget + LY.

DataSet IDs: 1=Primary Forecast, 2=Budget, -3=Actuals (used only for LY with year=2025). Do NOT fetch current-year Actuals -- they are not displayed.

IMPORTANT: Run ALL 12 properties. Do NOT skip any. If a call fails or returns 0 rows, note "ProfitSword: error for [property]" and continue to the next. Do NOT stop the entire report because one property fails.

CSV columns: SiteTag, siteName, ItemTag, Description, AccountNumber, StatAccount, Year, Month, Stat, Amt

Filter to these ItemTags only:

| P&L Line | ItemTag |
|---|---|
| Rooms Sold (room nights) | RF0001 |
| Available Rooms | RMAVL |
| ADR | RF0003 |
| Room Revenue | TOTRMRV |
| Room Expense | TOTRMEX |
| F&B Revenue | RF0007 |
| F&B Expense | RF0008 |
| Total Revenue | TOTOPRV |
| GOP | TOTGOP |
| EBITDA after Reserves | EBITDA |

**ALWAYS show TWO tables per hotel -- current month AND next month.** Label each table clearly with the month name (e.g., "April 2026" and "May 2026"). Never collapse to one month or omit next month.

Each table has TWO parts:

**Part 1 -- KPI Summary (above the P&L rows):** Show these four KPIs computed from the fetched data:
- Room Nights = RF0001 Stat
- Occupancy % = RF0001 Stat / RMAVL Stat (express as %, e.g. "79.5%")
- ADR = RF0003 Amt / RF0003 Stat (dollar value, e.g. "$556")
- RevPAR = RF0003 Amt / RMAVL Stat (dollar value, e.g. "$442")

Show these four KPIs as a header row above the P&L table, with the same column structure: Primary Forecast | Budget | vs Bud $ | vs Bud % | LY | vs LY %

**Part 2 -- P&L rows:**
Room Revenue | Room Expense | F&B Revenue | F&B Expense | Total Revenue | GOP | EBITDA after Reserves

Each table columns: Primary Forecast | Budget | vs Bud $ | vs Bud % | LY (Last Year) | vs LY %

The first column is ALWAYS Primary Forecast (dataset 1) for both current month and next month. Do NOT use Actuals (dataset -3) as a table column under any circumstances -- Actuals data is fetched for reference only and must not appear as a column in the output.

Label the prior year column "LY" not "STLY" or "PY".

Color: black by default. Red for negative variance. Green for positive variance.

If 0 rows returned for a month, show "ProfitSword: no data for [month]" -- but still show the other month's table.

**Daily mode:** Show one summary line per hotel only: "[Hotel] -- [Month] Total Rev: $X.XM ([+/-X%] vs Bud) | GOP: $X.XM ([+/-X%] vs Bud)." Skip next month table. If Forecast vs Budget variance is > 5% adverse, show the full table instead and flag it.

### 2. STR Competitive Index (Snowflake) -- EVERY DAY

Always include this section. STR data refreshes Tuesday nights so mid-week data is the same until next refresh -- show it with the data date so Gabe knows how fresh it is.

Check the max date and show it in the section header:
```sql
SELECT MAX(DATE) FROM DUETTO_UPLOAD.RAW.STR_DAILY
```
Label the section header: "STR Competitive Index (as of [max date])". If data is more than 7 days old, add "(refresh pending)" to the header.

Show competitive index values for OCC, ADR, and RevPAR (these are indices vs the comp set, not the hotel's actual Occ/ADR/RevPAR):
- OCC Index (column: OCC_INDEX)
- ADR Index (column: ADR_INDEX)
- RevPAR Index (column: REVPAR_INDEX)

Three segments: Total, Transient, Group (show ALL three).

Three time windows -- always show all three:
- Current Week: AVG last 7 days from `STR_DAILY`
- Running 28: AVG last 28 days from `STR_DAILY`
- YTD: from `STR_MONTHLY` where `PERIOD_TYPE = '2026 YTD'`

Table: rows = Total / Transient / Group. Columns = CurrWk OCC Idx|ADR Idx|RevPAR Idx|Rank | R28 OCC Idx|ADR Idx|RevPAR Idx|Rank | YTD OCC Idx|ADR Idx|RevPAR Idx|Rank.

Column is `HOTEL` in both tables. Run `SELECT DISTINCT HOTEL FROM STR_DAILY` first to get exact names.

**STR refresh callout (applies in both full and delta mode):** Check whether today's STR data is newer than yesterday's:
```bash
python3 -c "
import json, os
f = os.environ.get('YESTERDAY_CACHE', '') + '/snowflake/str_daily.json'
if os.path.exists(f):
    d = json.load(open(f))
    print(max(r['DATE'] for r in d))
else:
    print('no-cache')
" 2>/dev/null
```
If today's MAX(DATE) from STR_DAILY is newer than yesterday's max date, add a "What Changed -- STR Refresh" callout block below each hotel's STR table. Show Total segment Current Week OCC Index, ADR Index, RevPAR Index: this week's value, prior week's value (from yesterday's cache), and delta. Example: "OCC Index: 102 (+4 vs prior week) | ADR Index: 98 (-1) | RevPAR Index: 101 (+3)". Label the block with the new data date.

**Daily mode:** Show the full STR table every day (no change from full mode). STR is always included.

### 3. Duetto Pace (Snowflake)

Table: `DUETTO_BUDGET_VS_PY`. EACH HOTEL SEPARATE. Current month + next month shown as TWO SEPARATE tables (2 months only).

Three segments: Total, Transient, Group. All three are REQUIRED -- never omit a segment.

Per segment per month: OTB Rooms | OTB ADR | OTB Revenue | STLY Revenue | vs STLY % | Forecast Revenue | Budget Revenue | Fcst vs Bud %

Aggregate daily rows: SUM rooms/revenue, ADR = SUM(rev) / SUM(rooms).

HOTEL_CODE mapping in `references/property_mapping.json`.

**Daily mode:** Total segment only, current month only. Show OTB rooms and OTB revenue. Load yesterday's cached duetto_pace.json and compute delta vs today: "+X rooms / +$XK OTB vs yesterday." Flag if OTB revenue delta > 5% in either direction.

### 4. ALICE Glitches (Snowflake)

Table: `GLITCH_REPORTS_RAW`. Dates are text "MMMM DD, YYYY", parse with `TRY_TO_DATE(DATE, 'MMMM DD, YYYY')`.

First, check the max available date:
```sql
SELECT MAX(TRY_TO_DATE(DATE, 'MMMM DD, YYYY')) FROM DUETTO_UPLOAD.RAW.GLITCH_REPORTS_RAW
```
Always use this max date as the anchor -- do NOT filter to today's date. Show MTD and YTD relative to the most recent data available, not today's date.

Two windows: MTD (1st of the month of max data date) + YTD (Jan 1). Each: count + total $ comps.

Show top issues SIDE BY SIDE in two columns:
- Left column: "Top Issues MTD" -- top 3-5 by frequency for current month, with count + $ comp
- Right column: "Top Issues YTD" -- top 3-5 by frequency for year to date, with count + $ comp
Display NEXT TO each other (two-column layout for the issues only, not the summary numbers above).

**Daily mode:** Filter to glitches where parsed_date >= yesterday's date. Show count and total comps for the day. If zero new glitches, show "ALICE: 0 new glitches today." Show MTD total in parentheses for context. Still flag any individual comp > $500.

Comp formula: `TRY_TO_NUMBER(REPLACE(REPLACE(COMPENSATION,'$',''),',',''))`

Always show data regardless of staleness. If max date is more than 7 days ago, note "(pipeline stale -- as of [date])" in the section header in amber text.

### 5. Revinate (Snowflake)

USE THIS TABLE: `CORE_REVINATE.RAW_API.RAW_REVIEWS` (13K+ rows, current through today).
DO NOT use PROD.FACT_REVIEWS (only 2K rows, stale at Feb 10).

Key columns:
- `HOTEL_NAME` -- property name
- `DATE_REVIEW` -- review date (text "YYYY-MM-DD")
- `REVIEW_SOURCE` -- e.g., "Google", "Booking.com", "Expedia", "Revinate Surveys"
- `NPS` -- NPS score for surveys (0-10 scale), NULL for external reviews
- `RAW_JSON` -- full JSON with `rating` (1-5 scale) and `subratings` object

To extract rating from JSON in Snowflake:
```sql
SELECT
  HOTEL_NAME,
  DATE_REVIEW,
  PARSE_JSON(RAW_JSON):rating::FLOAT AS rating,
  REVIEW_SOURCE
FROM CORE_REVINATE.RAW_API.RAW_REVIEWS
WHERE DATE_REVIEW >= '2026-04-01'
```

To extract sub-ratings:
```sql
SELECT
  HOTEL_NAME,
  AVG(PARSE_JSON(RAW_JSON):subratings:Cleanliness::FLOAT) AS cleanliness,
  AVG(PARSE_JSON(RAW_JSON):subratings:Service::FLOAT) AS service,
  AVG(PARSE_JSON(RAW_JSON):subratings:"Hotel condition"::FLOAT) AS hotel_condition
FROM CORE_REVINATE.RAW_API.RAW_REVIEWS
WHERE DATE_REVIEW >= '2026-01-01'
  AND PARSE_JSON(RAW_JSON):subratings IS NOT NULL
GROUP BY HOTEL_NAME
```

Note: sub-rating category names vary (Cleanliness, Service, Hotel condition, etc.). Run a sample first to discover available categories:
```sql
SELECT DISTINCT f.key FROM CORE_REVINATE.RAW_API.RAW_REVIEWS, LATERAL FLATTEN(input => PARSE_JSON(RAW_JSON):subratings) f LIMIT 20
```

THREE COLUMNS: MTD | 90-Day | YTD. Each: review count + avg rating (from RAW_JSON:rating).

**Platform Ratings Table (below the summary columns):**

Show a per-platform breakdown for MTD and YTD. All ratings are out of 5.0. The following platforms are available in Snowflake via `REVIEW_SOURCE`:

| Platform | REVIEW_SOURCE value |
|---|---|
| Google | Google |
| Booking.com | Booking.com |
| Expedia | Expedia |
| TripAdvisor | TripAdvisor |

Query per hotel:
```sql
SELECT REVIEW_SOURCE,
  COUNT(*) AS review_count,
  AVG(PARSE_JSON(RAW_JSON):rating::FLOAT) AS avg_rating
FROM CORE_REVINATE.RAW_API.RAW_REVIEWS
WHERE HOTEL_NAME = '[hotel]'
  AND REVIEW_SOURCE IN ('Google','Booking.com','Expedia','TripAdvisor')
  AND DATE_REVIEW >= '[mtd_start]'
GROUP BY REVIEW_SOURCE
```

Run once for MTD (1st of current month) and once for YTD (Jan 1). Show as a table:

| Platform | MTD Avg | MTD # | YTD Avg | YTD # | TripAdvisor Rank |
|---|---|---|---|---|---|
| Google | 4.6 | 32 | 4.5 | 187 | -- |
| Booking.com | 4.3 | 18 | 4.2 | 110 | -- |
| Expedia | 4.4 | 11 | 4.3 | 67 | -- |
| TripAdvisor | 4.5 | 9 | 4.4 | 52 | #14 of 312 |

**TripAdvisor Property Rank:** For each hotel, use `WebSearch` to look up the current TripAdvisor ranking in their city. Search query: `site:tripadvisor.com "[Full Hotel Name]" hotels [city] ranking`. Pull the "#X of Y hotels in [City]" rank from the result and display in the TripAdvisor row. If not found via search, show "N/A".

Show top issues SIDE BY SIDE in two columns:
- Left column: "Top Issues MTD" -- 3 lowest sub-rating categories from MTD reviews with avg score
- Right column: "Top Issues YTD" -- 3 lowest sub-rating categories from YTD reviews with avg score
Display NEXT TO each other (two-column layout for the issues only, not the summary numbers above).
Show BELOW the platform ratings table.

Flag avg rating < 4.0 in red. This data is CURRENT -- no staleness disclaimer needed.

**Daily mode:** Filter to reviews where DATE_REVIEW >= yesterday. Show count and average rating for those reviews. If zero new reviews, show "Revinate: 0 new reviews today." Show MTD count in parentheses for context.

### 6. Toast F&B Revenue (Toast POS API)

IMPORTANT: You MUST run this section. Do NOT skip it.

The TOAST_CLIENT_ID and TOAST_CLIENT_SECRET environment variables are pre-set in the container. Verify first:
```bash
echo "Toast ID: $TOAST_CLIENT_ID"
```
If the variable is empty, use these values directly:
- TOAST_CLIENT_ID=raww0JjfxRNU63yMsT07jGya6K4u75LA
- TOAST_CLIENT_SECRET=h3gwOaoJCp57TsFlDT1vV9zzltWKmBXQKEw9gsTKXYUZ3j_qV-JJcWQsbRDcs5tO

Run via Bash to get MTD F&B data (1st of current month to yesterday):
```bash
python3 /workspace/project/scripts/toast/scripts/toast_api.py \
  --endpoint sales-summary --start-date [YYYYMMDD_FIRST_OF_MONTH] --end-date [YYYYMMDD_YESTERDAY]
```

If TOAST_CLIENT_ID env var is empty, prefix the command:
```bash
TOAST_CLIENT_ID=raww0JjfxRNU63yMsT07jGya6K4u75LA TOAST_CLIENT_SECRET="h3gwOaoJCp57TsFlDT1vV9zzltWKmBXQKEw9gsTKXYUZ3j_qV-JJcWQsbRDcs5tO" \
  python3 /workspace/project/scripts/toast/scripts/toast_api.py \
  --endpoint sales-summary --start-date [YYYYMMDD] --end-date [YYYYMMDD]
```

The script outputs a CSV to /tmp/toast_sales_summary.csv and prints a formatted table to stderr.
ERA scope returns 403, script auto-falls back to Orders API. Takes 60-90 seconds for 51 outlets.

Show ALL outlets for each hotel (not just top 3). Per outlet show:
- Outlet name
- MTD Net Sales ($)
- MTD Covers (check count)
- Average Check ($) = Net Sales / Covers
- MTD Orders

Property total at bottom of each hotel's outlet table.

This gives Gabe full F&B visibility by outlet. Do NOT truncate to top 3 -- show every outlet that has revenue.

**Daily mode:** Same as full mode -- Toast data is inherently date-scoped (MTD 1st through yesterday). No change needed.


**CRITICAL -- ORGANIZATION RULE: The report is organized HOTEL BY HOTEL, not section by section. Complete all 6 sections for Hotel 1, then move to Hotel 2 and complete all 6 sections, then Hotel 3, etc. NEVER group all P&L sections together, then all STR sections, etc. Each hotel block must be contiguous -- all its data in one place before the next hotel begins.**

1. **Top 5 Portfolio Flags** -- FIRST, before any hotel detail. Most urgent cross-portfolio items.
2. **Per hotel** -- all 6 sections in order above, COMPLETE for that hotel before moving to the next hotel.
3. **3-5 COO Action Items** at bottom of each hotel section. Data-driven, priority-sorted. Thresholds:
   - STR: Total RevPAR Index R28 < 65 = critical, < 85 = alert, < 95 = watch
   - Duetto: Fcst vs Budget < -7% = alert, < -5% = watch
   - Lighthouse: vs comp < -20% = alert, OTB < 30% with high comp OTB = alert
   - ALICE: comp > $30/glitch = alert, volume > 600 MTD = alert
   - Revinate: avg < 3.8 = critical, < 4.1 = alert, < 4.3 = watch
   If fewer than 3 anomalies, pad with positive observations.
4. **COO Action Items -- Bottom Summary** -- LAST section of the email, after all hotel detail. This is a consolidated roll-up for quick scanning. Format:

   **TOP 5 PORTFOLIO FLAGS**
   (Repeat the same 5 flags from the top of the report here.)

   Then for EVERY hotel in portfolio order, list that hotel's COO Action Items:

   **[Full Hotel Name]**
   1. [Action item 1]
   2. [Action item 2]
   3. [Action item 3]
   (same items as generated in each hotel's embedded COO Actions section -- do NOT invent new ones)

   Use a dark bold header "COO Action Items" styled the same as other section headers. No extra narrative, no introductory sentence, just the flags and the hotel-by-hotel list.

5. **NO signature**, no sign-off, no closing line.

## Output

**HTML email** to Gabriel.Ratner@properhotel.com ONLY via `mcp__outlook__send-email`. Subject: "COO Briefing -- [Month Day, Year]". Self-addressed operational report, send directly.

**ABSOLUTE RULE: NO CC, NO BCC, ever, under any circumstances.** Do not pass `cc` or `bcc` parameters to `send-email`. Do not add any address from contacts, org chart, or anywhere else. The only recipient is Gabriel.Ratner@properhotel.com. This applies even if a contact looks like a relevant stakeholder (e.g. revman@properhotel.com). One recipient. No exceptions.

**Telegram** via `send_message`. Full mode: per hotel 3-4 lines (P&L variance, ALICE count, Revinate score, STR RGI). Delta mode: only hotels with notable changes (new ALICE glitches, new reviews < 4.0, OTB shift > 5%, STR refresh with meaningful delta); skip hotels with nothing to flag. Under 4000 chars.

**After both email and Telegram are sent**, write the completion flag so duplicate runs are no-ops:
```bash
TODAY=$(date +%Y-%m-%d)
touch /workspace/project/data/coo-prefetch/$TODAY/brief_sent.flag
echo "Brief flag written"
```

## Rules

- No em dashes anywhere. Use " -- " or colons.
- No exclamation marks.
- Numbers formatted with commas and $.
- If a data source returns no data, show "Data pending -- [source] not available" with last known date. Never skip a section silently.
- **STR rule:** Always include STR every day. Show "(as of [max date])" in the section header. Add "(refresh pending)" if data is more than 7 days old. Never omit this section.
- **ALICE exception:** ALICE pipeline refreshes weekly and may lag up to 14 days. If no ALICE data within 7 days, re-query up to 14 days back and display with "(as of [date])" in the section header. If pipeline is older than 14 days, show the most recent available data with a "(pipeline stale -- as of [date])" warning in amber. Never show a blank ALICE section -- always show the most recent data available regardless of age.
- Flag: RevPAR Index < 85, comps > $20K, reviews < 4.0, EBITDA adverse > 10%.

## SPELLING AND NAMING -- CRITICAL

ALWAYS use the FULL NAME from property_mapping.json. NEVER use abbreviations or codes as hotel headers. NEVER invent names. Specifically:
- "Shelborne South Beach" -- NOT "Shel", "Shelborne Miami", or "The Shelborne"
- "The Culver Hotel" -- NOT "TCH", "Tomboy Chelsea Hotel", or any other expansion
- "Montauk Yacht Club" -- NOT "MYC"
- "Ingleside Estate" -- NOT "ING", "Hotel Ingrid", or "Ingleside Inn"
- Use `full_name` from property_mapping.json for EVERY hotel header, no exceptions. The codes (SMP, DTLA, SHEL, TCH, ING, etc.) are internal references ONLY -- never display them to the user.
