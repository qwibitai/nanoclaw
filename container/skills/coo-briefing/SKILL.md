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
| Snowflake Tripleseat | `ROSEDALE_DATABASE.TRIPLESEAT.*` | Group/catering |
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
| Tripleseat | `$CACHE_DIR/snowflake/tripleseat.json` |
| Delphi/Salesforce | `$CACHE_DIR/snowflake/delphi.json` |
| Toast F&B | `$CACHE_DIR/toast/sales_summary.csv` |

Read cached files with:
```bash
python3 -c "import json; data=json.load(open('$CACHE_DIR/snowflake/str_daily.json')); print(f'{len(data)} rows')"
```

Snowflake JSON files contain arrays of row objects -- filter by hotel name/code as needed when building each hotel section. Property code-to-name mapping is in `references/property_mapping.json`.

**If CACHE MISS (manual/daytime run):** Proceed with live API calls as documented in each section below. Add note "Running without cache -- live data fetch" in the Telegram summary.

## HTML Styling

- Title: "COO Briefing" in large DARK font (#1a1a1a, font-weight 700, 28px)
- All section headers: dark font, bold, clearly readable (never light gray)
- Each hotel: FULL NAME as header (e.g., "Santa Monica Proper Hotel" not "SMP")
- Every data section: full-width card, NO two-column layout
- Layout order per hotel: P&L > STR > Duetto Pace > ALICE > Revinate > Tripleseat > Toast F&B > COO Actions
- CSS classes: ALICE = `section-card alice-card` (amber), Revinate = `section-card revinate-card` (green)

## Sections (per hotel)

### 1. P&L Snapshot (ProfitSword)

Current month + next month side by side (2 months only). Compare: Forecast vs Budget vs Prior Year.

Run via Bash for each property. Pull BOTH MONTHS IN ONE CALL (more efficient, fewer timeouts):
```bash
# Forecast (both months at once)
python3 /workspace/project/scripts/profitsword/scripts/profitsword_api.py \
  --endpoint monthly_extended --site-tag [TAG] --dataset-id 1 \
  --year 2026 --begmonth [CURRENT_MONTH] --endmonth [CURRENT_MONTH+1] \
  --include-totals Y --output /tmp/ps_fcst_[TAG].csv

# Budget (both months at once)
python3 /workspace/project/scripts/profitsword/scripts/profitsword_api.py \
  --endpoint monthly_extended --site-tag [TAG] --dataset-id 2 \
  --year 2026 --begmonth [CURRENT_MONTH] --endmonth [CURRENT_MONTH+1] \
  --include-totals Y --output /tmp/ps_bud_[TAG].csv

# Actuals (current month only -- future months have no actuals)
python3 /workspace/project/scripts/profitsword/scripts/profitsword_api.py \
  --endpoint monthly_extended --site-tag [TAG] --dataset-id -3 \
  --year 2026 --begmonth [CURRENT_MONTH] --endmonth [CURRENT_MONTH] \
  --include-totals Y --output /tmp/ps_act_[TAG].csv
```

Also pull Last Year (LY) actuals for the same months from prior year:
```bash
# LY Actuals (same months, year-1)
python3 /workspace/project/scripts/profitsword/scripts/profitsword_api.py \
  --endpoint monthly_extended --site-tag [TAG] --dataset-id -3 \
  --year 2025 --begmonth [CURRENT_MONTH] --endmonth [CURRENT_MONTH+1] \
  --include-totals Y --output /tmp/ps_ly_[TAG].csv
```

That is 4 calls per property (48 total): Forecast + Budget + Actuals + LY.

DataSet IDs: -3=Actuals, 1=Forecast, 2=Budget. For LY, use -3 (Actuals) with year=2025.

IMPORTANT: Run ALL 12 properties. Do NOT skip any. If a call fails or returns 0 rows, note "ProfitSword: error for [property]" and continue to the next. Do NOT stop the entire report because one property fails.

CSV columns: SiteTag, siteName, ItemTag, Description, AccountNumber, StatAccount, Year, Month, Stat, Amt

Filter to these ItemTags only:

| P&L Line | ItemTag |
|---|---|
| Room Revenue | TOTRMRV |
| Room Expense | TOTRMEX |
| F&B Revenue | RF0007 |
| F&B Expense | RF0008 |
| Total Revenue | TOTOPRV |
| GOP | TOTGOP |
| EBITDA after Reserves | EBITDA |

**ALWAYS show TWO tables per hotel -- current month AND next month.** Label each table clearly with the month name (e.g., "April 2026" and "May 2026"). Never collapse to one month or omit next month.

Each table rows: Room Revenue | Room Expense | F&B Revenue | F&B Expense | Total Revenue | GOP | EBITDA after Reserves

Each table columns: Primary Forecast | Budget | vs Bud $ | vs Bud % | LY (Last Year) | vs LY %

The first column is ALWAYS Primary Forecast (dataset 1) for both current month and next month. Do NOT use Actuals (dataset -3) as a table column under any circumstances -- Actuals data is fetched for reference only and must not appear as a column in the output.

Label the prior year column "LY" not "STLY" or "PY".

Color: green = favorable variance, red = adverse > 5%.

If 0 rows returned for a month, show "ProfitSword: no data for [month]" -- but still show the other month's table.

### 2. STR Competitive Index (Snowflake) -- EVERY DAY

Always include this section. STR data refreshes Tuesday nights so mid-week data is the same until next refresh -- show it with the data date so Gabe knows how fresh it is.

Check the max date and show it in the section header:
```sql
SELECT MAX(DATE) FROM DUETTO_UPLOAD.RAW.STR_DAILY
```
Label the section header: "STR Competitive Index (as of [max date])". If data is more than 7 days old, add "(refresh pending)" to the header.

**Show INDEX values only -- NOT actual Occ/ADR/RevPAR:**
- MPI = OCC_INDEX
- ARI = ADR_INDEX
- RGI = REVPAR_INDEX

Three segments: Total, Transient, Group (show ALL three).

Three time windows:
- Current Week: AVG last 7 days from `STR_DAILY`
- Running 28: AVG last 28 days from `STR_DAILY`
- YTD: from `STR_MONTHLY` where `PERIOD_TYPE = '2026 YTD'`

Table: rows = Total / Transient / Group. Columns = CurrWk MPI|ARI|RGI|Rank | R28 MPI|ARI|RGI|Rank | YTD MPI|ARI|RGI|Rank.

Column is `HOTEL` in both tables. Run `SELECT DISTINCT HOTEL FROM STR_DAILY` first to get exact names.

### 3. Duetto Pace (Snowflake)

Table: `DUETTO_BUDGET_VS_PY`. EACH HOTEL SEPARATE. Current month + next month shown as TWO SEPARATE tables (2 months only).

Three segments: Total, Transient, Group.

Per segment per month: OTB Rooms | OTB ADR | OTB Revenue | STLY Revenue | vs STLY % | Forecast Revenue | Budget Revenue | Fcst vs Bud %

Aggregate daily rows: SUM rooms/revenue, ADR = SUM(rev) / SUM(rooms).

HOTEL_CODE mapping in `references/property_mapping.json`.

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

Show top issues SIDE BY SIDE in two columns:
- Left column: "Top Issues MTD" -- 3 lowest sub-rating categories from MTD reviews with avg score
- Right column: "Top Issues YTD" -- 3 lowest sub-rating categories from YTD reviews with avg score
Display NEXT TO each other (two-column layout for the issues only, not the summary numbers above).
Show BELOW the summary numbers.

Flag avg rating < 4.0 red. This data is CURRENT -- no staleness disclaimer needed.

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

### 7. Group/Catering Pace -- Tripleseat + Delphi (Snowflake)

TWO sources cover different hotels. Use the PRIMARY source for each hotel:

**Delphi/Salesforce** (PRIMARY for these 5): ATX, SMP, SFP, DTLA, SHEL
Table: `ROSEDALE_DATABASE.SALESFORCE.SF_BOOKINGS`
Hotel column: `NIHRM__LOCATION__R_NAME`
Status column: `NIHRM__BOOKINGSTATUS__C` (values: Definite, Tentative, Prospect)
Date column: `NIHRM__ARRIVALDATE__C` (text "YYYY-MM-DD")
Revenue: `NIHRM__CURRENTBLENDEDREVENUETOTAL__C`
Room nights: `NIHRM__BLOCKEDROOMNIGHTSTOTAL__C`

**Tripleseat** (PRIMARY for these 6): HJL, TCH, MYC, AVPS, AVBH, ING
Table: `ROSEDALE_DATABASE.TRIPLESEAT.TRIPLESEAT_BOOKINGS`
Hotel column: `LOCATION_NAME`
Status column: `STATUS` (values: DEFINITE, TENTATIVE, PROSPECT -- uppercase)
Date column: `START_DATE` (timestamp)
Revenue: `TOTAL_GRAND_TOTAL`
Room nights: `BLOCKED_ROOM_NIGHTS`

**HJM (Hotel June Malibu):** not in either system. Show "No group/catering data."

**Per hotel, show Pace vs STLY for next 3 months, broken out by status:**

For CURRENT YEAR: query where arrival/start date is in each of the next 3 calendar months.
For STLY: query same months but year-1 (2025).

Table per hotel (3 months side by side):
| Status | [Month 1] Bkgs | Rev | RN | STLY Rev | vs LY % | [Month 2] same | [Month 3] same |

Three rows per month: Definite, Tentative, Prospect.

Delphi query pattern:
```sql
SELECT NIHRM__LOCATION__R_NAME, NIHRM__BOOKINGSTATUS__C,
  LEFT(NIHRM__ARRIVALDATE__C, 7) AS month,
  COUNT(*) AS bookings,
  SUM(NIHRM__CURRENTBLENDEDREVENUETOTAL__C) AS revenue,
  SUM(NIHRM__BLOCKEDROOMNIGHTSTOTAL__C) AS room_nights
FROM ROSEDALE_DATABASE.SALESFORCE.SF_BOOKINGS
WHERE NIHRM__ARRIVALDATE__C >= '[MONTH_START]'
  AND NIHRM__ARRIVALDATE__C < '[MONTH_END]'
  AND NIHRM__BOOKINGSTATUS__C IN ('Definite','Tentative','Prospect')
GROUP BY 1,2,3
```
Run twice: once for 2026, once for 2025 (STLY).

Tripleseat query pattern:
```sql
SELECT LOCATION_NAME, STATUS,
  LEFT(START_DATE::VARCHAR, 7) AS month,
  COUNT(*) AS bookings,
  SUM(TOTAL_GRAND_TOTAL) AS revenue,
  SUM(BLOCKED_ROOM_NIGHTS) AS room_nights
FROM ROSEDALE_DATABASE.TRIPLESEAT.TRIPLESEAT_BOOKINGS
WHERE START_DATE >= '[MONTH_START]'
  AND START_DATE < '[MONTH_END]'
  AND STATUS IN ('DEFINITE','TENTATIVE','PROSPECT')
GROUP BY 1,2,3
```
Run twice: once for 2026, once for 2025 (STLY).

Color: green if current year revenue > STLY, red if < STLY by more than 10%.

## Report Format

**CRITICAL -- ORGANIZATION RULE: The report is organized HOTEL BY HOTEL, not section by section. Complete all 8 data sections for Hotel 1, then move to Hotel 2 and complete all 8 sections, then Hotel 3, etc. NEVER group all P&L sections together, then all STR sections, etc. Each hotel block must be contiguous -- all its data in one place before the next hotel begins.**

1. **Top 5 Portfolio Flags** -- FIRST, before any hotel detail. Most urgent cross-portfolio items.
2. **Per hotel** -- all 8 sections in order above, COMPLETE for that hotel before moving to the next hotel.
3. **3-5 COO Action Items** at bottom of each hotel section. Data-driven, priority-sorted. Thresholds:
   - STR: Total RGI28 < 65 = critical, < 85 = alert, < 95 = watch
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

**HTML email** to Gabriel.Ratner@properhotel.com ONLY via `mcp__outlook__send-email`. Subject: "COO Briefing -- [Month Day, Year]". Self-addressed operational report, send directly. NO CC, NO BCC -- Gabe is the only recipient.

**Telegram** via `send_message`. Per hotel 3-4 lines (P&L variance, ALICE count, Revinate score, STR RGI if Wednesday). FOCUS line if actionable. Under 4000 chars.

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
- Flag: RGI < 85, comps > $20K, reviews < 4.0, EBITDA adverse > 10%.

## SPELLING AND NAMING -- CRITICAL

ALWAYS use the FULL NAME from property_mapping.json. NEVER use abbreviations or codes as hotel headers. NEVER invent names. Specifically:
- "Shelborne South Beach" -- NOT "Shel", "Shelborne Miami", or "The Shelborne"
- "The Culver Hotel" -- NOT "TCH", "Tomboy Chelsea Hotel", or any other expansion
- "Montauk Yacht Club" -- NOT "MYC"
- "Ingleside Estate" -- NOT "ING", "Hotel Ingrid", or "Ingleside Inn"
- Use `full_name` from property_mapping.json for EVERY hotel header, no exceptions. The codes (SMP, DTLA, SHEL, TCH, ING, etc.) are internal references ONLY -- never display them to the user.
