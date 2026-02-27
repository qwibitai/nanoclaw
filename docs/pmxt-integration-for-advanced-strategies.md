# pmxt.dev Integration for Advanced Trading Strategies

## Your Goals

1. ✅ Market-making strategies (orderbook depth analysis)
2. ✅ High-frequency trading (sub-second execution)
3. ✅ Liquidity analysis (spread changes, book dynamics)
4. ✅ Historical data older than CLOB keeps (30-90 days)
5. ✅ Backtest 100s of markets without rate limits

**Conclusion**: pmxt.dev is the right choice. CLOB API is insufficient for these requirements.

---

## What We've Accomplished

✅ **DuckDB installed** - Memory-efficient Parquet querying
✅ **Schema discovered** - 24M price updates/hour with orderbook data
✅ **Sample data analyzed** - 1 hour file (484MB) successfully parsed
✅ **Scripts created**:
- `inspect-pmxt-duckdb.js` - Schema inspection
- `parse-pmxt-json.js` - JSON extraction (orderbook parsing)
- `fetch-resolved-markets.js` - Gamma API integration (needs refinement)

---

## Data Structure (Confirmed)

```json
{
  "timestamp_received": "2026-02-27T15:00:01.725Z",
  "market_id": "0x00000977...",
  "update_type": "price_change",
  "data": {
    "token_id": "44554681...",
    "side": "YES",
    "best_bid": "0.008",
    "best_ask": "0.01",
    "change_price": "0.01",
    "change_size": "5.28",
    "change_side": "SELL"
  }
}
```

**Key insights**:
- `best_bid` / `best_ask` = Top of book (Level 1)
- `change_size` = Orderbook depth change
- Updates on every price/size change (24M/hour for all markets)

---

## Next Steps for Advanced Strategies

### Phase 1: Download Historical Data (Priority)

**What to download**:
- **Minimum**: 1 week (168 files × 484MB = 81 GB)
- **Recommended**: 1 month (720 files × 484MB = 348 GB)
- **Ideal**: All available data (depends on how far back pmxt.dev keeps)

**Script to create**:
```javascript
// scripts/download-pmxt-batch.js
const BASE = 'https://archive.pmxt.dev/dumps/';

// Download all files for a date range
async function downloadDateRange(startDate, endDate) {
  const dates = generateDateRange(startDate, endDate);

  for (const date of dates) {
    for (let hour = 0; hour < 24; hour++) {
      const filename = `polymarket_orderbook_${date}T${hour.toString().padStart(2, '0')}.parquet`;
      const url = `${BASE}${filename}`;

      // Download with resume support
      await downloadWithRetry(url, `./data/pmxt/${filename}`);
    }
  }
}
```

**Storage needed**:
- 1 week = 81 GB
- 1 month = 348 GB
- Consider external drive or cloud storage

### Phase 2: Build Orderbook Reconstruction

For market-making and HFT, you need to reconstruct the full orderbook at any point in time:

```javascript
// scripts/reconstruct-orderbook.js
import duckdb from 'duckdb';

/**
 * Reconstruct orderbook state at specific timestamp
 */
async function getOrderbookSnapshot(tokenId, timestamp) {
  const db = new duckdb.Database(':memory:');

  // Get all updates up to timestamp
  const updates = await db.all(`
    SELECT
      timestamp_received,
      json_extract_string(data, '$.best_bid') as best_bid,
      json_extract_string(data, '$.best_ask') as best_ask,
      json_extract_string(data, '$.change_price') as price,
      json_extract_string(data, '$.change_size') as size,
      json_extract_string(data, '$.change_side') as side
    FROM 'data/pmxt/*.parquet'
    WHERE json_extract_string(data, '$.token_id') = '${tokenId}'
      AND timestamp_received <= '${timestamp}'
    ORDER BY timestamp_received ASC
  `);

  // Reconstruct book state
  const bids = new Map(); // price -> size
  const asks = new Map();

  for (const update of updates) {
    const price = parseFloat(update.price);
    const size = parseFloat(update.size);

    if (update.side === 'BUY') {
      if (size === 0) bids.delete(price);
      else bids.set(price, size);
    } else {
      if (size === 0) asks.delete(price);
      else asks.set(price, size);
    }
  }

  return {
    timestamp,
    bids: Array.from(bids.entries()).sort((a, b) => b[0] - a[0]), // Descending
    asks: Array.from(asks.entries()).sort((a, b) => a[0] - b[0]), // Ascending
    best_bid: Math.max(...bids.keys()),
    best_ask: Math.min(...asks.keys()),
    spread: Math.min(...asks.keys()) - Math.max(...bids.keys()),
  };
}
```

### Phase 3: Liquidity Metrics Extraction

For liquidity analysis:

```javascript
// scripts/analyze-liquidity.js

/**
 * Calculate liquidity metrics over time
 */
async function analyzeLiquidity(tokenId, startTime, endTime) {
  const snapshots = [];
  let currentTime = new Date(startTime);

  // Sample every 1 minute
  while (currentTime <= new Date(endTime)) {
    const book = await getOrderbookSnapshot(tokenId, currentTime.toISOString());

    const metrics = {
      timestamp: currentTime,
      spread_bps: (book.spread / book.best_bid) * 10000,
      bid_depth_100: sumDepthWithin(book.bids, book.best_bid, 0.01), // $100 depth
      ask_depth_100: sumDepthWithin(book.asks, book.best_ask, 0.01),
      total_depth: book.bids.reduce((s, [p, v]) => s + v, 0) + book.asks.reduce((s, [p, v]) => s + v, 0),
      imbalance: (bidDepth - askDepth) / (bidDepth + askDepth), // -1 to 1
    };

    snapshots.push(metrics);
    currentTime = new Date(currentTime.getTime() + 60_000); // +1 minute
  }

  return snapshots;
}
```

