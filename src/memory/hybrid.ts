/**
 * 混合检索融合模块 — 从 Nine hybrid.py 翻译
 *
 * 向量 + 关键词双路结果合并 → 加权分数 → 时间衰减 → 排序 → MMR
 */
import { applyDecayToResults, DecayableResult } from './temporal-decay.js';
import { mmrRerank } from './mmr.js';

export interface HybridResult {
  id: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  score: number;
  embedding?: number[];
}

export interface HybridMergeOptions {
  vectorWeight?: number; // 默认 0.7
  textWeight?: number; // 默认 0.3
  temporalDecayHalfLife?: number; // 默认 30 天
  mmrLambda?: number; // 默认 0.7，null 则不做 MMR
  nowTs?: number; // 测试用
}

/**
 * 将向量和关键词检索结果融合为统一排序列表。
 *
 * W3 修复：向量结果的 embedding 通过管道传给 MMR 做余弦相似度。
 */
export function mergeHybridResults(
  vectorResults: HybridResult[],
  keywordResults: HybridResult[],
  options: HybridMergeOptions = {},
): HybridResult[] {
  const {
    vectorWeight = 0.7,
    textWeight = 0.3,
    temporalDecayHalfLife = 30,
    mmrLambda = 0.7,
    nowTs,
  } = options;

  // 第一步：按 ID 合并
  const merged = new Map<
    string,
    {
      id: string;
      content: string;
      metadata?: Record<string, unknown> | null;
      createdAt?: string | null;
      embedding?: number[];
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const item of vectorResults) {
    const id = String(item.id);
    merged.set(id, {
      id,
      content: item.content || '',
      metadata: item.metadata,
      createdAt: item.createdAt,
      embedding: item.embedding,
      vectorScore: item.score ?? 0,
      textScore: 0,
    });
  }

  for (const item of keywordResults) {
    const id = String(item.id);
    const existing = merged.get(id);
    if (existing) {
      existing.textScore = item.score ?? 0;
      if (!existing.content) existing.content = item.content || '';
      if (existing.metadata == null) existing.metadata = item.metadata;
      if (existing.createdAt == null) existing.createdAt = item.createdAt;
    } else {
      merged.set(id, {
        id,
        content: item.content || '',
        metadata: item.metadata,
        createdAt: item.createdAt,
        vectorScore: 0,
        textScore: item.score ?? 0,
      });
    }
  }

  // 第二步：计算融合分数
  let results: DecayableResult[] = [];
  for (const item of merged.values()) {
    const fusedScore =
      vectorWeight * item.vectorScore + textWeight * item.textScore;
    results.push({
      id: item.id,
      content: item.content,
      metadata: item.metadata,
      createdAt: item.createdAt,
      embedding: item.embedding,
      score: fusedScore,
    });
  }

  // 第三步：时间衰减
  results = applyDecayToResults(results, temporalDecayHalfLife, nowTs);

  // 第四步：按分数降序排序
  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // 第五步：MMR 重排序（W3 修复：传递 embedding dict 给 MMR）
  if (mmrLambda != null) {
    // 构建 id→embedding 映射
    const embeddingMap = new Map<string, number[]>();
    for (const item of results) {
      if (item.embedding) {
        embeddingMap.set(item.id, item.embedding as number[]);
      }
    }

    const reranked = mmrRerank(
      results.map((r) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
      mmrLambda,
      embeddingMap.size > 0 ? embeddingMap : null,
    );

    return reranked as HybridResult[];
  }

  // 不做 MMR 时清理 embedding 字段
  return results.map(({ embedding: _e, ...rest }) => rest as HybridResult);
}
