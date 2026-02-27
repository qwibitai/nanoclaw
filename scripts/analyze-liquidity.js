#!/usr/bin/env node

/**
 * Analyze liquidity metrics over time from pmxt.dev data
 *
 * Usage:
 *   node scripts/analyze-liquidity.js \
 *     --token-id "44554681..." \
 *     --start "2026-02-27T00:00:00Z" \
 *     --end "2026-02-27T23:59:59Z" \
 *     --interval "5m" \
 *     --output liquidity.csv
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
const interval = getArg('--interval') || '5m'; // 1m, 5m, 15m, 1h
const dataDir = getArg('--data-dir') || './data/pmxt';
const outputCsv = getArg('--output');

if (!tokenId || !startTime || !endTime) {
  console.error('Usage: --token-id TOKEN --start ISO_TIME --end ISO_TIME [--interval 5m] [--output FILE]');
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

// Parse interval to milliseconds
function parseInterval(interval) {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) throw new Error(`Invalid interval: ${interval}`);

  const value = parseInt(match[1]);
  const unit = match[2];

  const ms = {
    m: 60_000,
    h: 3600_000,
    d: 86_400_000,
  };

  return value * ms[unit];
}

async function analyzeLiquidity() {
  console.log('\n=== Liquidity Analysis ===');
  console.log(`Token: ${tokenId.substring(0, 20)}...`);
  console.log(`Period: ${startTime} to ${endTime}`);
  console.log(`Interval: ${interval}\n`);

  // Find relevant files
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

  console.log(`Found ${files.length} data files\n`);

  if (files.length === 0) {
    console.error('❌ No data files found for this period.');
    process.exit(1);
  }

  // Query all updates in time range
  const fileList = files.map(f => `'${f}'`).join(', ');

  console.log('📊 Querying price updates...');

  const updates = await query(`
    SELECT
      timestamp_received,
      json_extract_string(data, '$.side') as side,
      CAST(json_extract_string(data, '$.best_bid') AS DOUBLE) as best_bid,
      CAST(json_extract_string(data, '$.best_ask') AS DOUBLE) as best_ask,
      CAST(json_extract_string(data, '$.change_size') AS DOUBLE) as change_size
    FROM read_parquet([${fileList}])
    WHERE json_extract_string(data, '$.token_id') = '${tokenId}'
      AND timestamp_received >= '${startTime}'
      AND timestamp_received <= '${endTime}'
    ORDER BY timestamp_received ASC
  `);

  console.log(`✅ Found ${updates.length} updates\n`);

  if (updates.length === 0) {
    console.error('❌ No updates found for this token in this period.');
    process.exit(1);
  }

  // Calculate liquidity metrics at each interval
  console.log('📈 Calculating metrics...');

  const intervalMs = parseInterval(interval);
  const metrics = [];

  let currentTime = start.getTime();
  const endMs = end.getTime();

  let updateIndex = 0;
  let currentBid = 0;
  let currentAsk = 1;

  while (currentTime <= endMs) {
    const windowEnd = currentTime + intervalMs;

    // Process all updates in this window
    let updateCount = 0;
    let volumeSum = 0;

    while (updateIndex < updates.length) {
      const update = updates[updateIndex];
      const updateTime = new Date(update.timestamp_received).getTime();

      if (updateTime > windowEnd) break;

      // Update bid/ask
      if (update.best_bid) currentBid = update.best_bid;
      if (update.best_ask) currentAsk = update.best_ask;

      // Accumulate volume
      if (update.change_size) volumeSum += Math.abs(update.change_size);

      updateCount++;
      updateIndex++;
    }

    const midPrice = (currentBid + currentAsk) / 2;
    const spread = currentAsk - currentBid;
    const spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : 0;

    metrics.push({
      timestamp: new Date(currentTime).toISOString(),
      best_bid: currentBid,
      best_ask: currentAsk,
      mid_price: midPrice,
      spread,
      spread_bps: spreadBps,
      update_count: updateCount,
      volume: volumeSum,
    });

    currentTime += intervalMs;
  }

  console.log(`✅ Calculated ${metrics.length} data points\n`);

  // Statistics
  const avgSpread = metrics.reduce((sum, m) => sum + m.spread_bps, 0) / metrics.length;
  const minSpread = Math.min(...metrics.map(m => m.spread_bps));
  const maxSpread = Math.max(...metrics.map(m => m.spread_bps));
  const totalVolume = metrics.reduce((sum, m) => sum + m.volume, 0);
  const avgVolume = totalVolume / metrics.length;

  console.log('=== STATISTICS ===');
  console.log(`Data points: ${metrics.length}`);
  console.log(`Avg spread: ${avgSpread.toFixed(2)} bps`);
  console.log(`Min spread: ${minSpread.toFixed(2)} bps`);
  console.log(`Max spread: ${maxSpread.toFixed(2)} bps`);
  console.log(`Total volume: ${totalVolume.toFixed(2)}`);
  console.log(`Avg volume per ${interval}: ${avgVolume.toFixed(2)}`);

  // Find periods of tight/wide spreads
  const tightPeriods = metrics.filter(m => m.spread_bps < avgSpread * 0.7);
  const widePeriods = metrics.filter(m => m.spread_bps > avgSpread * 1.5);

  console.log(`\nTight spread periods (< ${(avgSpread * 0.7).toFixed(2)} bps): ${tightPeriods.length}`);
  console.log(`Wide spread periods (> ${(avgSpread * 1.5).toFixed(2)} bps): ${widePeriods.length}`);

  // Show sample
  console.log('\n=== SAMPLE DATA (first 5 intervals) ===');
  metrics.slice(0, 5).forEach(m => {
    console.log(`${m.timestamp}: spread=${m.spread_bps.toFixed(2)} bps, volume=${m.volume.toFixed(2)}, updates=${m.update_count}`);
  });

  // Export to CSV
  if (outputCsv) {
    const csv = [
      'timestamp,best_bid,best_ask,mid_price,spread,spread_bps,update_count,volume',
      ...metrics.map(m =>
        `${m.timestamp},${m.best_bid},${m.best_ask},${m.mid_price},${m.spread},${m.spread_bps},${m.update_count},${m.volume}`
      ),
    ].join('\n');

    fs.writeFileSync(outputCsv, csv);
    console.log(`\n✅ Exported to: ${outputCsv}`);
  }

  db.close();
  return metrics;
}

analyzeLiquidity().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
