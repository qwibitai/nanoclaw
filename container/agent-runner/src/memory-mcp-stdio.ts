/**
 * Stdio MCP Server for Memory
 *
 * Persistent, queryable local knowledge base stored in SQLite. Reduces
 * per-message token cost by letting the agent look up environment facts
 * on demand instead of injecting them into every system prompt.
 *
 * Storage: one SQLite file per group, mounted in via /workspace/group
 * (NanoClaw's native per-group isolation primitive). Every row is also
 * tagged with group_folder and all queries filter on it — defense in
 * depth, and it keeps the schema portable if the DB is ever pointed at
 * a shared mount.
 *
 * Env:
 *   MEMORY_DB_PATH         path to SQLite db file (default:
 *                          /workspace/group/memory.db)
 *   NANOCLAW_GROUP_FOLDER  group scope for all reads/writes (required
 *                          when starting the MCP server; tests inject
 *                          their own value via the MemoryStore constructor)
 *
 * Uses better-sqlite3 for native speed and prebuilt binaries on
 * node:22-slim linux-x64/arm64 (no build toolchain needed in the image).
 * FTS5 is compiled into the bundled SQLite.
 */

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// --- Validation ---

const KEY_RE = /^[\w.\-:]{1,128}$/;
const GROUP_RE = /^[\w.\-]{1,128}$/;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_TAGS_CHARS = 512;
const MAX_SOURCE_CHARS = 128;

export class ValidationError extends Error {}

function validateKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new ValidationError(
      'key must match /^[\\w.\\-:]{1,128}$/ (letters, digits, _, ., -, :, 1-128 chars)',
    );
  }
  return key;
}

function validateValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('value must be a string');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new ValidationError(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  }
  return value;
}

function validateTags(tags: unknown): string | null {
  if (tags === undefined || tags === null || tags === '') return null;
  if (typeof tags !== 'string') {
    throw new ValidationError('tags must be a string');
  }
  if (tags.length > MAX_TAGS_CHARS) {
    throw new ValidationError(`tags exceeds ${MAX_TAGS_CHARS} chars`);
  }
  return tags;
}

function validateSource(source: unknown): string | null {
  if (source === undefined || source === null || source === '') return null;
  if (typeof source !== 'string') {
    throw new ValidationError('source must be a string');
  }
  if (source.length > MAX_SOURCE_CHARS) {
    throw new ValidationError(`source exceeds ${MAX_SOURCE_CHARS} chars`);
  }
  return source;
}

function validateGroupFolder(group: unknown): string {
  if (typeof group !== 'string' || !GROUP_RE.test(group)) {
    throw new ValidationError(
      'group_folder must match /^[\\w.\\-]{1,128}$/ (letters, digits, _, ., -, 1-128 chars)',
    );
  }
  return group;
}

// --- Schema ---

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  tags         TEXT,
  source       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(group_folder, key)
);

CREATE INDEX IF NOT EXISTS idx_memories_group ON memories(group_folder);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  key, value, tags,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, key, value, tags)
  VALUES (new.id, new.key, new.value, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, key, value, tags)
  VALUES ('delete', old.id, old.key, old.value, old.tags);
  INSERT INTO memories_fts(rowid, key, value, tags)
  VALUES (new.id, new.key, new.value, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, key, value, tags)
  VALUES ('delete', old.id, old.key, old.value, old.tags);
