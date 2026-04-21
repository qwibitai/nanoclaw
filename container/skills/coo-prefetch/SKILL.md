---
name: coo-prefetch
description: "Pre-fetch all COO Briefing data to disk. Runs at 3:00am PT daily, 45 minutes before the COO Briefing. Parallelizes ProfitSword across all 12 hotels simultaneously, saves Snowflake (ALICE, Revinate, Duetto Pace, Tripleseat, Delphi, STR on Wednesdays) and Toast data to /workspace/project/data/coo-prefetch/{today}/. The COO Briefing reads from this cache instead of making live API calls, cutting its runtime from ~30 min to ~5 min. Trigger: 'run coo prefetch', 'prefetch coo data', '/coo-prefetch'."
---

# COO Data Pre-Fetch

Fetch all COO Briefing data and save to disk so the 3:45am briefing runs from cache. This cuts briefing runtime from ~30 min to ~5 min by parallelizing ProfitSword and pre-loading Snowflake queries.

Property reference: `references/property_mapping.json`

## Setup

```bash
TODAY=$(date +%Y-%m-%d)
PREFETCH_DIR=/workspace/project/data/coo-prefetch/$TODAY
mkdir -p $PREFETCH_DIR/profitsword $PREFETCH_DIR/snowflake $PREFETCH_DIR/toast
echo "Output dir: $PREFETCH_DIR"
```

## Step 1: ProfitSword -- All 12 Hotels in Parallel

Run all 12 hotels as background processes simultaneously. Each hotel runs its 4 dataset calls sequentially within its own background job. This reduces ProfitSword time from ~8 min (sequential) to ~1 min (parallel).

Property site tags: SMP=112, DTLA=102, HJL=104, HJM=106, ATX=107, SFP=108, SHEL=114, MYC=115, TCH=111, ING=109, AVBH=105, AVPS=110

