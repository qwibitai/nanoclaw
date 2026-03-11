/**
 * Semantic memory powered by LanceDB + Gemini embeddings.
 * Supports local (default) or cloud via LANCEDB_URI + LANCEDB_API_KEY.
 */

import * as lancedb from '@lancedb/lancedb';
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Schema,
  Utf8,
} from 'apache-arrow';
import { randomUUID } from 'crypto';

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '3072', 10);
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Cloud: LANCEDB_URI=db://my-db + LANCEDB_API_KEY
// Local: falls back to /workspace/group/memory/lancedb
const LANCEDB_URI = process.env.LANCEDB_URI || '';
const LANCEDB_API_KEY = process.env.LANCEDB_API_KEY || '';

let db: lancedb.Connection | null = null;
let tablePromise: Promise<lancedb.Table> | null = null;

async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const resp = await fetch(
    `${GEMINI_BASE_URL}/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini embedding failed (${resp.status})`);
  }

  const data = (await resp.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

const MEMORIES_SCHEMA = new Schema([
  new Field('id', new Utf8()),
  new Field('text', new Utf8()),
  new Field('category', new Utf8()),
  new Field('importance', new Float64()),
  new Field('timestamp', new Float64()),
  new Field('metadata', new Utf8()),
  new Field(
    'vector',
    new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32())),
  ),
]);

async function initTable(): Promise<lancedb.Table> {
  if (LANCEDB_URI) {
    db = await lancedb.connect(LANCEDB_URI, {
      apiKey: LANCEDB_API_KEY || undefined,
    });
  } else {
    db = await lancedb.connect('/workspace/group/memory/lancedb');
  }

  const tableNames = await db.tableNames();
  if (tableNames.includes('memories')) {
    return await db.openTable('memories');
  } else {
    return await db.createEmptyTable('memories', MEMORIES_SCHEMA);
  }
}

function getTable(): Promise<lancedb.Table> {
  if (!tablePromise) {
    tablePromise = initTable().catch((err) => {
      tablePromise = null;
      throw err;
    });
  }
  return tablePromise;
}

export async function memoryStore(
  text: string,
  category: string = 'general',
  importance: number = 0.7,
  meta: Record<string, unknown> = {},
): Promise<string> {
  const tbl = await getTable();
  const vector = await getEmbedding(text);
  const id = `mem-${randomUUID()}`;

  await tbl.add([
    {
      id,
      text,
      category,
      importance,
      timestamp: Date.now(),
      metadata: JSON.stringify(meta),
      vector,
    },
  ]);

  return id;
}

export async function memorySearch(
  query: string,
  limit: number = 5,
  category?: string,
): Promise<
  Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    timestamp: number;
    metadata: string;
    _distance: number;
  }>
> {
  const tbl = await getTable();
  const vector = await getEmbedding(query);

  let search = tbl.search(vector).limit(limit);
  if (category) {
    const safe = category.replace(/[^a-z_]/gi, '');
    search = search.where(`category = '${safe}'`);
  }

  const results = await search.toArray();
  return results.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    text: r.text as string,
    category: r.category as string,
    importance: r.importance as number,
    timestamp: r.timestamp as number,
    metadata: r.metadata as string,
    _distance: r._distance as number,
  }));
}

export async function memoryDelete(id: string): Promise<void> {
  const tbl = await getTable();
  const safe = id.replace(/[^a-z0-9_-]/gi, '');
  await tbl.delete(`id = "${safe}"`);
}

export async function memoryCount(): Promise<number> {
  const tbl = await getTable();
  return await tbl.countRows();
}
