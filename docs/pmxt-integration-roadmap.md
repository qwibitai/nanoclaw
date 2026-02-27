# pmxt.dev Integration Roadmap

## Overview

Integrate historical Polymarket data from pmxt.dev to backtest probability estimation strategies before live trading.

## Quick Start (Recommended Path)

### Option 1: DuckDB (Easiest)

DuckDB can query Parquet files directly without import:

```bash
npm install duckdb

# Query Parquet directly
node -e "
const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');

db.all(
  `SELECT * FROM '/tmp/sample.parquet' LIMIT 5`,
  (err, rows) => {
    console.log(rows);
  }
);
"
```

Benefits:
- No import needed
- SQL queries on Parquet files
- Fast analytics
- Can join multiple hourly files

### Option 2: Python Script (Most Robust)

If Python pandas/pyarrow available:

```python
import pandas as pd

# Read Parquet
df = pd.read_parquet('/tmp/sample.parquet')

# Inspect schema
print(df.dtypes)
print(df.head())

# Filter for specific markets
btc_markets = df[df['question'].str.contains('Bitcoin', case=False)]

# Export to CSV for SQLite import
df.to_csv('/tmp/polymarket_data.csv', index=False)
```

Then import CSV to SQLite via Node.

### Option 3: Direct Parquet.js (Current Attempt)

Fix the parquetjs integration - error suggests binary format issue.

## Implementation Steps

### Step 1: Schema Discovery

**Need to determine**:
1. What fields exist in the Parquet files?
2. Which field identifies market/event (token_id, market_id, condition_id)?
3. Which field shows price (mid, last, best_bid, best_ask)?
4. Which field indicates resolution status?
5. Which field shows actual outcome?

**Action**: Contact pmxt.dev Discord/Telegram for schema docs

### Step 2: Data Download Strategy

**Current reality**: Files are 400-500 MB each

**Options**:
- Download 1 week = ~168 files = ~67 GB
- Download 1 day = ~24 files = ~9.6 GB
- Download selective hours during active trading

**Recommendation**: Start with 24 hours (1 day) to test pipeline

### Step 3: Import Pipeline

Create `/workspace/project/scripts/import-pmxt-data.js`:

```javascript
#!/usr/bin/env node

/**
 * Import pmxt.dev historical data into market_data table
 *
 * Usage:
 *   node scripts/import-pmxt-data.js /path/to/file.parquet
 *   node scripts/import-pmxt-data.js --download 2026-02-27  # download all hours for date
 */

import Database from 'better-sqlite3';
import duckdb from 'duckdb'; // or parquetjs, or call Python script

async function importParquetFile(parquetPath) {
  // Read Parquet file
  const duck = new duckdb.Database(':memory:');

  // Query Parquet
  const rows = await duck.all(`
    SELECT
      token_id as symbol,
      timestamp,
      mid_price as price,
      volume_24h as volume,
      NULL as open_interest
    FROM read_parquet('${parquetPath}')
  `);

  // Insert into SQLite
  const db = new Database('store/messages.db');
  const insert = db.prepare(`
    INSERT INTO market_data (platform, symbol, timestamp, price, volume, open_interest, metadata)
    VALUES ('polymarket', ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    insert.run(row.symbol, row.timestamp, row.price, row.volume, row.open_interest, null);
  }

  db.close();
  console.log(`Imported ${rows.length} rows from ${parquetPath}`);
}
```

### Step 4: Resolved Markets Identification

**Critical**: Need to filter for markets that have RESOLVED (outcome known)

**Possible approaches**:
1. pmxt.dev may have a separate "resolved markets" dataset
2. Gamma API endpoint: `/events?closed=true` lists resolved markets
3. Cross-reference: Download recent Parquet → check Gamma API for resolution

**Create** `/workspace/project/scripts/fetch-resolved-markets.js`:

```javascript
#!/usr/bin/env node

/**
 * Fetch list of resolved Polymarket markets from Gamma API
 */

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

async function fetchResolvedMarkets() {
  const res = await fetch(`${GAMMA_BASE}/events?closed=true&limit=1000`);
  const events = await res.json();

  const resolved = [];
  for (const event of events) {
    for (const market of event.markets || []) {
      if (market.closed && market.resolvedOutcome !== undefined) {
        resolved.push({
          market_id: market.id,
          token_ids: market.clobTokenIds,
          question: market.question,
          resolved_outcome: market.resolvedOutcome,
          close_date: market.endDate,
        });
      }
    }
  }

  console.log(JSON.stringify(resolved, null, 2));
  return resolved;
}

