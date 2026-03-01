import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const MEMORY_DB_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'sessions',
  'main',
  '.claude',
  'skills',
  'memory',
  'memory.db',
);

let _memoryDb: Database.Database | null = null;

function getMemoryDb(): Database.Database | null {
  if (!_memoryDb) {
    if (!fs.existsSync(MEMORY_DB_PATH)) return null;
    _memoryDb = new Database(MEMORY_DB_PATH, {
      readonly: true,
      fileMustExist: true,
    });
  }
  return _memoryDb;
}

export interface MemoryRow {
  id: number;
  content: string;
  context: string | null;
  category: string;
  tags: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  archived: number;
}

export interface CategoryStat {
  category: string;
  count: number;
}

export function getTotalMemories(): number {
  const db = getMemoryDb();
  if (!db) return 0;
  const row = db
    .prepare('SELECT COUNT(*) as count FROM memories WHERE archived = 0')
    .get() as { count: number };
  return row.count;
}

export function getCategoryStats(): CategoryStat[] {
  const db = getMemoryDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT category, COUNT(*) as count
       FROM memories WHERE archived = 0
       GROUP BY category ORDER BY count DESC`,
    )
    .all() as CategoryStat[];
}

export function getRecentMemories(limit = 20): MemoryRow[] {
  const db = getMemoryDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT * FROM memories WHERE archived = 0
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as MemoryRow[];
}

export function searchMemories(
  query: string,
  category?: string,
  limit = 50,
): MemoryRow[] {
  const db = getMemoryDb();
  if (!db) return [];

  let whereClause = 'WHERE m.archived = 0';
  const params: unknown[] = [];

  if (category) {
    whereClause += ' AND m.category = ?';
    params.push(category);
  }

  if (query) {
    return db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.id = fts.rowid
         ${whereClause}
         AND memories_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(...params, query, limit) as MemoryRow[];
  }

  return db
    .prepare(
      `SELECT * FROM memories m ${whereClause}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as MemoryRow[];
}

export function getMemoriesByCategory(
  category: string,
  limit = 50,
): MemoryRow[] {
  const db = getMemoryDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT * FROM memories WHERE archived = 0 AND category = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(category, limit) as MemoryRow[];
}

export function getAllTags(): { tag: string; count: number }[] {
  const db = getMemoryDb();
  if (!db) return [];

  const rows = db
    .prepare(
      `SELECT tags FROM memories WHERE archived = 0 AND LENGTH(tags) > 0`,
    )
    .all() as { tags: string }[];

  const tagCounts: Record<string, number> = {};
  for (const row of rows) {
    if (row.tags) {
      for (const tag of row.tags.split(',')) {
        const t = tag.trim();
        if (t) tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
  }

  return Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}
