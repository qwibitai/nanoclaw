#!/usr/bin/env node

/**
 * Backtest market-making strategy on historical pmxt.dev data
 *
 * Usage:
 *   node scripts/backtest-market-making.js \
 *     --token-id "44554681..." \
 *     --start "2026-02-27T00:00:00Z" \
 *     --end "2026-02-27T23:59:59Z" \
 *     --capital 10000 \
 *     --risk-aversion 0.05
 */

import duckdb from 'duckdb';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
};

const tokenId = getArg('--token-id');
const startTime = getArg('--start');
const endTime = getArg('--end');
const initialCapital = parseFloat(getArg('--capital') || '10000');
const riskAversion = parseFloat(getArg('--risk-aversion') || '0.05');
const dataDir = getArg('--data-dir') || './data/pmxt';
const outputCsv = getArg('--output');

if (!tokenId || !startTime || !endTime) {
  console.error('Usage: --token-id TOKEN --start TIME --end TIME [--capital 10000] [--risk-aversion 0.05]');
  process.exit(1);
}

const db = new duckdb.Database(':memory:');

function query(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Market-making strategy implementation
function calculateQuotes(midPrice, volatility, inventory, timeToClose) {
  const gamma = riskAversion;
  const sigma = volatility;
  const T = timeToClose / 365; // Convert days to years
  const maxInventory = initialCapital / midPrice; // Max position in tokens

  // Avellaneda-Stoikov model
  const inventorySkew = inventory * gamma * Math.pow(sigma, 2) * T;
  const reservationPrice = midPrice - inventorySkew;

  const baseSpread = gamma * Math.pow(sigma, 2) * T;
  const inventoryRatio = Math.abs(inventory) / maxInventory;
  const inventoryPenalty = inventoryRatio * baseSpread * 0.5;

  let optimalSpread = baseSpread + inventoryPenalty;
  optimalSpread = Math.max(0.0005, Math.min(0.05, optimalSpread)); // 5 bps to 500 bps

  const bidPrice = Math.max(0.001, reservationPrice - optimalSpread / 2);
  const askPrice = Math.min(0.999, reservationPrice + optimalSpread / 2);

  const baseSize = 100; // $100 base order
  const sizeInTokens = baseSize / midPrice;

  return {
    bidPrice,
    askPrice,
    bidSize: sizeInTokens,
    askSize: sizeInTokens,
    spread: optimalSpread,
    reservationPrice,
  };
}

function estimateVolatility(prices) {
  if (prices.length < 2) return 0.1;

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const r = Math.log(prices[i] / prices[i - 1]);
    returns.push(r);
  }

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  return Math.max(0.05, Math.min(2.0, stdDev * Math.sqrt(24 * 365)));
}

