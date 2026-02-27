#!/usr/bin/env node

/**
 * Reconstruct orderbook state from pmxt.dev price updates
 *
 * Usage:
 *   node scripts/reconstruct-orderbook.js \
 *     --token-id "44554681108074793313893626424278471150091658237406724818592366780413111952248" \
 *     --timestamp "2026-02-27T15:30:00Z" \
 *     --data-dir ./data/pmxt
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
const timestamp = getArg('--timestamp');
const dataDir = getArg('--data-dir') || './data/pmxt';
const outputJson = getArg('--output');

if (!tokenId || !timestamp) {
  console.error('Usage: --token-id TOKEN --timestamp ISO_TIMESTAMP [--data-dir DIR] [--output FILE]');
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

async function reconstructOrderbook() {
  console.log('\n=== Orderbook Reconstruction ===');
  console.log(`Token ID: ${tokenId.substring(0, 20)}...`);
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Data directory: ${dataDir}\n`);

  // Find Parquet files that contain data up to timestamp
  const targetDate = new Date(timestamp);
  const files = fs.readdirSync(dataDir)
    .filter(f => f.endsWith('.parquet'))
    .filter(f => {
      const match = f.match(/(\d{4}-\d{2}-\d{2}T\d{2})/);
      if (!match) return false;
      const fileDate = new Date(match[1]);
      return fileDate <= targetDate;
    })
    .map(f => path.join(dataDir, f));

  console.log(`Found ${files.length} relevant files\n`);

  if (files.length === 0) {
    console.error('❌ No data files found. Run download-pmxt-batch.js first.');
    process.exit(1);
  }

  // Query all updates for this token up to timestamp
  console.log('📊 Querying price updates...');

  const fileList = files.map(f => `'${f}'`).join(', ');

  const updates = await query(`
    SELECT
      timestamp_received,
      json_extract_string(data, '$.side') as side,
      CAST(json_extract_string(data, '$.best_bid') AS DOUBLE) as best_bid,
      CAST(json_extract_string(data, '$.best_ask') AS DOUBLE) as best_ask,
      CAST(json_extract_string(data, '$.change_price') AS DOUBLE) as change_price,
      CAST(json_extract_string(data, '$.change_size') AS DOUBLE) as change_size,
      json_extract_string(data, '$.change_side') as change_side
    FROM read_parquet([${fileList}])
    WHERE json_extract_string(data, '$.token_id') = '${tokenId}'
      AND timestamp_received <= '${timestamp}'
    ORDER BY timestamp_received ASC
  `);

  console.log(`✅ Found ${updates.length} price updates\n`);

  if (updates.length === 0) {
    console.error('❌ No updates found for this token. Check token ID.');
    process.exit(1);
  }

  // Reconstruct orderbook from updates
  console.log('📖 Reconstructing orderbook...');

  const bids = new Map(); // price -> size
  const asks = new Map();

  let lastUpdate = null;

  for (const update of updates) {
    lastUpdate = update.timestamp_received;

    // Update best bid/ask if provided
    if (update.best_bid && update.side === 'YES') {
      bids.set(update.best_bid, 1); // We don't have size for best_bid/ask, use 1 as placeholder
    }
    if (update.best_ask && update.side === 'YES') {
      asks.set(update.best_ask, 1);
    }

    // Process orderbook change
    if (update.change_price && update.change_size !== null) {
      const price = update.change_price;
      const size = update.change_size;

      if (update.change_side === 'BUY') {
        if (size === 0) bids.delete(price);
        else bids.set(price, size);
      } else if (update.change_side === 'SELL') {
        if (size === 0) asks.delete(price);
        else asks.set(price, size);
      }
    }
  }

  // Sort and convert to arrays
  const bidArray = Array.from(bids.entries())
    .sort((a, b) => b[0] - a[0]) // Descending (highest bid first)
    .map(([price, size]) => ({ price, size }));

  const askArray = Array.from(asks.entries())
    .sort((a, b) => a[0] - b[0]) // Ascending (lowest ask first)
    .map(([price, size]) => ({ price, size }));

  const bestBid = bidArray[0]?.price || 0;
  const bestAsk = askArray[0]?.price || 1;
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadBps = (spread / midPrice) * 10000;

  const orderbook = {
    token_id: tokenId,
    timestamp,
    last_update: lastUpdate,
    updates_count: updates.length,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid_price: midPrice,
    spread,
    spread_bps: spreadBps,
    bids: bidArray.slice(0, 10), // Top 10 levels
    asks: askArray.slice(0, 10),
    total_bid_depth: bidArray.reduce((sum, b) => sum + b.size, 0),
    total_ask_depth: askArray.reduce((sum, a) => sum + a.size, 0),
  };

  console.log('✅ Orderbook reconstructed\n');

  // Display
  console.log('=== ORDERBOOK SNAPSHOT ===');
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Last update: ${lastUpdate}`);
  console.log(`Updates processed: ${updates.length}`);
  console.log(`\nBest bid: ${bestBid.toFixed(4)}`);
  console.log(`Best ask: ${bestAsk.toFixed(4)}`);
  console.log(`Mid price: ${midPrice.toFixed(4)}`);
  console.log(`Spread: ${spread.toFixed(4)} (${spreadBps.toFixed(2)} bps)`);

  console.log('\n=== BIDS (top 10) ===');
  orderbook.bids.forEach((bid, i) => {
    console.log(`${i + 1}. ${bid.price.toFixed(4)} @ ${bid.size.toFixed(2)}`);
  });

  console.log('\n=== ASKS (top 10) ===');
  orderbook.asks.forEach((ask, i) => {
    console.log(`${i + 1}. ${ask.price.toFixed(4)} @ ${ask.size.toFixed(2)}`);
  });

  console.log(`\nTotal bid depth: ${orderbook.total_bid_depth.toFixed(2)}`);
  console.log(`Total ask depth: ${orderbook.total_ask_depth.toFixed(2)}`);

  // Save to JSON if requested
  if (outputJson) {
    fs.writeFileSync(outputJson, JSON.stringify(orderbook, null, 2));
    console.log(`\n✅ Saved to: ${outputJson}`);
  }

  db.close();
  return orderbook;
}

reconstructOrderbook().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
