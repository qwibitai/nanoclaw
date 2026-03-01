/**
 * Memory System for NanoClaw
 *
 * Three-layer memory architecture:
 * 1. Core Memories — discrete facts, preferences, instructions (always injected)
 * 2. Conversation Memory — embedded message chunks for RAG retrieval
 * 3. Archival Memory — session summaries for deep recall
 *
 * Uses sqlite-vec for vector search and @huggingface/transformers for local embeddings.
 * All operations are per-group isolated.
 */

import crypto from 'crypto';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getDb } from './db.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

// --- Types ---

export interface CoreMemory {
  id: string;
  group_folder: string;
  category: string;
  content: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  is_pinned: number;
}

export interface ConversationChunk {
  id: string;
  group_folder: string;
  chat_jid: string;
  message_id: string | null;
  content: string;
  context: string | null;
  sender_name: string | null;
  timestamp: string;
  created_at: string;
}

export interface ArchivalMemory {
  id: string;
  group_folder: string;
  session_id: string | null;
  title: string | null;
  content: string;
  timestamp: string;
  message_count: number | null;
  created_at: string;
}

// --- Schema ---

export function initMemorySchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS core_memories (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_pinned INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_core_memories_group ON core_memories(group_folder);
    CREATE INDEX IF NOT EXISTS idx_core_memories_category ON core_memories(group_folder, category);

    CREATE TABLE IF NOT EXISTS conversation_chunks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      message_id TEXT,
      content TEXT NOT NULL,
      context TEXT,
      sender_name TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_chunks_group ON conversation_chunks(group_folder);
    CREATE INDEX IF NOT EXISTS idx_conv_chunks_ts ON conversation_chunks(group_folder, timestamp);

    CREATE TABLE IF NOT EXISTS archival_memories (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      session_id TEXT,
      title TEXT,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      message_count INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archival_group ON archival_memories(group_folder);
  `);

  // Create vec0 virtual tables (idempotent — errors if already exists)
  const vecTables = [
    `CREATE VIRTUAL TABLE IF NOT EXISTS core_memories_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding float[384])`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS conversation_chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[384])`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS archival_memories_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding float[384])`,
  ];

  for (const sql of vecTables) {
    try {
      db.exec(sql);
    } catch (err) {
      // vec0 tables don't support IF NOT EXISTS in all versions — ignore if exists
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already exists')) throw err;
    }
  }

  logger.info('Memory schema initialized');
}

// --- Embedding Pipeline ---

let embedder: unknown = null;

async function getEmbedder(): Promise<
  (
    text: string,
    opts: { pooling: string; normalize: boolean },
  ) => Promise<{ data: Float32Array }>
> {
  if (!embedder) {
    const { pipeline } = await import('@huggingface/transformers');
    const cacheDir = path.join(DATA_DIR, 'models');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      cache_dir: cacheDir,
    });
    logger.info({ cacheDir }, 'Embedding model loaded');
  }
  return embedder as (
    text: string,
    opts: { pooling: string; normalize: boolean },
  ) => Promise<{ data: Float32Array }>;
}

export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

function uid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// --- Layer 1: Core Memory CRUD ---

export function addCoreMemory(
  groupFolder: string,
  category: string,
  content: string,
  metadata?: Record<string, unknown>,
): string {
  const db = getDb();
  const id = uid();
  const ts = now();
  db.prepare(
    `INSERT INTO core_memories (id, group_folder, category, content, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupFolder,
    category,
    content,
    metadata ? JSON.stringify(metadata) : null,
    ts,
    ts,
  );
  return id;
}

export async function addCoreMemoryWithEmbedding(
  groupFolder: string,
  category: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const id = addCoreMemory(groupFolder, category, content, metadata);
  try {
    const vec = await embed(content);
    getDb()
      .prepare(
        `INSERT INTO core_memories_vec (memory_id, embedding) VALUES (?, ?)`,
      )
      .run(id, Buffer.from(vec.buffer));
  } catch (err) {
    logger.warn({ err, id }, 'Failed to embed core memory');
  }
  return id;
}

