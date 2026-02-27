#!/usr/bin/env node

/**
 * Parse pmxt.dev Parquet data with JSON extraction
 */

import duckdb from 'duckdb';

const parquetPath = process.argv[2] || '/tmp/sample.parquet';

console.log(`\n=== PARSING JSON DATA FROM: ${parquetPath} ===\n`);

const db = new duckdb.Database(':memory:');

function query(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function parseData() {
  try {
    // Parse JSON and extract key fields
    console.log('=== EXTRACTING PRICE DATA FROM JSON ===');

    const parsed = await query(`
      SELECT
        timestamp_received,
        market_id,
        update_type,
        json_extract_string(data, '$.token_id') as token_id,
        json_extract_string(data, '$.side') as side,
        CAST(json_extract_string(data, '$.best_bid') AS DOUBLE) as best_bid,
        CAST(json_extract_string(data, '$.best_ask') AS DOUBLE) as best_ask,
        json_extract_string(data, '$.change_price') as change_price,
        json_extract_string(data, '$.change_size') as change_size
      FROM '${parquetPath}'
      LIMIT 10
    `);

    console.log('Sample parsed data:');
    console.log(JSON.stringify(parsed, null, 2));

    // Get unique markets count
    console.log('\n=== MARKET STATISTICS ===');
    const stats = await query(`
      SELECT
        COUNT(DISTINCT market_id) as unique_markets,
        COUNT(DISTINCT json_extract_string(data, '$.token_id')) as unique_tokens,
        COUNT(*) as total_updates
      FROM '${parquetPath}'
    `);

    console.log(`Unique markets: ${stats[0].unique_markets.toLocaleString()}`);
    console.log(`Unique tokens: ${stats[0].unique_tokens.toLocaleString()}`);
    console.log(`Total price updates: ${stats[0].total_updates.toLocaleString()}`);

    // Calculate mid-price and create structured data
    console.log('\n=== CREATING STRUCTURED PRICE DATA ===');
    await query(`
      CREATE TABLE price_data AS
      SELECT
        timestamp_received as timestamp,
        market_id,
        json_extract_string(data, '$.token_id') as token_id,
        json_extract_string(data, '$.side') as side,
        CAST(json_extract_string(data, '$.best_bid') AS DOUBLE) as best_bid,
        CAST(json_extract_string(data, '$.best_ask') AS DOUBLE) as best_ask,
        (CAST(json_extract_string(data, '$.best_bid') AS DOUBLE) +
         CAST(json_extract_string(data, '$.best_ask') AS DOUBLE)) / 2.0 as mid_price
      FROM '${parquetPath}'
      WHERE json_extract_string(data, '$.best_bid') IS NOT NULL
        AND json_extract_string(data, '$.best_ask') IS NOT NULL
    `);

    const sample = await query('SELECT * FROM price_data LIMIT 5');
    console.log('Structured data sample:');
    console.log(JSON.stringify(sample, null, 2));

    // Export to CSV for import into SQLite
    console.log('\n=== EXPORTING TO CSV ===');
    await query(`
      COPY (
        SELECT
          'polymarket' as platform,
          token_id as symbol,
          timestamp,
          mid_price as price,
          NULL as volume,
          NULL as open_interest,
          json_object('market_id', market_id, 'side', side, 'best_bid', best_bid, 'best_ask', best_ask) as metadata
        FROM price_data
        LIMIT 10000
      ) TO '/tmp/polymarket_import.csv' (HEADER, DELIMITER ',')
    `);

    console.log('✅ Exported first 10,000 rows to: /tmp/polymarket_import.csv');
    console.log('\nThis file is ready to import into SQLite market_data table.');

    // Show price range for a specific token
    const priceRange = await query(`
      SELECT
        token_id,
        MIN(mid_price) as min_price,
        MAX(mid_price) as max_price,
        AVG(mid_price) as avg_price,
        COUNT(*) as update_count
      FROM price_data
      GROUP BY token_id
      ORDER BY update_count DESC
      LIMIT 5
    `);

    console.log('\n=== TOP 5 MOST ACTIVE TOKENS ===');
    priceRange.forEach((row, i) => {
      console.log(`\n${i + 1}. Token: ${row.token_id.substring(0, 20)}...`);
      console.log(`   Price range: ${row.min_price} - ${row.max_price} (avg: ${row.avg_price.toFixed(4)})`);
      console.log(`   Updates: ${row.update_count.toLocaleString()}`);
    });

    db.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

parseData();
