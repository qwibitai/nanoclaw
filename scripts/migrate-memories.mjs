#!/usr/bin/env node
/**
 * Migrate memories from OpenClaw JSONL backup into NanoClaw LanceDB.
 * Re-embeds all memories using Gemini embedding model.
 *
 * Usage: node scripts/migrate-memories.mjs <backup.jsonl> <lancedb-dir>
 */

import fs from 'fs';
import * as lancedb from '@lancedb/lancedb';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIM = 3072;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY env var required');
  process.exit(1);
}

const backupFile = process.argv[2] || '/root/.openclaw/memory/backups/memory-backup-2026-03-11.jsonl';
const lancedbDir = process.argv[3] || './groups/telegram_main/memory/lancedb';

async function getEmbedding(text) {
  const resp = await fetch(
    `${GEMINI_BASE_URL}/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      }),
    },
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini embedding failed (${resp.status}): ${err}`);
  }
  const data = await resp.json();
  return data.embedding.values;
}

async function main() {
  console.log(`Reading backup from: ${backupFile}`);
  const lines = fs.readFileSync(backupFile, 'utf-8').trim().split('\n');
  console.log(`Found ${lines.length} memories to migrate`);

  const db = await lancedb.connect(lancedbDir);

  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]);
    console.log(`[${i + 1}/${lines.length}] Embedding: ${entry.text.slice(0, 60)}...`);

    const vector = await getEmbedding(entry.text);

    records.push({
      id: entry.id,
      text: entry.text,
      category: entry.category || 'general',
      importance: entry.importance || 0.7,
      timestamp: entry.timestamp || Date.now(),
      metadata: typeof entry.metadata === 'string' ? entry.metadata : JSON.stringify(entry.metadata || {}),
      vector: new Float32Array(vector),
    });

    // Rate limit: ~1 req/sec to be safe
    if (i < lines.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`Creating LanceDB table with ${records.length} records...`);
  await db.createTable('memories', records, { mode: 'overwrite' });
  console.log('Migration complete!');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