export function updateCoreMemory(id: string, content: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE core_memories SET content = ?, updated_at = ? WHERE id = ?`,
  ).run(content, now(), id);
}

export async function updateCoreMemoryWithEmbedding(
  id: string,
  content: string,
): Promise<void> {
  updateCoreMemory(id, content);
  try {
    const vec = await embed(content);
    const db = getDb();
    // Delete old embedding and insert new one
    db.prepare(`DELETE FROM core_memories_vec WHERE memory_id = ?`).run(id);
    db.prepare(
      `INSERT INTO core_memories_vec (memory_id, embedding) VALUES (?, ?)`,
    ).run(id, Buffer.from(vec.buffer));
  } catch (err) {
    logger.warn({ err, id }, 'Failed to re-embed core memory');
  }
}

export function removeCoreMemory(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM core_memories WHERE id = ?`).run(id);
  try {
    db.prepare(`DELETE FROM core_memories_vec WHERE memory_id = ?`).run(id);
  } catch {
    /* vec entry may not exist */
  }
}

export function getCoreMemories(
  groupFolder: string,
  category?: string,
): CoreMemory[] {
  const db = getDb();
  if (category) {
    return db
      .prepare(
        `SELECT * FROM core_memories WHERE group_folder = ? AND category = ? ORDER BY updated_at DESC`,
      )
      .all(groupFolder, category) as CoreMemory[];
  }
  return db
    .prepare(
      `SELECT * FROM core_memories WHERE group_folder = ? ORDER BY updated_at DESC`,
    )
    .all(groupFolder) as CoreMemory[];
}

export function getPinnedMemories(groupFolder: string): CoreMemory[] {
  return getDb()
    .prepare(
      `SELECT * FROM core_memories WHERE group_folder = ? AND is_pinned = 1 ORDER BY updated_at DESC`,
    )
    .all(groupFolder) as CoreMemory[];
}

