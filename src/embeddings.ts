import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const EMBEDDING_MODEL = 'hf:nomic-ai/nomic-embed-text-v1.5';
const EMBEDDING_DIM = 768;
const EMBEDDING_API_URL = 'https://api.synthetic.new/openai/v1/embeddings';

let embeddingDb: Database.Database;

function getApiKey(): string {
  const env = readEnvFile(['SYNTHETIC_API_KEY']);
  return process.env.SYNTHETIC_API_KEY || env.SYNTHETIC_API_KEY || '';
}

export function initEmbeddingDb(): void {
  const dbPath = path.join(STORE_DIR, 'embeddings.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  embeddingDb = new Database(dbPath);
  embeddingDb.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender_name TEXT,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emb_chat ON embeddings(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_emb_ts ON embeddings(timestamp);
  `);
}

/** @internal - for tests */
export function _initTestEmbeddingDb(): void {
  embeddingDb = new Database(':memory:');
  embeddingDb.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender_name TEXT,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
  `);
}

async function fetchEmbedding(text: string): Promise<Float32Array | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('SYNTHETIC_API_KEY not set, skipping embedding');
    return null;
  }

  try {
    const res = await fetch(EMBEDDING_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
      }),
    });

    if (!res.ok) {
      logger.error({ status: res.status }, 'Embedding API error');
      return null;
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return new Float32Array(json.data[0].embedding);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch embedding');
    return null;
  }
}

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(ab);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function embedMessage(
  id: string,
  chatJid: string,
  senderName: string,
  content: string,
  timestamp: string,
): Promise<void> {
  // Skip very short messages
  if (content.length < 5) return;

  // Skip if already embedded
  const existing = embeddingDb
    .prepare('SELECT 1 FROM embeddings WHERE id = ?')
    .get(id);
  if (existing) return;

  const embedding = await fetchEmbedding(content);
  if (!embedding) return;

  embeddingDb
    .prepare(
      'INSERT OR IGNORE INTO embeddings (id, chat_jid, sender_name, content, timestamp, embedding) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      chatJid,
      senderName,
      content,
      timestamp,
      float32ToBuffer(embedding),
    );

  logger.debug({ id, chatJid }, 'Message embedded');
}

export interface SearchResult {
  content: string;
  senderName: string;
  timestamp: string;
  chatJid: string;
  score: number;
}

export async function searchMemory(
  query: string,
  limit = 10,
  chatJid?: string,
): Promise<SearchResult[]> {
  const queryEmbedding = await fetchEmbedding(query);
  if (!queryEmbedding) return [];

  // Get all embeddings (or filtered by chatJid)
  const rows = chatJid
    ? (embeddingDb
        .prepare(
          'SELECT content, sender_name, timestamp, chat_jid, embedding FROM embeddings WHERE chat_jid = ? ORDER BY timestamp DESC',
        )
        .all(chatJid) as Array<{
        content: string;
        sender_name: string;
        timestamp: string;
        chat_jid: string;
        embedding: Buffer;
      }>)
    : (embeddingDb
        .prepare(
          'SELECT content, sender_name, timestamp, chat_jid, embedding FROM embeddings ORDER BY timestamp DESC',
        )
        .all() as Array<{
        content: string;
        sender_name: string;
        timestamp: string;
        chat_jid: string;
        embedding: Buffer;
      }>);

  // Compute similarities
  const scored = rows.map((row) => ({
    content: row.content,
    senderName: row.sender_name,
    timestamp: row.timestamp,
    chatJid: row.chat_jid,
    score: cosineSimilarity(queryEmbedding, bufferToFloat32(row.embedding)),
  }));

  // Sort by similarity descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

export function getEmbeddingCount(): number {
  const row = embeddingDb
    .prepare('SELECT COUNT(*) as count FROM embeddings')
    .get() as { count: number };
  return row.count;
}
