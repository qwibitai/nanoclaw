#!/usr/bin/env node

/**
 * Inspect pmxt.dev Parquet data using DuckDB
 * DuckDB is memory-efficient - queries Parquet directly without loading into RAM
 */

import duckdb from 'duckdb';

const parquetPath = process.argv[2] || '/tmp/sample.parquet';

console.log(`\n=== INSPECTING: ${parquetPath} ===\n`);

const db = new duckdb.Database(':memory:');

// Helper to run queries
function query(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function inspect() {
  try {
    // Get schema
    console.log('=== SCHEMA ===');
    const schema = await query(`DESCRIBE SELECT * FROM '${parquetPath}' LIMIT 1`);
    schema.forEach(col => {
      console.log(`  ${col.column_name}: ${col.column_type}`);
    });

    // Get row count (efficient - uses Parquet metadata)
    console.log('\n=== METADATA ===');
    const count = await query(`SELECT COUNT(*) as total FROM '${parquetPath}'`);
    console.log(`Total rows: ${count[0].total.toLocaleString()}`);

    // Get first 5 rows
    console.log('\n=== SAMPLE DATA (first 5 rows) ===');
    const sample = await query(`SELECT * FROM '${parquetPath}' LIMIT 5`);
    console.log(JSON.stringify(sample, null, 2));

    // Analyze key columns
    console.log('\n=== COLUMN ANALYSIS ===');

    // Get all column names
    const columns = schema.map(s => s.column_name);

    // Find ID-like columns
    const idCols = columns.filter(col =>
      col.toLowerCase().includes('id') ||
      col.toLowerCase().includes('token') ||
      col.toLowerCase().includes('market') ||
      col.toLowerCase().includes('condition')
    );

    console.log(`\nID-like columns: ${idCols.join(', ')}`);

    // Count unique values in first ID column
    if (idCols.length > 0) {
      const uniqueCount = await query(`SELECT COUNT(DISTINCT ${idCols[0]}) as unique_count FROM '${parquetPath}'`);
      console.log(`Unique ${idCols[0]}: ${uniqueCount[0].unique_count.toLocaleString()}`);
    }

    // Find timestamp columns
    const timestampCols = columns.filter(col =>
      col.toLowerCase().includes('time') ||
      col.toLowerCase().includes('date')
    );

    if (timestampCols.length > 0) {
      console.log(`\nTimestamp columns: ${timestampCols.join(', ')}`);
      const timeRange = await query(`
        SELECT
          MIN(${timestampCols[0]}) as min_time,
          MAX(${timestampCols[0]}) as max_time
        FROM '${parquetPath}'
      `);
      console.log(`Time range: ${timeRange[0].min_time} to ${timeRange[0].max_time}`);
    }

    // Find price columns
    const priceCols = columns.filter(col =>
      col.toLowerCase().includes('price') ||
      col.toLowerCase().includes('bid') ||
      col.toLowerCase().includes('ask') ||
      col.toLowerCase().includes('mid')
    );

    if (priceCols.length > 0) {
      console.log(`\nPrice columns: ${priceCols.join(', ')}`);

      // Get price statistics for first price column
      const priceStats = await query(`
        SELECT
          MIN(${priceCols[0]}) as min_price,
          MAX(${priceCols[0]}) as max_price,
          AVG(${priceCols[0]}) as avg_price
        FROM '${parquetPath}'
        WHERE ${priceCols[0]} IS NOT NULL
      `);
      console.log(`${priceCols[0]} range: ${priceStats[0].min_price} to ${priceStats[0].max_price} (avg: ${priceStats[0].avg_price?.toFixed(4)})`);
    }

    // Export sample to CSV for easy viewing
    console.log('\n=== EXPORTING SAMPLE ===');
    await query(`
      COPY (SELECT * FROM '${parquetPath}' LIMIT 100)
      TO '/tmp/pmxt_sample.csv' (HEADER, DELIMITER ',')
    `);
    console.log('✅ Saved first 100 rows to: /tmp/pmxt_sample.csv');

    console.log('\n=== ANALYSIS SUMMARY ===');
    console.log('Key findings:');
    console.log(`  - Total snapshots: ${count[0].total.toLocaleString()}`);
    console.log(`  - Unique markets/tokens: ${idCols.length > 0 ? 'See counts above' : 'Unknown'}`);
    console.log(`  - Columns: ${columns.length} (${idCols.length} ID fields, ${priceCols.length} price fields)`);
    console.log('\nNext steps:');
    console.log('  1. Review CSV: cat /tmp/pmxt_sample.csv | head -20');
    console.log('  2. Identify which columns map to: market_id, price, timestamp, volume');
    console.log('  3. Check if there\'s resolution/outcome data');

    db.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

inspect();
