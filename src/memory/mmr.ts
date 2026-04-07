/**
 * 最大边际相关性（MMR）重排序 — 从 Nine mmr.py 翻译
 *
 * 相似度计算：
 * 1. 向量余弦相似度（精确）— 有 embeddings 时
 * 2. 文本 Jaccard 相似度（回退）— 无向量时
 */
import { cosineSimilarity } from './embeddings.js';

const DEFAULT_LAMBDA = 0.7;

/**
 * 将文本分词为小写 token 集合。
 * 提取字母数字和中日韩字符 token。
 */
export function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const tokens = text.toLowerCase().match(/[\w\u4e00-\u9fff]+/g);
  return new Set(tokens || []);
}

/**
 * Jaccard 相似度，范围 [0, 1]。
 */
export function jaccardSimilarity(
  setA: Set<string>,
  setB: Set<string>,
): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * MMR 分数: lambda * relevance - (1-lambda) * maxSimilarity
 */
function computeMmrScore(
  relevance: number,
  maxSimilarity: number,
  lambdaParam: number = DEFAULT_LAMBDA,
): number {
  return lambdaParam * relevance - (1 - lambdaParam) * maxSimilarity;
}

export interface MmrItem {
  id: string;
  content: string;
  score: number;
  [key: string]: unknown;
}

/**
 * MMR 贪心重排序。
 *
 * @param items 待重排结果
 * @param lambdaParam 权衡参数（越大越偏相关性）
 * @param embeddings 可选 id→embedding 映射（提供时用余弦相似度）
 */
export function mmrRerank(
  items: MmrItem[],
  lambdaParam: number = DEFAULT_LAMBDA,
  embeddings?: Map<string, number[]> | null,
): MmrItem[] {
  if (items.length <= 1) return [...items];

  const useVectors = embeddings != null && embeddings.size > 0;

  // 归一化分数到 [0, 1]
  const scores = items.map((it) => it.score ?? 0);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const scoreRange = maxScore - minScore;

  interface NormalizedItem extends MmrItem {
    _normScore: number;
  }

  const normalized: NormalizedItem[] = items.map((item) => ({
    ...item,
    _normScore:
      scoreRange > 0 ? ((item.score ?? 0) - minScore) / scoreRange : 1,
  }));

  // 预计算 token 缓存（文本回退模式）
  let tokenCache: Map<string, Set<string>> | null = null;
  if (!useVectors) {
    tokenCache = new Map();
    for (const item of normalized) {
      tokenCache.set(String(item.id), tokenize(item.content || ''));
    }
  }

  function similarity(idA: string, idB: string): number {
    if (useVectors) {
      const vecA = embeddings!.get(idA);
      const vecB = embeddings!.get(idB);
      if (vecA && vecB) return cosineSimilarity(vecA, vecB);
    }
    // 文本回退
    if (tokenCache) {
      return jaccardSimilarity(
        tokenCache.get(idA) || new Set(),
        tokenCache.get(idB) || new Set(),
      );
    }
    return 0;
  }

  // 贪心迭代选择
  const selected: NormalizedItem[] = [];
  const remaining = [...normalized];

  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const candidateId = String(candidate.id);

      // 与已选集合的最大相似度
      let maxSim = 0;
      for (const sel of selected) {
        const sim = similarity(candidateId, String(sel.id));
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = computeMmrScore(candidate._normScore, maxSim, lambdaParam);
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  // 清除临时字段
  return selected.map(({ _normScore, ...rest }) => rest as MmrItem);
}