```bash
TODAY=$(date +%Y-%m-%d)
PREFETCH_DIR=/workspace/project/data/coo-prefetch/$TODAY
SCRIPT=/workspace/project/scripts/profitsword/scripts/profitsword_api.py
YEAR=$(date +%Y)
CM=$(date +%-m)
PY=$((YEAR - 1))
if [ $CM -eq 12 ]; then NM=1; NYEAR=$((YEAR+1)); else NM=$((CM+1)); NYEAR=$YEAR; fi

run_hotel() {
  CODE=$1; TAG=$2
  python3 $SCRIPT --endpoint monthly_extended --site-tag $TAG --dataset-id 1  --year $YEAR  --begmonth $CM --endmonth $NM --include-totals Y --output $PREFETCH_DIR/profitsword/${CODE}_fcst.csv 2>&1 | tail -1
  python3 $SCRIPT --endpoint monthly_extended --site-tag $TAG --dataset-id 2  --year $YEAR  --begmonth $CM --endmonth $NM --include-totals Y --output $PREFETCH_DIR/profitsword/${CODE}_bud.csv  2>&1 | tail -1
  python3 $SCRIPT --endpoint monthly_extended --site-tag $TAG --dataset-id -3 --year $YEAR  --begmonth $CM --endmonth $CM --include-totals Y --output $PREFETCH_DIR/profitsword/${CODE}_act.csv  2>&1 | tail -1
  python3 $SCRIPT --endpoint monthly_extended --site-tag $TAG --dataset-id -3 --year $PY    --begmonth $CM --endmonth $NM --include-totals Y --output $PREFETCH_DIR/profitsword/${CODE}_ly.csv   2>&1 | tail -1
  echo "PS done: $CODE"
}

run_hotel SMP  112 &
run_hotel DTLA 102 &
run_hotel HJL  104 &
run_hotel HJM  106 &
run_hotel ATX  107 &
run_hotel SFP  108 &
run_hotel SHEL 114 &
run_hotel MYC  115 &
run_hotel TCH  111 &
run_hotel ING  109 &
run_hotel AVBH 105 &
run_hotel AVPS 110 &
wait
echo "ProfitSword parallel pass complete: $(ls $PREFETCH_DIR/profitsword/ | wc -l) files"

# Retry pass -- re-run any missing files sequentially
declare -A TAGS=(["SMP"]=112 ["DTLA"]=102 ["HJL"]=104 ["HJM"]=106 ["ATX"]=107 ["SFP"]=108 ["SHEL"]=114 ["MYC"]=115 ["TCH"]=111 ["ING"]=109 ["AVBH"]=105 ["AVPS"]=110)
for CODE in SMP DTLA HJL HJM ATX SFP SHEL MYC TCH ING AVBH AVPS; do
  TAG=${TAGS[$CODE]}
  [ ! -f $PREFETCH_DIR/profitsword/${CODE}_fcst.csv ] && echo "RETRY: $CODE fcst" && python3 $SCRIPT --endpoint monthly_extended --site-tag $TAG --dataset-id 1  --year $YEAR --begmonth $CM --endmonth $NM --include-totals Y --output $PREFETCH_DIR/profitsword/${CODE}_fcst.csv 2>&1 | tail -1
  [ ! -f $PREFETCH_DIR/profitsword/${CODE}_bud.csv  ] && echo "RETRY: $CODE bud"  && python3 $SCRIPT --endpoint monthly_extended --site-tag $TAG --dataset-id 2  --year $YEAR --begmonth $CM --endmonth $NM --include-totals Y --output $PREFETCH_DIR/profitsword/${CODE}_bud.csv  2>&1 | tail -1
  [ ! -f $PREFETCH_DIR/profitsword/${CODE}_act.csv  ] && echo "RETRY: $CODE act"  && python3 $SCRIPT --endpoint monthly_extended --site-tag $TAG --dataset-id -3 --year $YEAR --begmonth $CM --endmonth $CM --include-totals Y --output $PREFETCH_DIR/profitsword/${CODE}_act.csv  2>&1 | tail -1
  [ ! -f $PREFETCH_DIR/profitsword/${CODE}_ly.csv   ] && echo "RETRY: $CODE ly"   && python3 $SCRIPT --endpoint monthly_extended --site-tag $TAG --dataset-id -3 --year $PY  --begmonth $CM --endmonth $NM --include-totals Y --output $PREFETCH_DIR/profitsword/${CODE}_ly.csv   2>&1 | tail -1
done
echo "ProfitSword: all 12 hotels complete ($(ls $PREFETCH_DIR/profitsword/ | wc -l) files)"
```

LY calls for next month may return 0 rows for some hotels -- expected, not an error.

## Step 2: Toast POS

```bash
TODAY=$(date +%Y-%m-%d)
PREFETCH_DIR=/workspace/project/data/coo-prefetch/$TODAY
START=$(date -d "$(date +%Y-%m-01)" +%Y%m%d)
YESTERDAY=$(date -d "yesterday" +%Y%m%d)

python3 /workspace/project/scripts/toast/scripts/toast_api.py \
  --endpoint sales-summary --start-date $START --end-date $YESTERDAY \
  --output $PREFETCH_DIR/toast/sales_summary.csv

echo "Toast: complete"
```

If TOAST_CLIENT_ID env var is empty, prefix with:
`TOAST_CLIENT_ID=raww0JjfxRNU63yMsT07jGya6K4u75LA TOAST_CLIENT_SECRET="h3gwOaoJCp57TsFlDT1vV9zzltWKmBXQKEw9gsTKXYUZ3j_qV-JJcWQsbRDcs5tO"`

## Step 3: Snowflake Queries

Run each query below via mcp__snowflake__query. After each query returns, immediately write the results to the specified JSON file using Python. Format: JSON array of row objects.

