/**
 * 时间衰减模块 — 从 Nine temporal_decay.py 翻译
 *
 * 指数衰减让近期记忆权重更高。
 */

const DAY_SECONDS = 86400;
const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * 将半衰期（天）转换为衰减常数 lambda。
 * 公式: lambda = ln(2) / halfLifeDays
 */
export function toDecayLambda(halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 0;
  return Math.log(2) / halfLifeDays;
}

/**
 * 计算给定年龄的衰减乘数。
 * 公式: multiplier = exp(-lambda * age)
 */
export function calculateDecayMultiplier(
  ageInDays: number,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  ageInDays = Math.max(0, ageInDays);
  const lambda = toDecayLambda(halfLifeDays);
  if (lambda === 0) return 1;
  return Math.exp(-lambda * ageInDays);
}

/**
 * 对单个分数应用时间衰减。
 */
export function applyTemporalDecay(
  score: number,
  ageInDays: number,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  return score * calculateDecayMultiplier(ageInDays, halfLifeDays);
}

export interface DecayableResult {
  id: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  score: number;
  embedding?: number[];
  [key: string]: unknown;
}

/**
 * 批量对结果列表应用时间衰减。
 * 支持 ISO 字符串和 Unix 时间戳。
 */
export function applyDecayToResults(
  results: DecayableResult[],
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
  nowTs?: number,
): DecayableResult[] {
  const now = nowTs ?? Date.now() / 1000;

  return results.map((item) => {
    const created = item.createdAt;
    if (created == null) return { ...item };

    // 支持 ISO 字符串和数字时间戳
    let createdTs: number;
    if (typeof created === 'string') {
      createdTs = new Date(created).getTime() / 1000;
    } else {
      createdTs = Number(created);
    }

    if (!Number.isFinite(createdTs)) return { ...item };

    const ageSeconds = Math.max(0, now - createdTs);
    const ageInDays = ageSeconds / DAY_SECONDS;

    return {
      ...item,
      score: applyTemporalDecay(item.score, ageInDays, halfLifeDays),
    };
  });
}
