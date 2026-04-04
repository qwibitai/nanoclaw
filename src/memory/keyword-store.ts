/**
 * 关键词检索模块 — 从 Nine keyword_store.py 翻译
 *
 * 使用 SQLite FTS5 trigram tokenizer（W2 修复）。
 * FTS5 不可用时回退到 LIKE 模糊匹配。
 */
import { getMemoryDb, isFtsAvailable } from './storage.js';
import { logger } from '../logger.js';

export interface KeywordResult {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  score: number;
}

/**
 * 从原始查询提取 token（字母数字 + 中日韩字符）
 */
function extractTokens(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  return raw.match(/[\w\u4e00-\u9fff]+/g) || [];
}

/**
 * 构建 FTS5 trigram 查询表达式。
 * trigram tokenizer 支持子串匹配，用双引号包裹每个 token。
 */
function buildFtsQuery(raw: string): string | null {
  const tokens = extractTokens(raw);
  if (tokens.length === 0) return null;
  // trigram tokenizer 用 OR 组合（W2 修复：中文用 OR 避免过于严格）
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * 关键词检索（自动选择 FTS5 或 LIKE）
 *
 * W1 修复：FTS5 查询 JOIN 主表过滤 group_folder
 */
export function keywordSearch(
  query: string,
  groupFolder: string,
  topK: number = 10,
  userId: string = '',
): KeywordResult[] {
  if (isFtsAvailable()) {
    return searchFts(query, groupFolder, topK, userId);
  }
  return searchLike(query, groupFolder, topK, userId);
}

function searchFts(
  query: string,
  groupFolder: string,
  topK: number,
  userId: string = '',
): KeywordResult[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const db = getMemoryDb();
  try {
    // W1 修复：JOIN 主表过滤 group_folder
    const rows = db
      .prepare(
        `SELECT m.id, m.content, m.category, m.created_at, fts.rank
         FROM memory_facts_fts fts
         JOIN memory_facts m ON fts.fact_id = m.id
         WHERE fts.content MATCH ? AND m.user_id = ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(ftsQuery, userId, topK) as Array<{
      id: string;
      content: string;
      category: string;
      created_at: string | null;
      rank: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: { category: r.category },
      createdAt: r.created_at,
      // FTS5 rank 归一化到 [0, 1]：abs(rank) / (1 + abs(rank))
      score: Math.abs(r.rank) / (1 + Math.abs(r.rank)),
    }));
  } catch (err) {
    logger.warn({ err }, 'FTS5 检索失败，回退到 LIKE');
    return searchLike(query, groupFolder, topK);
  }
}

function searchLike(
  query: string,
  groupFolder: string,
  topK: number,
  userId: string = '',
): KeywordResult[] {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return [];

  const db = getMemoryDb();

  // 构建 SQL：至少匹配一个 token，匹配数作为评分
  const likeClauses = tokens.map((_, i) => `content LIKE @pat${i}`);
  const scoreParts = tokens.map(
    (_, i) => `CASE WHEN content LIKE @pat${i} THEN 1 ELSE 0 END`,
  );

  const sql = `
    SELECT id, content, category, created_at,
           (${scoreParts.join(' + ')}) AS match_count
    FROM memory_facts
    WHERE user_id = @uid AND (${likeClauses.join(' OR ')})
    ORDER BY match_count DESC
    LIMIT @topK`;

  const params: Record<string, string | number> = {
    uid: userId,
    topK,
  };
  for (let i = 0; i < tokens.length; i++) {
    params[`pat${i}`] = `%${tokens[i]}%`;
  }

  try {
    const rows = db.prepare(sql).all(params) as Array<{
      id: string;
      content: string;
      category: string;
      created_at: string | null;
      match_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: { category: r.category },
      createdAt: r.created_at,
      // 归一化：匹配 token 比例 → [0, 1]
      score: tokens.length > 0 ? r.match_count / tokens.length : 0,
    }));
  } catch (err) {
    logger.warn({ err }, 'LIKE 检索失败');
    return [];
  }
}