export async function searchCoreMemories(
  groupFolder: string,
  query: string,
  limit = 10,
): Promise<CoreMemory[]> {
  const vec = await embed(query);
  const db = getDb();

  // Vector search returns memory_ids ranked by similarity
  const vecResults = db
    .prepare(
      `SELECT memory_id, distance
       FROM core_memories_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(Buffer.from(vec.buffer), limit * 2) as Array<{
    memory_id: string;
    distance: number;
  }>;

  if (vecResults.length === 0) return [];

  // Filter to this group's memories and fetch full records
  const ids = vecResults.map((r) => r.memory_id);
  const placeholders = ids.map(() => '?').join(',');
  const memories = db
    .prepare(
      `SELECT * FROM core_memories WHERE id IN (${placeholders}) AND group_folder = ?`,
    )
    .all(...ids, groupFolder) as CoreMemory[];

  // Preserve similarity order
  const memoryMap = new Map(memories.map((m) => [m.id, m]));
  return vecResults
    .map((r) => memoryMap.get(r.memory_id))
    .filter((m): m is CoreMemory => m !== undefined)
    .slice(0, limit);
}

// --- Layer 2: Conversation Memory ---

export async function embedMessage(
  groupFolder: string,
  chatJid: string,
  message: NewMessage,
  contextMessages: NewMessage[],
): Promise<void> {
  const db = getDb();
  const id = uid();
  const ts = now();

  // Build context string (preceding messages for embedding context)
  const contextParts = contextMessages.map(
    (m) => `${m.sender_name}: ${m.content}`,
  );
  const embeddingText =
    contextParts.length > 0
      ? `${contextParts.join('\n')}\n${message.sender_name}: ${message.content}`
      : `${message.sender_name}: ${message.content}`;

  const contextStr = contextParts.length > 0 ? contextParts.join('\n') : null;

  db.prepare(
    `INSERT INTO conversation_chunks (id, group_folder, chat_jid, message_id, content, context, sender_name, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupFolder,
    chatJid,
    message.id,
    message.content,
    contextStr,
    message.sender_name,
    message.timestamp,
    ts,
  );

  const vec = await embed(embeddingText);
  db.prepare(
    `INSERT INTO conversation_chunks_vec (chunk_id, embedding) VALUES (?, ?)`,
  ).run(id, Buffer.from(vec.buffer));
}

export async function embedConversationMessages(
  groupFolder: string,
  chatJid: string,
  messages: NewMessage[],
): Promise<void> {
  for (let i = 0; i < messages.length; i++) {
    // Use up to 2 preceding messages as context
    const contextStart = Math.max(0, i - 2);
    const contextMessages = messages.slice(contextStart, i);
    try {
      await embedMessage(groupFolder, chatJid, messages[i], contextMessages);
    } catch (err) {
      logger.warn(
        { err, messageId: messages[i].id },
        'Failed to embed message',
      );
    }
  }
}

export async function retrieveRelevantChunks(
  groupFolder: string,
  query: string,
  limit = 10,
): Promise<ConversationChunk[]> {
  const vec = await embed(query);
  const db = getDb();

  const vecResults = db
    .prepare(
      `SELECT chunk_id, distance
       FROM conversation_chunks_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(Buffer.from(vec.buffer), limit * 2) as Array<{
    chunk_id: string;
    distance: number;
  }>;

  if (vecResults.length === 0) return [];

  const ids = vecResults.map((r) => r.chunk_id);
  const placeholders = ids.map(() => '?').join(',');
  const chunks = db
    .prepare(
      `SELECT * FROM conversation_chunks WHERE id IN (${placeholders}) AND group_folder = ?`,
    )
    .all(...ids, groupFolder) as ConversationChunk[];

  const chunkMap = new Map(chunks.map((c) => [c.id, c]));
  return vecResults
    .map((r) => chunkMap.get(r.chunk_id))
    .filter((c): c is ConversationChunk => c !== undefined)
    .slice(0, limit);
}

// --- Layer 3: Archival Memory ---

export async function archiveSession(
  groupFolder: string,
  sessionId: string | null,
  title: string | null,
  content: string,
  messageCount?: number,
): Promise<string> {
  const db = getDb();
  const id = uid();
  const ts = now();

  db.prepare(
    `INSERT INTO archival_memories (id, group_folder, session_id, title, content, timestamp, message_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupFolder,
    sessionId,
    title,
    content,
    ts,
    messageCount ?? null,
    ts,
  );

  try {
    const vec = await embed(content.slice(0, 1000)); // Embed first 1000 chars of summary
    db.prepare(
      `INSERT INTO archival_memories_vec (memory_id, embedding) VALUES (?, ?)`,
    ).run(id, Buffer.from(vec.buffer));
  } catch (err) {
    logger.warn({ err, id }, 'Failed to embed archival memory');
  }

  return id;
}

export async function searchArchive(
  groupFolder: string,
  query: string,
  limit = 5,
): Promise<ArchivalMemory[]> {
  const vec = await embed(query);
  const db = getDb();

  const vecResults = db
    .prepare(
      `SELECT memory_id, distance
       FROM archival_memories_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(Buffer.from(vec.buffer), limit * 2) as Array<{
    memory_id: string;
    distance: number;
  }>;

  if (vecResults.length === 0) return [];

  const ids = vecResults.map((r) => r.memory_id);
  const placeholders = ids.map(() => '?').join(',');
  const memories = db
    .prepare(
      `SELECT * FROM archival_memories WHERE id IN (${placeholders}) AND group_folder = ?`,
    )
    .all(...ids, groupFolder) as ArchivalMemory[];

  const memoryMap = new Map(memories.map((m) => [m.id, m]));
  return vecResults
    .map((r) => memoryMap.get(r.memory_id))
    .filter((m): m is ArchivalMemory => m !== undefined)
    .slice(0, limit);
}

// --- Memory Context Retrieval ---

/**
 * Retrieve relevant memory context for injection into the agent prompt.
 * Called before each agent invocation.
 */
export async function retrieveMemoryContext(
  groupFolder: string,
  messages: NewMessage[],
): Promise<string> {
  // Build query from incoming messages
  const queryText = messages
    .map((m) => m.content)
    .join(' ')
    .slice(0, 500);

  if (!queryText.trim()) return '';

  const parts: string[] = [];

  try {
    // Layer 1: Core memories (pinned + relevant)
    const pinned = getPinnedMemories(groupFolder);
    const allCore = getCoreMemories(groupFolder);

    // If we have vectors, do semantic search; otherwise use all memories
    let relevantCore: CoreMemory[] = [];
    try {
      relevantCore = await searchCoreMemories(groupFolder, queryText, 10);
    } catch {
      // Vector table might be empty
      relevantCore = allCore.slice(0, 10);
    }

    // Merge pinned + relevant (deduplicated)
    const seenIds = new Set<string>();
    const coreMemories: CoreMemory[] = [];
    for (const m of [...pinned, ...relevantCore]) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        coreMemories.push(m);
      }
    }

    if (coreMemories.length > 0) {
      parts.push('<memory type="core">');
      for (const mem of coreMemories) {
        parts.push(
          `<fact category="${mem.category}" id="${mem.id}"${mem.is_pinned ? ' pinned="true"' : ''}>${mem.content}</fact>`,
        );
      }
      parts.push('</memory>');
    }

    // Layer 2: Relevant conversation chunks
    let relevantChunks: ConversationChunk[] = [];
    try {
      relevantChunks = await retrieveRelevantChunks(groupFolder, queryText, 8);
    } catch {
      // Vector table might be empty
    }

    if (relevantChunks.length > 0) {
      parts.push('<memory type="past_conversations">');
      for (const chunk of relevantChunks) {
        parts.push(
          `<past_message sender="${chunk.sender_name || 'Unknown'}" time="${chunk.timestamp}">${chunk.content}</past_message>`,
        );
      }
      parts.push('</memory>');
    }
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Failed to retrieve memory context');
  }

  return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
}

/**
 * Build memory snapshot for the agent (written to IPC dir).
 * Agent uses this to see existing memory IDs for update/remove operations.
 */
export function buildMemorySnapshot(groupFolder: string): {
  coreMemories: Array<{
    id: string;
    category: string;
    content: string;
    is_pinned: boolean;
    updated_at: string;
  }>;
} {
  const memories = getCoreMemories(groupFolder);
  return {
    coreMemories: memories.map((m) => ({
      id: m.id,
      category: m.category,
      content: m.content,
      is_pinned: m.is_pinned === 1,
      updated_at: m.updated_at,
    })),
  };
}

/**
 * Combined search across all memory layers.
 * Used by the agent's memory_search MCP tool.
 */
export async function searchAllMemory(
  groupFolder: string,
  query: string,
  scope: 'all' | 'conversations' | 'facts' = 'all',
  limit = 10,
): Promise<string> {
  const results: string[] = [];

  if (scope === 'all' || scope === 'facts') {
    try {
      const coreResults = await searchCoreMemories(groupFolder, query, limit);
      if (coreResults.length > 0) {
        results.push('## Stored Facts');
        for (const m of coreResults) {
          results.push(`- [${m.category}] ${m.content} (id: ${m.id})`);
        }
      }
    } catch {
      /* empty */
    }
  }

  if (scope === 'all' || scope === 'conversations') {
    try {
      const convResults = await retrieveRelevantChunks(
        groupFolder,
        query,
        limit,
      );
      if (convResults.length > 0) {
        results.push('## Past Conversations');
        for (const c of convResults) {
          results.push(`- [${c.timestamp}] ${c.sender_name}: ${c.content}`);
        }
      }
    } catch {
      /* empty */
    }

    try {
      const archiveResults = await searchArchive(groupFolder, query, 3);
      if (archiveResults.length > 0) {
        results.push('## Session Archives');
        for (const a of archiveResults) {
          results.push(
            `- [${a.timestamp}] ${a.title || 'Untitled session'}: ${a.content.slice(0, 200)}...`,
          );
        }
      }
    } catch {
      /* empty */
    }
  }

  return results.length > 0
    ? results.join('\n')
    : 'No relevant memories found.';
}