END;
`;

// --- Store ---

export interface MemoryRecord {
  id: number;
  group_folder: string;
  key: string;
  value: string;
  tags: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface WriteArgs {
  key: string;
  value: string;
  tags?: string;
  source?: string;
}

export interface ListArgs {
  tag?: string;
  limit?: number;
}

export interface SearchArgs {
  query: string;
  limit?: number;
}

export interface WriteResult {
  key: string;
  action: 'inserted' | 'updated';
}

export class MemoryStore {
  private db: DatabaseType;
  private groupFolder: string;

  constructor(dbPath: string, groupFolder: string) {
    this.groupFolder = validateGroupFolder(groupFolder);
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  write(args: WriteArgs): WriteResult {
    const key = validateKey(args.key);
    const value = validateValue(args.value);
    const tags = validateTags(args.tags);
    const source = validateSource(args.source);

    const existing = this.db
      .prepare(
        'SELECT id FROM memories WHERE group_folder = ? AND key = ?',
      )
      .get(this.groupFolder, key);

    if (existing) {
      this.db
        .prepare(
          `UPDATE memories
             SET value = ?, tags = ?, source = ?, updated_at = datetime('now')
             WHERE group_folder = ? AND key = ?`,
        )
        .run(value, tags, source, this.groupFolder, key);
      return { key, action: 'updated' };
    }

    this.db
      .prepare(
        `INSERT INTO memories (group_folder, key, value, tags, source)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(this.groupFolder, key, value, tags, source);
    return { key, action: 'inserted' };
  }

  read(key: string): MemoryRecord | null {
    validateKey(key);
    const row = this.db
      .prepare(
        'SELECT * FROM memories WHERE group_folder = ? AND key = ?',
      )
      .get(this.groupFolder, key) as MemoryRecord | undefined;
    return row ?? null;
  }

  delete(key: string): boolean {
    validateKey(key);
    const res = this.db
      .prepare(
        'DELETE FROM memories WHERE group_folder = ? AND key = ?',
      )
      .run(this.groupFolder, key);
    return res.changes > 0;
  }

  search(args: SearchArgs): MemoryRecord[] {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
      throw new ValidationError('query must be a non-empty string');
    }
    const limit = clampLimit(args.limit, 10, 50);
    const rows = this.db
      .prepare(
        `SELECT m.*
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.rowid
          WHERE memories_fts MATCH ?
            AND m.group_folder = ?
          ORDER BY bm25(memories_fts)
          LIMIT ?`,
      )
      .all(args.query, this.groupFolder, limit) as MemoryRecord[];
    return rows;
  }

  list(
    args: ListArgs,
  ): Array<Pick<MemoryRecord, 'key' | 'tags' | 'updated_at'>> {
    const limit = clampLimit(args.limit, 50, 200);
    if (args.tag !== undefined && args.tag !== null && args.tag !== '') {
      if (typeof args.tag !== 'string' || args.tag.length > 64) {
        throw new ValidationError('tag must be a string up to 64 chars');
      }
      // Whole-token match inside comma-separated tags column.
      const rows = this.db
        .prepare(
          `SELECT key, tags, updated_at
             FROM memories
            WHERE group_folder = ?
              AND (',' || replace(tags, ' ', '') || ',') LIKE ?
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(this.groupFolder, `%,${args.tag},%`, limit) as Array<
        Pick<MemoryRecord, 'key' | 'tags' | 'updated_at'>
      >;
      return rows;
    }
    const rows = this.db
      .prepare(
        `SELECT key, tags, updated_at
           FROM memories
          WHERE group_folder = ?
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(this.groupFolder, limit) as Array<
      Pick<MemoryRecord, 'key' | 'tags' | 'updated_at'>
    >;
    return rows;
  }
}

function clampLimit(
  raw: number | undefined,
  def: number,
  max: number,
): number {
  if (raw === undefined || raw === null) return def;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// --- MCP glue ---

function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

function resolveDbPath(): string {
  const fromEnv = process.env.MEMORY_DB_PATH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return '/workspace/group/memory.db';
}

export function registerMemoryTools(
  mcpServer: McpServer,
  store: MemoryStore,
): void {
  mcpServer.tool(
    'memory_write',
    'Upsert a memory entry for the current group. Inserts a new record or updates the existing one when the key already exists. Use dot-namespaced keys like "nanoclaw.appdata_path". Memories are isolated per group — they are NOT visible to other groups.',
    {
      key: z
        .string()
        .describe('Unique slug, 1-128 chars, letters/digits/_/./-/:'),
      value: z.string().describe('The fact to store (max 64KB)'),
      tags: z
        .string()
        .optional()
        .describe('Comma-separated tags, e.g. "infra,paths" (max 512 chars)'),
      source: z
        .string()
        .optional()
        .describe('Who is writing this (e.g. "gary", "k2")'),
    },
    async (args) => {
      try {
        return ok(store.write(args));
      } catch (e) {
        return err(e);
      }
    },
  );

  mcpServer.tool(
    'memory_read',
    'Look up a memory entry by exact key in the current group. Returns the full record or a not-found message.',
    {
      key: z.string().describe('The key to look up'),
    },
    async (args) => {
      try {
        const rec = store.read(args.key);
        if (!rec) return ok({ found: false, key: args.key });
        return ok({ found: true, record: rec });
      } catch (e) {
        return err(e);
      }
    },
  );

  mcpServer.tool(
    'memory_search',
    "Full-text search across the current group's memories. Matches key, value, and tags. Results are ranked by FTS5 bm25 relevance.",
    {
      query: z
        .string()
        .describe('FTS5 query (e.g. "unraid OR syd", "appdata")'),
      limit: z.number().optional().describe('Max results (default 10, cap 50)'),
    },
    async (args) => {
      try {
        return ok(store.search(args));
      } catch (e) {
        return err(e);
      }
    },
  );

  mcpServer.tool(
    'memory_delete',
    'Delete a memory entry by key in the current group.',
    {
      key: z.string().describe('The key to delete'),
    },
    async (args) => {
      try {
        const deleted = store.delete(args.key);
        return ok({ deleted, key: args.key });
      } catch (e) {
        return err(e);
      }
    },
  );

  mcpServer.tool(
    'memory_list',
    "List the current group's memory keys (values omitted to keep the response compact). Optionally filter by tag.",
    {
      tag: z
        .string()
        .optional()
        .describe('Only return entries whose tags include this exact tag'),
      limit: z.number().optional().describe('Max results (default 50, cap 200)'),
    },
    async (args) => {
      try {
        return ok(store.list(args));
      } catch (e) {
        return err(e);
      }
    },
  );
}

// Only start the MCP server when invoked directly (not during tests).
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('memory-mcp-stdio.js');

if (isMainModule) {
  const groupFolder = process.env.NANOCLAW_GROUP_FOLDER;
  if (!groupFolder) {
    console.error(
      '[memory-mcp] NANOCLAW_GROUP_FOLDER is not set — refusing to start.',
    );
    process.exit(1);
  }
  const resolvedPath = resolveDbPath();
  const sourceLabel =
    process.env.MEMORY_DB_PATH && process.env.MEMORY_DB_PATH.length > 0
      ? 'MEMORY_DB_PATH env'
      : 'default';
  console.error(
    `[memory-mcp] group=${groupFolder} db=${resolvedPath} (${sourceLabel})`,
  );
  const store = new MemoryStore(resolvedPath, groupFolder);
  const mcpServer = new McpServer({ name: 'memory', version: '1.0.0' });
  registerMemoryTools(mcpServer, store);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