### Phase 4: Market-Making Strategy

Once you have orderbook reconstruction:

```javascript
// container/tools/trading/strategies/market-making.js

/**
 * Market-making strategy: provide liquidity and capture spread
 */
export async function marketMakingStrategy(tokenId) {
  const book = await getOrderbookSnapshot(tokenId, new Date());

  // Calculate fair value (mid-price)
  const fairValue = (book.best_bid + book.best_ask) / 2;

  // Calculate optimal spread based on volatility and inventory
  const volatility = calculateRecentVolatility(tokenId, '1h');
  const inventory = getCurrentInventory(tokenId);

  // Skew quotes based on inventory (Avellaneda-Stoikov model)
  const reservationPrice = fairValue - inventory * riskAversion * volatility;

  const optimalSpread = volatility * Math.sqrt(timeToClose) + 2 * riskAversion * volatility^2;

  return {
    bid: reservationPrice - optimalSpread / 2,
    ask: reservationPrice + optimalSpread / 2,
    size: calculateOptimalSize(volatility, spread, inventory),
  };
}
```

### Phase 5: HFT Signal Detection

For high-frequency trading:

```javascript
// container/tools/trading/strategies/hft-signals.js

/**
 * Detect HFT opportunities from orderbook imbalances
 */
export async function detectHFTSignals(tokenId) {
  const book = await getOrderbookSnapshot(tokenId, new Date());

  // Order flow imbalance
  const bidPressure = book.bids.slice(0, 5).reduce((s, [p, v]) => s + v, 0);
  const askPressure = book.asks.slice(0, 5).reduce((s, [p, v]) => s + v, 0);
  const imbalance = (bidPressure - askPressure) / (bidPressure + askPressure);

  // Microstructure signals
  const spread = book.best_ask - book.best_bid;
  const midPrice = (book.best_bid + book.best_ask) / 2;

  // Detect quote stuffing (rapid updates)
  const updateFrequency = await getUpdateFrequency(tokenId, '1m');

  // Price momentum from recent trades
  const recentTrades = await getRecentTrades(tokenId, 100);
  const momentum = calculateMomentum(recentTrades);

  if (imbalance > 0.3 && spread < avgSpread && momentum > 0) {
    return { signal: 'BUY', confidence: imbalance, reason: 'Strong bid pressure + tight spread' };
  }

  if (imbalance < -0.3 && spread < avgSpread && momentum < 0) {
    return { signal: 'SELL', confidence: Math.abs(imbalance), reason: 'Strong ask pressure + tight spread' };
  }

  return { signal: 'NONE' };
}
```

---

## Immediate Next Steps

### Step 1: Download Data (Run on Host Machine)

Create download script and run where you have storage:

```bash
# On your host machine (not container)
cd /path/to/nanoclaw
node scripts/download-pmxt-batch.js \
  --start-date 2026-02-01 \
  --end-date 2026-02-27 \
  --output-dir ./data/pmxt
```

**Estimated time**: 2-3 hours (depends on bandwidth)
**Storage**: ~348 GB for 1 month

### Step 2: Build Orderbook Reconstruction

Test on downloaded data:

```bash
node scripts/reconstruct-orderbook.js \
  --token-id "44554681108074793313893626424278471150091658237406724818592366780413111952248" \
  --timestamp "2026-02-27T15:30:00Z"
```

### Step 3: Analyze Liquidity Patterns

Run liquidity analysis on high-volume markets:

```bash
node scripts/analyze-liquidity.js \
  --token-id "..." \
  --start "2026-02-20T00:00:00Z" \
  --end "2026-02-27T00:00:00Z" \
  --interval "1m"
```

### Step 4: Backtest Market-Making

Test spread capture strategy:

```bash
node scripts/backtest-market-making.js \
  --strategy avellaneda-stoikov \
  --capital 10000 \
  --risk-aversion 0.1
```

---

## Timeline Estimate (Revised for Advanced Strategies)

| Phase | Task | Time |
|-------|------|------|
| 1 | Download 1 month of pmxt data | 2-3 hours |
| 2 | Build orderbook reconstruction | 4-6 hours |
| 3 | Create liquidity metrics tools | 3-4 hours |
| 4 | Implement market-making strategy | 6-8 hours |
| 5 | Build HFT signal detection | 4-6 hours |
| 6 | Backtest on historical data | 4-6 hours |

**Total**: 23-33 hours of focused work

---

## Storage & Infrastructure Recommendations

**For 1 month of data (348 GB)**:
- External SSD (1TB recommended)
- Cloud storage (AWS S3, Google Cloud Storage)
- Network-attached storage (NAS)

**For processing**:
- Run DuckDB queries on host machine (not container)
- Consider upgrading container RAM limits for development
- Use batch processing for production

---

## Key Differences from Simple Probability Backtesting

**Simple probability strategy** (your current plan):
- 1 price point per day
- Kelly sizing based on edge
- ~100 KB of data needed

**Advanced HFT/market-making**:
- 24M price updates per hour
- Orderbook reconstruction required
- ~348 GB of data for 1 month
- Real-time execution simulation
- Microstructure analysis

**Your goals require the advanced path** ✅

---

## Next Decision

Do you want me to:

**A) Build download script** - Batch download pmxt files to your host machine
**B) Build orderbook reconstruction** - Parse pmxt data into usable book snapshots
**C) Create market-making strategy** - Implement Avellaneda-Stoikov model
**D) Start with liquidity analysis** - Analyze spread/depth patterns first

Which would you like me to prioritize?
