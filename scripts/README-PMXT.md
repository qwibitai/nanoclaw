# pmxt.dev Integration Scripts

Tools for downloading and analyzing Polymarket historical orderbook data from pmxt.dev.

---

## Quick Start

### 1. Download Historical Data

Download 7 days of recent data:

```bash
node scripts/download-pmxt-batch.js --latest 7 --output ./data/pmxt
```

Or specific date range:

```bash
node scripts/download-pmxt-batch.js \
  --start 2026-02-01 \
  --end 2026-02-27 \
  --output ./data/pmxt
```

**Options**:
- `--latest N` - Download last N days
- `--date YYYY-MM-DD` - Download single day
- `--start / --end` - Download date range
- `--output DIR` - Output directory (default: ./data/pmxt)
- `--parallel N` - Concurrent downloads (default: 3)
- `--resume` - Skip already downloaded files

**Storage requirements**:
- 1 day = ~11.5 GB (24 files × 480 MB)
- 1 week = ~81 GB
- 1 month = ~348 GB

### 2. Reconstruct Orderbook

Get orderbook state at specific timestamp:

```bash
node scripts/reconstruct-orderbook.js \
  --token-id "44554681108074793313893626424278471150091658237406724818592366780413111952248" \
  --timestamp "2026-02-27T15:30:00Z" \
  --data-dir ./data/pmxt \
  --output orderbook.json
```

**Output**:
```json
{
  "token_id": "44554681...",
  "timestamp": "2026-02-27T15:30:00Z",
  "best_bid": 0.008,
  "best_ask": 0.01,
  "mid_price": 0.009,
  "spread": 0.002,
  "spread_bps": 222.22,
  "bids": [
    { "price": 0.008, "size": 1234 },
    { "price": 0.007, "size": 5678 }
  ],
  "asks": [
    { "price": 0.01, "size": 2345 },
    { "price": 0.011, "size": 3456 }
  ]
}
```

---

## Scripts

### download-pmxt-batch.js

Batch downloader with resume support and parallel downloads.

**Features**:
- Parallel downloads (configurable concurrency)
- Resume interrupted downloads
- Automatic retry with exponential backoff
- Progress tracking
- Manifest file with download statistics

**Examples**:

```bash
# Download last 7 days (3 parallel)
node scripts/download-pmxt-batch.js --latest 7 --output ./data/pmxt

# Download specific month (5 parallel)
node scripts/download-pmxt-batch.js \
  --start 2026-02-01 \
  --end 2026-02-28 \
  --parallel 5 \
  --output ./data/pmxt

# Resume failed download
node scripts/download-pmxt-batch.js \
  --start 2026-02-01 \
  --end 2026-02-28 \
  --resume \
  --output ./data/pmxt
```

### reconstruct-orderbook.js

Reconstruct full orderbook state from price updates using DuckDB.

**How it works**:
1. Queries all pmxt Parquet files up to target timestamp
2. Filters updates for specific token
3. Replays orderbook changes sequentially
4. Returns snapshot with bid/ask levels

**Use cases**:
- Market-making strategy backtesting
- Liquidity analysis
- Spread dynamics research
- HFT signal detection

**Example**:

```bash
# Get orderbook for YES token at specific time
node scripts/reconstruct-orderbook.js \
  --token-id "44554681108074793313893626424278471150091658237406724818592366780413111952248" \
  --timestamp "2026-02-27T15:30:00Z" \
  --output book.json
```

---

## Data Format

### pmxt.dev Parquet Schema

```
timestamp_received: TIMESTAMP WITH TIME ZONE
timestamp_created_at: TIMESTAMP WITH TIME ZONE
market_id: VARCHAR
update_type: VARCHAR
data: VARCHAR (JSON)
```

### JSON Data Structure

```json
{
  "update_type": "price_change",
  "market_id": "0x00000977...",
  "token_id": "44554681...",
  "side": "YES",
  "best_bid": "0.008",
  "best_ask": "0.01",
  "timestamp": 1772204401.725,
  "change_price": "0.01",
  "change_size": "5.28",
  "change_side": "SELL"
}
```

**Key fields**:
- `best_bid` / `best_ask` - Top of book
- `change_price` / `change_size` - Orderbook level update
- `change_side` - BUY or SELL
- Size of 0 = level removed from book

---

## Next Steps

### 1. Liquidity Analysis

Analyze spread and depth over time:

```bash
node scripts/analyze-liquidity.js \
  --token-id "..." \
  --start "2026-02-20T00:00:00Z" \
  --end "2026-02-27T00:00:00Z" \
  --interval "1m"
```

### 2. Market-Making Backtest

Test spread capture strategies:

```bash
node scripts/backtest-market-making.js \
  --strategy avellaneda-stoikov \
  --capital 10000 \
  --risk-aversion 0.1
```

### 3. HFT Signal Detection

Detect orderbook imbalance signals:

```bash
node scripts/detect-hft-signals.js \
  --token-id "..." \
  --sensitivity 0.3
```

---

## Performance Tips

**For large datasets**:

1. **Use DuckDB filtering** before loading into memory:
```javascript
// Only load specific markets
WHERE market_id IN ('0x123...', '0x456...')

// Only load specific timeframe
WHERE timestamp_received >= '2026-02-20'
  AND timestamp_received <= '2026-02-27'
```

2. **Batch processing**:
```javascript
// Process in chunks of 100K rows
for (let offset = 0; offset < total; offset += 100000) {
  const batch = await query(`SELECT * LIMIT 100000 OFFSET ${offset}`);
  processBatch(batch);
}
```

3. **Run on host machine** (not container) for better RAM access

4. **Use SSD storage** for faster Parquet queries

---

## Troubleshooting

### "Out of memory" error

**Solution**: Process data in batches or run on machine with more RAM

```javascript
// Instead of loading all rows:
const allRows = await query(`SELECT * FROM 'huge.parquet'`);

// Load in batches:
for (let offset = 0; offset < total; offset += 100000) {
  const batch = await query(`SELECT * LIMIT 100000 OFFSET ${offset}`);
}
```

### "File not found" during download

**Cause**: pmxt.dev doesn't have data for that hour yet

**Solution**: Use `--resume` to skip missing files and continue

### Slow downloads

**Cause**: Network bandwidth or pmxt.dev rate limiting

**Solution**: Reduce `--parallel` from 3 to 1 or 2

---

## References

- pmxt.dev: https://archive.pmxt.dev/Polymarket
- DuckDB SQL: https://duckdb.org/docs/
- Parquet format: https://parquet.apache.org/
