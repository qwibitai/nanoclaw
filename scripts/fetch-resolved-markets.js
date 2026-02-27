#!/usr/bin/env node

/**
 * Fetch resolved Polymarket markets from Gamma API
 *
 * This creates a mapping table so we can:
 * 1. Filter pmxt.dev data to only resolved markets
 * 2. Know the actual outcomes for backtesting
 * 3. Get human-readable market questions
 */

import Database from 'better-sqlite3';
import fs from 'fs';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

async function fetchResolvedMarkets() {
  console.log('Fetching closed events from Gamma API...\n');

  // Fetch closed events (these may or may not be resolved yet)
  const response = await fetch(`${GAMMA_BASE}/events?closed=true&limit=1000`);
  const events = await response.json();

  console.log(`Found ${events.length} closed events\n`);

  const resolved = [];
  const unresolved = [];

  for (const event of events) {
    for (const market of event.markets || []) {
      if (!market.closed) continue;

      const marketData = {
        market_id: market.id || market.conditionId,
        condition_id: market.conditionId,
        question: market.question || market.title || '',
        slug: market.slug || '',
        end_date: market.endDate || market.end_date_iso,
        closed: market.closed,
        resolved: market.resolved === true,
        resolved_outcome: market.resolvedOutcome,
        volume: parseFloat(market.volume || '0'),
        liquidity: parseFloat(market.liquidity || '0'),
        tokens: extractTokenIds(market),
      };

      if (market.resolved === true && market.resolvedOutcome !== undefined) {
        resolved.push(marketData);
      } else {
        unresolved.push(marketData);
      }
    }
  }

  console.log(`✅ Resolved markets: ${resolved.length}`);
  console.log(`⏳ Closed but not resolved: ${unresolved.length}\n`);

  // Save to database
  const db = new Database('store/messages.db');

  // Create markets metadata table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_metadata (
      market_id TEXT PRIMARY KEY,
      condition_id TEXT,
      question TEXT NOT NULL,
      slug TEXT,
      end_date TEXT,
      closed BOOLEAN,
      resolved BOOLEAN,
      resolved_outcome INTEGER,
      volume REAL,
      liquidity REAL,
      token_id_yes TEXT,
      token_id_no TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO market_metadata (
      market_id, condition_id, question, slug, end_date,
      closed, resolved, resolved_outcome, volume, liquidity,
      token_id_yes, token_id_no
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((markets) => {
    for (const m of markets) {
      const yesToken = m.tokens.find(t => t.outcome === 'Yes' || t.outcome === 'YES');
      const noToken = m.tokens.find(t => t.outcome === 'No' || t.outcome === 'NO');

      insert.run(
        m.market_id,
        m.condition_id,
        m.question,
        m.slug,
        m.end_date,
        m.closed ? 1 : 0,
        m.resolved ? 1 : 0,
        m.resolved_outcome,
        m.volume,
        m.liquidity,
        yesToken?.token_id || null,
        noToken?.token_id || null,
      );
    }
  });

  insertMany([...resolved, ...unresolved]);

  console.log(`✅ Saved ${resolved.length + unresolved.length} markets to database\n`);

  // Also save resolved markets to JSON for easy access
  fs.writeFileSync(
    'resolved_markets.json',
    JSON.stringify(resolved, null, 2),
  );

  console.log(`✅ Exported resolved markets to: resolved_markets.json\n`);

  // Show sample
  console.log('=== SAMPLE RESOLVED MARKETS ===\n');
  resolved.slice(0, 5).forEach((m, i) => {
    console.log(`${i + 1}. ${m.question}`);
    console.log(`   Outcome: ${m.resolved_outcome === 1 ? 'YES' : m.resolved_outcome === 0 ? 'NO' : 'UNKNOWN'}`);
    console.log(`   Volume: $${m.volume.toLocaleString()}`);
    console.log(`   Closed: ${m.end_date}`);
    console.log(`   Tokens: YES=${m.tokens.find(t => t.outcome === 'Yes')?.token_id.substring(0, 10)}...`);
    console.log('');
  });

  // Statistics
  const yesOutcomes = resolved.filter(m => m.resolved_outcome === 1).length;
  const noOutcomes = resolved.filter(m => m.resolved_outcome === 0).length;
  const totalVolume = resolved.reduce((sum, m) => sum + m.volume, 0);

  console.log('=== STATISTICS ===');
  console.log(`Total resolved: ${resolved.length}`);
  console.log(`YES outcomes: ${yesOutcomes} (${((yesOutcomes / resolved.length) * 100).toFixed(1)}%)`);
  console.log(`NO outcomes: ${noOutcomes} (${((noOutcomes / resolved.length) * 100).toFixed(1)}%)`);
  console.log(`Total volume: $${totalVolume.toLocaleString()}`);
  console.log(`Avg volume per market: $${(totalVolume / resolved.length).toLocaleString()}`);

  db.close();
  return resolved;
}

function extractTokenIds(market) {
  try {
    const ids = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds)
      : market.clobTokenIds || [];
    const outcomes = typeof market.outcomes === 'string'
      ? JSON.parse(market.outcomes)
      : market.outcomes || ['Yes', 'No'];
    return ids.map((id, i) => ({ token_id: id, outcome: outcomes[i] || `Outcome ${i}` }));
  } catch {
    return [];
  }
}

fetchResolvedMarkets().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