fetchResolvedMarkets();
```

### Step 5: Backtest Probability Estimation

**For each resolved market**:

1. Load price history from `market_data` table
2. Select a timestamp BEFORE resolution (e.g., 24 hours before close)
3. Run `analyze-event-probability` tool at that timestamp
4. Compare: estimated true_prob vs market_price vs actual_outcome
5. Calculate edge: true_prob - market_price
6. Calculate P&L: if traded using Kelly sizing

**Create** `/workspace/project/scripts/backtest-probability.js`:

```javascript
#!/usr/bin/env node

/**
 * Backtest probability estimation on resolved markets
 */

import Database from 'better-sqlite3';
import { analyzeEventProbability } from '../container/tools/trading/analyze-event-probability.js';

async function backtestResolvedMarket(marketId, resolvedOutcome) {
  const db = new Database('store/messages.db');

  // Get price history for this market
  const history = db.prepare(`
    SELECT timestamp, price
    FROM market_data
    WHERE symbol = ?
    ORDER BY timestamp ASC
  `).all(marketId);

  if (history.length < 10) return null; // Not enough data

  // Use price from 24 hours before close
  const estimatePoint = history[history.length - 24]; // Assuming hourly data
  const marketPrice = estimatePoint.price;

  // Run probability estimation (would need event metadata)
  // For now, mock this - real implementation needs event type detection
  const estimate = await analyzeEventProbability({
    platform: 'polymarket',
    event_type: 'auto-detect', // Would need to classify
    min_edge: 0.05,
    min_confidence: 0.60,
  });

  // Calculate metrics
  const trueProb = estimate.trueProb;
  const edge = trueProb - marketPrice;
  const wasCorrect = (resolvedOutcome === 1 && trueProb > 0.5) ||
                     (resolvedOutcome === 0 && trueProb < 0.5);

  // Kelly sizing
  const odds = (1 - marketPrice) / marketPrice;
  const kellyFraction = (trueProb * odds - (1 - trueProb)) / odds;
  const sizeUsed = Math.max(0, kellyFraction * 0.5); // Half Kelly

  // P&L calculation
  const pnl = wasCorrect ? sizeUsed * (resolvedOutcome === 1 ? odds : 1) : -sizeUsed;

  return {
    market_id: marketId,
    market_price: marketPrice,
    estimated_prob: trueProb,
    edge,
    was_correct: wasCorrect,
    kelly_size: sizeUsed,
    pnl,
  };
}

// Run on all resolved markets
async function runBacktest() {
  const resolved = JSON.parse(fs.readFileSync('resolved_markets.json', 'utf-8'));
  const results = [];

  for (const market of resolved) {
    const result = await backtestResolvedMarket(market.market_id, market.resolved_outcome);
    if (result) results.push(result);
  }

  // Calculate aggregate metrics
  const totalPnL = results.reduce((sum, r) => sum + r.pnl, 0);
  const wins = results.filter(r => r.was_correct).length;
  const winRate = wins / results.length;
  const avgEdge = results.reduce((sum, r) => sum + r.edge, 0) / results.length;

  console.log(`\n=== BACKTEST RESULTS ===`);
  console.log(`Markets tested: ${results.length}`);
  console.log(`Win rate: ${(winRate * 100).toFixed(1)}%`);
  console.log(`Average edge: ${(avgEdge * 100).toFixed(1)} points`);
  console.log(`Total P&L: ${totalPnL.toFixed(2)} units`);
  console.log(`\nThis proves edge: ${winRate > 0.55 && avgEdge > 0 ? 'YES ✅' : 'NO ❌'}`);
}

runBacktest();
```

## Timeline Estimate

- **Phase 1** (Schema Discovery): 1 hour (contact pmxt.dev, await response)
- **Phase 2** (Setup Tooling): 1-2 hours (DuckDB or Python pandas)
- **Phase 3** (Download Data): 1 hour (24 hours of data = ~10 GB)
- **Phase 4** (Import Pipeline): 2 hours (write + test import script)
- **Phase 5** (Resolved Markets List): 1 hour (Gamma API integration)
- **Phase 6** (Backtest Script): 3-4 hours (probability estimation integration)
- **Phase 7** (Analysis & Docs): 1-2 hours (interpret results, update memory)

**Total**: 10-13 hours of work

## Success Criteria

After backtesting on 50-100 resolved markets:

✅ **Proven edge** if:
- Win rate > 55% (better than coin flip + edge)
- Average edge > 5 percentage points
- Positive total P&L with Kelly sizing
- Max drawdown < 25%

❌ **No edge** if:
- Win rate < 52%
- Average edge < 2 percentage points
- Negative P&L
- Frequent deep drawdowns

## Next Immediate Action

**Choice for user**:

1. **Quick test** (2-3 hours): Install DuckDB, query 1 Parquet file, understand schema
2. **Full setup** (10-13 hours): Complete all phases, backtest 100 markets
3. **Contact pmxt** first: Get schema docs before building anything

Which would you prefer?