async function backtestMarketMaking() {
  console.log('\n=== Market-Making Backtest ===');
  console.log(`Token: ${tokenId.substring(0, 20)}...`);
  console.log(`Period: ${startTime} to ${endTime}`);
  console.log(`Initial capital: $${initialCapital}`);
  console.log(`Risk aversion: ${riskAversion}\n`);

  // Load data
  const start = new Date(startTime);
  const end = new Date(endTime);

  const files = fs.readdirSync(dataDir)
    .filter(f => f.endsWith('.parquet'))
    .filter(f => {
      const match = f.match(/(\d{4}-\d{2}-\d{2}T\d{2})/);
      if (!match) return false;
      const fileDate = new Date(match[1]);
      return fileDate >= start && fileDate <= end;
    })
    .map(f => path.join(dataDir, f));

  if (files.length === 0) {
    console.error('❌ No data files found');
    process.exit(1);
  }

  console.log(`📊 Loading data from ${files.length} files...`);

  const fileList = files.map(f => `'${f}'`).join(', ');

  const updates = await query(`
    SELECT
      timestamp_received,
      CAST(json_extract_string(data, '$.best_bid') AS DOUBLE) as best_bid,
      CAST(json_extract_string(data, '$.best_ask') AS DOUBLE) as best_ask
    FROM read_parquet([${fileList}])
    WHERE json_extract_string(data, '$.token_id') = '${tokenId}'
      AND timestamp_received >= '${startTime}'
      AND timestamp_received <= '${endTime}'
      AND json_extract_string(data, '$.best_bid') IS NOT NULL
      AND json_extract_string(data, '$.best_ask') IS NOT NULL
    ORDER BY timestamp_received ASC
  `);

  console.log(`✅ Loaded ${updates.length} price updates\n`);

  if (updates.length < 10) {
    console.error('❌ Not enough data');
    process.exit(1);
  }

  // Backtest simulation
  console.log('🔄 Running backtest...\n');

  let capital = initialCapital;
  let inventory = 0; // Token position
  let totalFees = 0;
  let numTrades = 0;
  let wins = 0;
  let losses = 0;

  const trades = [];
  const snapshots = [];

  // Sample every 100 updates to reduce computation
  const sampleInterval = Math.floor(updates.length / 1000) || 1;

  for (let i = 0; i < updates.length; i += sampleInterval) {
    const update = updates[i];
    const midPrice = (update.best_bid + update.best_ask) / 2;

    if (!midPrice || midPrice <= 0) continue;

    // Calculate volatility from recent prices
    const recentPrices = updates
      .slice(Math.max(0, i - 100), i + 1)
      .map(u => (u.best_bid + u.best_ask) / 2)
      .filter(p => p > 0);

    const volatility = estimateVolatility(recentPrices);

    // Days to close (assume 7 days for demo)
    const timeToClose = 7;

    // Calculate quotes
    const quotes = calculateQuotes(midPrice, volatility, inventory, timeToClose);

    // Simulate fills: if market crosses our quotes, we get filled
    // Buy filled if market trades at or below our bid
    // Sell filled if market trades at or above our ask
    if (update.best_ask <= quotes.bidPrice && capital >= quotes.bidPrice * quotes.bidSize) {
      // We buy at our bid price
      const fillPrice = quotes.bidPrice;
      const fillSize = quotes.bidSize;
      const cost = fillPrice * fillSize;

      capital -= cost;
      inventory += fillSize;
      numTrades++;

      trades.push({
        timestamp: update.timestamp_received,
        side: 'BUY',
        price: fillPrice,
        size: fillSize,
        cost,
        inventory,
        capital,
      });
    }

    if (update.best_bid >= quotes.askPrice && inventory >= quotes.askSize) {
      // We sell at our ask price
      const fillPrice = quotes.askPrice;
      const fillSize = quotes.askSize;
      const proceeds = fillPrice * fillSize;

      capital += proceeds;
      inventory -= fillSize;
      numTrades++;

      trades.push({
        timestamp: update.timestamp_received,
        side: 'SELL',
        price: fillPrice,
        size: fillSize,
        proceeds,
        inventory,
        capital,
      });
    }

    // Snapshot every 100 updates
    if (i % (sampleInterval * 10) === 0) {
      const portfolioValue = capital + inventory * midPrice;
      snapshots.push({
        timestamp: update.timestamp_received,
        capital,
        inventory,
        midPrice,
        portfolioValue,
        pnl: portfolioValue - initialCapital,
        numTrades,
      });
    }
  }

  // Final portfolio value
  const finalMidPrice = (updates[updates.length - 1].best_bid + updates[updates.length - 1].best_ask) / 2;
  const finalValue = capital + inventory * finalMidPrice;
  const totalPnL = finalValue - initialCapital;
  const returnPct = (totalPnL / initialCapital) * 100;

  // Calculate metrics
  let maxDrawdown = 0;
  let peak = initialCapital;

  for (const snap of snapshots) {
    if (snap.portfolioValue > peak) peak = snap.portfolioValue;
    const drawdown = (peak - snap.portfolioValue) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const avgTradeSize = trades.length > 0
    ? trades.reduce((sum, t) => sum + (t.size || 0), 0) / trades.length
    : 0;

  const avgSpread = trades.length > 1
    ? trades.filter((t, i) => i > 0 && t.side !== trades[i-1].side)
        .reduce((sum, t, i, arr) => {
          const prev = trades[trades.indexOf(t) - 1];
          return sum + Math.abs(t.price - prev.price);
        }, 0) / trades.length
    : 0;

  // Results
  console.log('=== BACKTEST RESULTS ===');
  console.log(`Period: ${new Date(startTime).toLocaleDateString()} to ${new Date(endTime).toLocaleDateString()}`);
  console.log(`\n💰 Performance:`);
  console.log(`  Initial capital: $${initialCapital.toFixed(2)}`);
  console.log(`  Final value: $${finalValue.toFixed(2)}`);
  console.log(`  Total P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%)`);
  console.log(`  Max drawdown: ${(maxDrawdown * 100).toFixed(2)}%`);

  console.log(`\n📊 Trading Activity:`);
  console.log(`  Total trades: ${numTrades}`);
  console.log(`  Avg trade size: ${avgTradeSize.toFixed(2)} tokens`);
  console.log(`  Avg spread captured: ${(avgSpread * 10000).toFixed(1)} bps`);
  console.log(`  Final inventory: ${inventory.toFixed(2)} tokens`);

  console.log(`\n📈 Risk Metrics:`);
  console.log(`  Risk aversion (γ): ${riskAversion}`);
  console.log(`  Sharpe ratio: ${calculateSharpe(snapshots)}`);

  // Save results
  if (outputCsv) {
    const csv = [
      'timestamp,capital,inventory,mid_price,portfolio_value,pnl,num_trades',
      ...snapshots.map(s =>
        `${s.timestamp},${s.capital},${s.inventory},${s.midPrice},${s.portfolioValue},${s.pnl},${s.numTrades}`
      ),
    ].join('\n');

    fs.writeFileSync(outputCsv, csv);
    console.log(`\n✅ Results saved to: ${outputCsv}`);
  }

  db.close();
}

function calculateSharpe(snapshots) {
  if (snapshots.length < 2) return 'N/A';

  const returns = [];
  for (let i = 1; i < snapshots.length; i++) {
    const ret = (snapshots[i].portfolioValue - snapshots[i-1].portfolioValue) / snapshots[i-1].portfolioValue;
    returns.push(ret);
  }

  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(365) : 0;
  return sharpe.toFixed(2);
}

backtestMarketMaking().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
