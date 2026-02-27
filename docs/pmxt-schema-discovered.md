# pmxt.dev Parquet Schema - Discovered

## Success! DuckDB Works Perfectly ✅

**Tool chosen**: DuckDB (memory-efficient, SQL interface, built for Parquet)
**Result**: Successfully inspected 484MB file with 24.2M rows

## Schema

```sql
CREATE TABLE polymarket_orderbook (
  timestamp_received TIMESTAMP WITH TIME ZONE,     -- When pmxt received the update
  timestamp_created_at TIMESTAMP WITH TIME ZONE,   -- When update was created
  market_id VARCHAR,                                -- Market contract ID (hex)
  update_type VARCHAR,                              -- "price_change"
  data VARCHAR                                      -- JSON with actual price data
);
```

## Data JSON Structure

The `data` column contains JSON with these fields:

```json
{
  "update_type": "price_change",
  "market_id": "0x00000977017fa72fb6b1908ae694000d3b51f442c2552656b10bdbbfd16ff707",
  "token_id": "44554681108074793313893626424278471150091658237406724818592366780413111952248",
  "side": "YES",                   // or "NO"
  "best_bid": "0.008",             // Best bid price
  "best_ask": "0.01",              // Best ask price
  "timestamp": 1772204401.7254705,
  "change_price": "0.01",
  "change_size": "5.28",
  "change_side": "SELL"           // or "BUY"
}
```

## Statistics (1 Hour File)

- **Total updates**: 24,241,897
- **Unique markets**: 22,809
- **Unique tokens**: 45,618 (each market has YES and NO tokens)
- **Time range**: 1 hour (15:00-15:59 UTC on 2026-02-27)
- **File size**: 484 MB

## Key Insights

### Market Structure
- Each prediction market has 2 tokens: YES and NO
- Token IDs are long integers (not human-readable)
- Market IDs are hex strings (contract addresses)

### Price Data
- **Best bid/ask** available for each side
- **Mid-price** = (best_bid + best_ask) / 2
- Updates occur on every price change (very high frequency)

### What's Missing
- ❌ No market question/title in this data
- ❌ No resolution/outcome data
- ❌ No metadata about what the market is predicting

**Need to cross-reference** with Gamma API to get:
- Market questions
- Resolution status
- Actual outcomes (for backtesting)

## DuckDB Queries That Work

### Extract price data:
```sql
SELECT
  timestamp_received,
  market_id,
  json_extract_string(data, '$.token_id') as token_id,
  json_extract_string(data, '$.side') as side,
  CAST(json_extract_string(data, '$.best_bid') AS DOUBLE) as best_bid,
  CAST(json_extract_string(data, '$.best_ask') AS DOUBLE) as best_ask,
  (CAST(json_extract_string(data, '$.best_bid') AS DOUBLE) +
   CAST(json_extract_string(data, '$.best_ask') AS DOUBLE)) / 2.0 as mid_price
FROM 'sample.parquet'
LIMIT 1000
```

### Count unique markets:
```sql
SELECT COUNT(DISTINCT market_id) as unique_markets
FROM 'sample.parquet'
```

### Get most active tokens:
```sql
SELECT
  json_extract_string(data, '$.token_id') as token_id,
  COUNT(*) as update_count
FROM 'sample.parquet'
GROUP BY token_id
ORDER BY update_count DESC
LIMIT 10
```

## Integration Strategy

### Phase 1: Metadata Mapping (Required First)

Before importing price data, we MUST map market_ids to human-readable info:

```javascript
// Fetch from Gamma API
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const markets = await fetch(`${GAMMA_BASE}/markets`);

// Create mapping table:
CREATE TABLE market_metadata (
  market_id VARCHAR PRIMARY KEY,
  condition_id VARCHAR,
  question TEXT,
  slug VARCHAR,
  end_date TIMESTAMP,
  resolved BOOLEAN,
  resolved_outcome INTEGER,  // 0 or 1 or NULL
  token_id_yes VARCHAR,
  token_id_no VARCHAR
);
```

### Phase 2: Import Price History

For each resolved market:

```javascript
// 1. Get market metadata from Gamma API
const resolved = markets.filter(m => m.closed && m.resolved);

// 2. For each resolved market, extract price history from Parquet
const prices = await duckdb.query(`
  SELECT
    timestamp_received,
    json_extract_string(data, '$.token_id') as token_id,
    mid_price
  FROM 'polymarket_*.parquet'
  WHERE market_id = '${market.id}'
    AND timestamp_received < '${market.endDate}'
  ORDER BY timestamp_received ASC
`);

// 3. Store in market_data table
for (const price of prices) {
  db.prepare(`INSERT INTO market_data ...`).run(...);
}
```

### Phase 3: Backtest

For each resolved market:
1. Load price history from market_data
2. Select timestamp 24 hours before resolution
3. Run probability estimation at that point
4. Compare to actual outcome
5. Calculate P&L using Kelly sizing

## Container Limitations

**Problem**: Container has limited RAM - can't process 24M rows
**Solution**: Process on host machine OR stream in batches

### Batch Processing Approach

```javascript
// Read Parquet in chunks (DuckDB supports this)
const BATCH_SIZE = 100000;

for (let offset = 0; offset < total_rows; offset += BATCH_SIZE) {
  const batch = await duckdb.query(`
    SELECT * FROM 'sample.parquet'
    LIMIT ${BATCH_SIZE} OFFSET ${offset}
  `);

  // Process batch
  await processBatch(batch);
}
```

## Next Immediate Actions

1. **Get market metadata** - Run Gamma API script to map market_ids to questions
2. **Filter for resolved markets** - Only process markets with known outcomes
3. **Download historical Parquet files** - Get 1-2 weeks of data
4. **Build import pipeline** - Stream process into SQLite in batches
5. **Run backtests** - Test probability estimation on 50-100 resolved markets

## Files Created

- `/workspace/project/scripts/inspect-pmxt-duckdb.js` - Schema inspection ✅ Works
- `/workspace/project/scripts/parse-pmxt-json.js` - JSON extraction ✅ Works (hit RAM limit at 24M rows)

## Recommendation

**Run full pipeline on host machine** where you have more RAM, OR implement batch processing in container.

DuckDB is the right tool - it works perfectly for querying Parquet directly without loading into memory.
