/**
 * Knowledge Store — Cross-group queryable memory using SQLite FTS5.
 *
 * Stores facts that persist across sessions and groups, enabling the agent
 * to learn and recall information over time. Uses FTS5 full-text search
 * for efficient querying.
 *
 * Future upgrade path: replace SQLite FTS5 with Mem0 + Qdrant for
 * semantic vector search.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { QDRANT_URL } from '../config.js';
import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface Fact {
  rowid: number;
  text: string;
  domain: string;
  group_id: string;
  source: string;
  created_at: string;
}

export interface StoreFactInput {
  text: string;
  domain?: string;
  groupId?: string;
  source: string;
}

export interface QueryFactsOpts {
  domain?: string;
  groupId?: string;
  limit?: number;
}

/**
 * Initialize the FTS5 knowledge_facts table.
 * Called once during DB setup. Safe to call multiple times.
 */
export function initKnowledgeStore(): void {
  const db = getDb();

  // FTS5 virtual table for full-text search.
  // content columns: text, domain, group_id, source, created_at
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_facts USING fts5(
      text, domain, group_id, source, created_at
    );
  `);
}

/**
 * Store a fact in the knowledge store.
 */
export function storeFact(fact: StoreFactInput): number {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO knowledge_facts (text, domain, group_id, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(fact.text, fact.domain || '', fact.groupId || '', fact.source, now);

  logger.debug(
    { rowid: result.lastInsertRowid, domain: fact.domain, source: fact.source },
    'Stored knowledge fact',
  );

  return Number(result.lastInsertRowid);
}

/**
 * Query facts using FTS5 full-text search.
 * Returns matching facts ranked by relevance.
 */
export function queryFacts(query: string, opts?: QueryFactsOpts): Fact[] {
  const db = getDb();
  const limit = opts?.limit ?? 10;

  // Build FTS5 match expression with optional filters
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // FTS5 match on text column
  if (query.trim()) {
    // Tokenize the query and join with OR for flexible matching
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');
    conditions.push('knowledge_facts MATCH ?');
    params.push(tokens);
  }

  if (!query.trim() && !opts?.domain && !opts?.groupId) {
    // No filters — return most recent
    const rows = db
      .prepare(
        `SELECT rowid, text, domain, group_id, source, created_at
         FROM knowledge_facts
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(limit) as Fact[];
    return rows;
  }

  if (query.trim()) {
    let sql = `SELECT rowid, text, domain, group_id, source, created_at
               FROM knowledge_facts
               WHERE knowledge_facts MATCH ?`;
    const queryParams: (string | number)[] = [
      query
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(' OR '),
    ];

    if (opts?.domain) {
      sql += ' AND domain = ?';
      queryParams.push(opts.domain);
    }
    if (opts?.groupId) {
      sql += ' AND group_id = ?';
      queryParams.push(opts.groupId);
    }

    sql += ' ORDER BY rank LIMIT ?';
    queryParams.push(limit);

    return db.prepare(sql).all(...queryParams) as Fact[];
  }

  // No text query but has domain/groupId filters
  let sql = `SELECT rowid, text, domain, group_id, source, created_at
             FROM knowledge_facts WHERE 1=1`;
  const filterParams: (string | number)[] = [];

  if (opts?.domain) {
    sql += ' AND domain = ?';
    filterParams.push(opts.domain);
  }
  if (opts?.groupId) {
    sql += ' AND group_id = ?';
    filterParams.push(opts.groupId);
  }

  sql += ' ORDER BY rowid DESC LIMIT ?';
  filterParams.push(limit);

  return db.prepare(sql).all(...filterParams) as Fact[];
}

/**
 * Delete a fact by rowid.
 */
export function deleteFact(rowid: number): boolean {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM knowledge_facts WHERE rowid = ?')
    .run(rowid);
  return result.changes > 0;
}

/**
 * Get all facts, optionally filtered by domain or group.
 */
export function getAllFacts(opts?: {
  domain?: string;
  groupId?: string;
}): Fact[] {
  const db = getDb();

  let sql = `SELECT rowid, text, domain, group_id, source, created_at
             FROM knowledge_facts WHERE 1=1`;
  const params: string[] = [];

  if (opts?.domain) {
    sql += ' AND domain = ?';
    params.push(opts.domain);
  }
  if (opts?.groupId) {
    sql += ' AND group_id = ?';
    params.push(opts.groupId);
  }

  sql += ' ORDER BY rowid DESC';

  return db.prepare(sql).all(...params) as Fact[];
}

// QDRANT_URL imported from config.ts (reads .env via readEnvFile)
const COLLECTION_NAME = 'nanoclaw_knowledge';

let qdrantClient: QdrantClient | null = null;

function getQdrant(): QdrantClient | null {
  if (!QDRANT_URL) return null;
  if (!qdrantClient) {
    qdrantClient = new QdrantClient({ url: QDRANT_URL });
  }
  return qdrantClient;
}

/**
 * Ensure the Qdrant collection exists with correct vector config.
 * No-op if QDRANT_URL is not set. Safe to call multiple times.
 */
export async function ensureQdrantCollection(): Promise<void> {
  const client = getQdrant();
  if (!client) return;

  try {
    const exists = await client.collectionExists(COLLECTION_NAME);
    if (exists.exists) return;

    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: 1536, distance: 'Cosine' },
    });
    logger.info({ collection: COLLECTION_NAME }, 'Qdrant collection created');
  } catch (err) {
    logger.warn({ err }, 'Qdrant collection init failed (non-fatal)');
  }
}

export async function storeFactWithVector(
  input: StoreFactInput,
): Promise<void> {
  storeFact(input);

  const client = getQdrant();
  if (!client) return;

  try {
    const { embedText } = await import('../llm/utility.js');
    const vector = await embedText(input.text);
    const { randomUUID } = await import('crypto');
    await client.upsert(COLLECTION_NAME, {
      points: [
        {
          id: randomUUID(),
          vector,
          payload: {
            text: input.text,
            domain: input.domain ?? 'general',
            group_id: input.groupId ?? 'global',
            source: input.source,
            created_at: new Date().toISOString(),
          },
        },
      ],
    });
  } catch (err) {
    logger.warn({ err }, 'Qdrant store failed, FTS5 fallback retained');
  }
}

export async function queryFactsSemantic(
  query: string,
  opts?: QueryFactsOpts,
): Promise<Fact[]> {
  const client = getQdrant();
  if (!client) {
    return queryFacts(query, opts);
  }

  try {
    const { embedText } = await import('../llm/utility.js');
    const vector = await embedText(query);
    const filterConditions: Array<{ key: string; match: { value: string } }> = [];
    if (opts?.domain) {
      filterConditions.push({ key: 'domain', match: { value: opts.domain } });
    }
    if (opts?.groupId) {
      filterConditions.push({ key: 'group_id', match: { value: opts.groupId } });
    }

    const results = await client.search(COLLECTION_NAME, {
      vector,
      limit: opts?.limit ?? 10,
      filter: filterConditions.length > 0
        ? { must: filterConditions }
        : undefined,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.map((r: any) => ({
      rowid: typeof r.id === 'number' ? r.id : 0,
      text: (r.payload as Record<string, string>).text,
      domain: (r.payload as Record<string, string>).domain,
      group_id: (r.payload as Record<string, string>).group_id,
      source: (r.payload as Record<string, string>).source,
      created_at: (r.payload as Record<string, string>).created_at,
    }));
  } catch (err) {
    logger.warn({ err }, 'Qdrant query failed, falling back to FTS5');
    return queryFacts(query, opts);
  }
}