Save pattern after each query:
```bash
python3 -c "
import json
data = ROWS_FROM_QUERY_AS_LIST_OF_DICTS
with open('OUTPUT_PATH', 'w') as f:
    json.dump(data, f)
print(f'Saved {len(data)} rows to OUTPUT_PATH')
"
```

### 3a. STR Daily -- every day
Output: `$PREFETCH_DIR/snowflake/str_daily.json`
```sql
SELECT HOTEL, DATE, SEGMENT, OCC_INDEX, ADR_INDEX, REVPAR_INDEX, RANK
FROM DUETTO_UPLOAD.RAW.STR_DAILY
WHERE DATE >= DATEADD(day, -14, CURRENT_DATE)
ORDER BY HOTEL, DATE, SEGMENT
```

### 3b. STR Monthly -- every day
Output: `$PREFETCH_DIR/snowflake/str_monthly.json`
```sql
SELECT HOTEL, PERIOD_TYPE, SEGMENT, OCC_INDEX, ADR_INDEX, REVPAR_INDEX
FROM DUETTO_UPLOAD.RAW.STR_MONTHLY
WHERE PERIOD_TYPE LIKE '%YTD%'
ORDER BY HOTEL, PERIOD_TYPE, SEGMENT
```

### 3c. ALICE Glitches -- YTD all hotels
Output: `$PREFETCH_DIR/snowflake/alice.json`
```sql
SELECT PROPERTY, DATE, TYPE, GLITCH_ISSUE, COMPENSATION,
  TRY_TO_DATE(DATE, 'MMMM DD, YYYY') AS parsed_date
FROM DUETTO_UPLOAD.RAW.GLITCH_REPORTS_RAW
WHERE TRY_TO_DATE(DATE, 'MMMM DD, YYYY') >= '2026-01-01'
ORDER BY parsed_date DESC
```

### 3d. Revinate Reviews -- YTD all hotels
Output: `$PREFETCH_DIR/snowflake/revinate.json`
```sql
SELECT HOTEL_NAME, DATE_REVIEW, REVIEW_SOURCE, NPS,
  PARSE_JSON(RAW_JSON):rating::FLOAT AS rating,
  PARSE_JSON(RAW_JSON):subratings AS subratings
FROM CORE_REVINATE.RAW_API.RAW_REVIEWS
WHERE DATE_REVIEW >= '2026-01-01'
ORDER BY HOTEL_NAME, DATE_REVIEW
```

### 3e. Duetto Pace -- current + next month, all hotels
Output: `$PREFETCH_DIR/snowflake/duetto_pace.json`
```sql
SELECT HOTEL_CODE, STAY_DATE, SEGMENT,
  OTB_ROOMS, OTB_ADR, OTB_REVENUE,
  STLY_REVENUE, FORECAST_REVENUE, BUDGET_REVENUE
FROM DUETTO_UPLOAD.RAW.DUETTO_BUDGET_VS_PY
WHERE STAY_DATE >= DATE_TRUNC('month', CURRENT_DATE)
  AND STAY_DATE < ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE), 2)
ORDER BY HOTEL_CODE, STAY_DATE, SEGMENT
```

### 3f. Tripleseat -- next 3 months + STLY (6 hotels: HJL, TCH, MYC, AVPS, AVBH, ING)
Output: `$PREFETCH_DIR/snowflake/tripleseat.json`
```sql
SELECT LOCATION_NAME, STATUS,
  LEFT(START_DATE::VARCHAR, 7) AS month,
  YEAR(START_DATE) AS year,
  COUNT(*) AS bookings,
  SUM(TOTAL_GRAND_TOTAL) AS revenue,
  SUM(BLOCKED_ROOM_NIGHTS) AS room_nights
FROM ROSEDALE_DATABASE.TRIPLESEAT.TRIPLESEAT_BOOKINGS
WHERE (
  (START_DATE >= DATE_TRUNC('month', CURRENT_DATE)
   AND START_DATE < ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE), 3))
  OR
  (START_DATE >= ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE), -12)
   AND START_DATE < ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE), -9))
)
AND STATUS IN ('DEFINITE','TENTATIVE','PROSPECT')
GROUP BY 1,2,3,4
ORDER BY LOCATION_NAME, year, month, STATUS
```

