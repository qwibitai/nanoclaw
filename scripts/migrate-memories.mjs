#!/usr/bin/env node
/**
 * Migrate memories from OpenClaw JSONL backup into NanoClaw LanceDB.
 * Re-embeds all memories using OpenAI-compatible embedding endpoint.
 * Streams records in batches to avoid OOM on large backups.
 *
 * Usage: node scripts/migrate-memories.mjs <backup.jsonl> <lancedb-dir>
 *
 * Env vars:
 *   EMBEDDING_API_KEY / GEMINI_API_KEY  — API key for the embedding provider
 *   EMBEDDING_MODEL    — model name (default: gemini-embedding-001)
 *   EMBEDDING_BASE_URL — OpenAI-compatible base URL
 *   EMBEDDING_DIM      — embedding dimensions (default: 3072)
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import * as lancedb from '@lancedb/lancedb';

const API_KEY = process.env.EMBEDDING_API_KEY || process.env.GEMINI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai';

if (!API_KEY) {
  console.error('EMBEDDING_API_KEY or GEMINI_API_KEY env var required');
  process.exit(1);
}

const backupFile = process.argv[2];
const lancedbDir = process.argv[3];

if (!backupFile || !lancedbDir) {
  console.error('Usage: node scripts/migrate-memories.mjs <backup.jsonl> <lancedb-dir>');
  process.exit(1);
}

const BATCH_SIZE = 50;

async function getEmbedding(text, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        encoding_format: 'float',
      }),
    });
    if (resp.status === 429 || (resp.status >= 500 && attempt < retries)) {
      const wait = Math.pow(2, attempt + 1) * 1000;
      console.warn(`Rate limited (${resp.status}), retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Embedding failed (${resp.status}): ${err}`);
    }
    const data = await resp.json();
    return data.data[0].embedding;
  }
  throw new Error('Embedding failed after retries');
}

async function main() {
  console.log(`Reading backup from: ${backupFile}`);
  console.log(`Embedding model: ${EMBEDDING_MODEL}`);
  console.log(`Embedding endpoint: ${BASE_URL}`);

  // Safety check: --overwrite flag required if table already exists
  const overwrite = process.argv.includes('--overwrite');

  const connectOpts = lancedbDir.startsWith('db://') && process.env.LANCEDB_API_KEY
    ? { apiKey: process.env.LANCEDB_API_KEY }
    : undefined;
  const db = await lancedb.connect(lancedbDir, connectOpts);

  // Check if table already exists
  try {
    const existingTables = await db.tableNames();
    if (existingTables.includes('memories') && !overwrite) {
      console.error('Error: "memories" table already exists. Use --overwrite to replace it.');
      process.exit(1);
    }
  } catch {
    // tableNames() may fail on fresh DBs — proceed
  }

  // Stream lines to avoid loading entire file into memory
  const rl = createInterface({
    input: createReadStream(backupFile, 'utf-8'),
    crlfDelay: Infinity,
  });

  let batch = [];
  let total = 0;
  let batchNum = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      console.warn(`Skipping malformed line ${total + 1}: ${e.message}`);
      continue;
    }
    console.log(`[${total}] Embedding: ${entry.text.slice(0, 60)}...`);

    const vector = await getEmbedding(entry.text);

    batch.push({
      id: entry.id,
      text: entry.text,
      category: entry.category || 'general',
      importance: entry.importance || 0.7,
      timestamp: entry.timestamp || Date.now(),
      metadata: typeof entry.metadata === 'string' ? entry.metadata : JSON.stringify(entry.metadata || {}),
      scope: entry.scope || 'global',
      vector: Array.from(vector),
    });

    // Flush batch to LanceDB periodically to limit memory usage
    if (batch.length >= BATCH_SIZE) {
      batchNum++;
      if (batchNum === 1) {
        await db.createTable('memories', batch, { mode: 'overwrite' });
      } else {
        const table = await db.openTable('memories');
        await table.add(batch);
      }
      console.log(`  Flushed batch ${batchNum} (${batch.length} records)`);
      batch = [];
    }

    // Rate limit: ~5 req/sec
    await new Promise(r => setTimeout(r, 200));
  }

  // Flush remaining records
  if (batch.length > 0) {
    batchNum++;
    if (batchNum === 1) {
      await db.createTable('memories', batch, { mode: 'overwrite' });
    } else {
      const table = await db.openTable('memories');
      await table.add(batch);
    }
    console.log(`  Flushed final batch (${batch.length} records)`);
  }

  console.log(`Migration complete! ${total} memories migrated.`);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
