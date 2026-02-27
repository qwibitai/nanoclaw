#!/usr/bin/env node

/**
 * Inspect pmxt.dev Parquet data format
 */

import parquet from 'parquetjs';
import fs from 'fs';

async function inspectParquet(filePath) {
  console.log(`\nInspecting: ${filePath}\n`);

  const reader = await parquet.ParquetReader.openFile(filePath);

  // Print schema
  console.log('=== SCHEMA ===');
  const schema = reader.schema;
  console.log('Fields:');
  for (const field of schema.fieldList) {
    console.log(`  - ${field.name}: ${field.primitiveType || field.originalType} (${field.repetitionType})`);
  }

  // Get row count
  const rowCount = reader.getRowCount();
  console.log(`\nTotal rows: ${rowCount.toLocaleString()}`);

  // Read first 5 rows
  console.log('\n=== SAMPLE ROWS (first 5) ===');
  const cursor = reader.getCursor();
  for (let i = 0; i < 5; i++) {
    const record = await cursor.next();
    if (!record) break;
    console.log(`\nRow ${i + 1}:`);
    console.log(JSON.stringify(record, null, 2));
  }

  await reader.close();

  console.log('\n=== ANALYSIS ===');
  console.log('This appears to be orderbook snapshot data.');
  console.log('Key fields for backtesting:');
  console.log('  - timestamp: When the snapshot was taken');
  console.log('  - token_id or market_id: Which prediction market');
  console.log('  - price/bid/ask: Market prices');
  console.log('  - volume: Trading activity');
  console.log('\nFor backtesting probability estimation:');
  console.log('  1. Filter for markets that have RESOLVED');
  console.log('  2. Extract price history leading up to resolution');
  console.log('  3. Compare your probability estimate vs market price');
  console.log('  4. Check if actual outcome matched your prediction');
}

const filePath = process.argv[2] || '/tmp/sample.parquet';

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

inspectParquet(filePath).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