### 3g. Delphi/Salesforce -- next 3 months + STLY (5 hotels: ATX, SMP, SFP, DTLA, SHEL)
Output: `$PREFETCH_DIR/snowflake/delphi.json`
```sql
SELECT NIHRM__LOCATION__R_NAME AS location,
  NIHRM__BOOKINGSTATUS__C AS status,
  LEFT(NIHRM__ARRIVALDATE__C, 7) AS month,
  LEFT(NIHRM__ARRIVALDATE__C, 4) AS year,
  COUNT(*) AS bookings,
  SUM(NIHRM__CURRENTBLENDEDREVENUETOTAL__C) AS revenue,
  SUM(NIHRM__BLOCKEDROOMNIGHTSTOTAL__C) AS room_nights
FROM ROSEDALE_DATABASE.SALESFORCE.SF_BOOKINGS
WHERE (
  (NIHRM__ARRIVALDATE__C >= TO_VARCHAR(DATE_TRUNC('month', CURRENT_DATE), 'YYYY-MM-DD')
   AND NIHRM__ARRIVALDATE__C < TO_VARCHAR(ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE), 3), 'YYYY-MM-DD'))
  OR
  (NIHRM__ARRIVALDATE__C >= TO_VARCHAR(ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE), -12), 'YYYY-MM-DD')
   AND NIHRM__ARRIVALDATE__C < TO_VARCHAR(ADD_MONTHS(DATE_TRUNC('month', CURRENT_DATE), -9), 'YYYY-MM-DD'))
)
AND NIHRM__BOOKINGSTATUS__C IN ('Definite','Tentative','Prospect')
GROUP BY 1,2,3,4
ORDER BY location, year, month, status
```

## Step 4: Write Manifest

Write this LAST, only after all steps complete. Its presence is the signal that tells the COO briefing the cache is valid.

```bash
TODAY=$(date +%Y-%m-%d)
PREFETCH_DIR=/workspace/project/data/coo-prefetch/$TODAY
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 -c "
import json, os, glob
files = [f.replace('/workspace/project/data/coo-prefetch/$TODAY/', '') for f in glob.glob('$PREFETCH_DIR/**/*', recursive=True) if os.path.isfile(f)]
manifest = {'date': '$TODAY', 'generated_at': '$NOW', 'files': sorted(files), 'complete': True}
with open('$PREFETCH_DIR/manifest.json', 'w') as f:
    json.dump(manifest, f, indent=2)
print(f'Manifest written: {len(files)} files cached')
"
```

## Step 5: Trigger COO Brief

After manifest is written, immediately queue the COO brief by dropping a task file into the IPC directory. This fires the brief container without any fixed time gap.

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > /workspace/ipc/tasks/trigger-coo-brief.json << EOF
{
  "type": "schedule_task",
  "prompt": "Run the /coo-briefing skill. Read the full spec from /workspace/project/container/skills/coo-briefing/SKILL.md and the property mapping from /workspace/project/container/skills/coo-briefing/references/property_mapping.json. Follow every instruction in that file exactly. Generate both the HTML email and Telegram summary as specified.",
  "schedule_type": "once",
  "schedule_value": "$NOW",
  "targetJid": "tg:6451555289",
  "context_mode": "isolated"
}
EOF
echo "COO brief queued"
```

## Output (Telegram only -- no email)

Send a single Telegram message summarizing:
- Total elapsed time
- ProfitSword: X/12 hotels cached (list any failures)
- Toast: OK or error
- Snowflake: X/7 queries cached (list any failures)
- Manifest written + brief queued

Example: "COO pre-fetch complete (4m 12s) -- PS: 12/12, Toast: OK, Snowflake: 7/7. Manifest written, brief queued."
