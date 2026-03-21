/**
 * Fallback model pricing for cost estimation.
 *
 * When openclaw's `estimateUsageCost()` returns undefined (because the user
 * hasn't configured model pricing in openclaw.json), this module provides
 * well-known pricing for popular models so cost dashboard panels still work.
 *
 * Pricing: USD per 1M tokens — matches openclaw's ModelCostConfig shape.
 * Returns undefined for unknown models (no guessing).
 */

type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// Provider → model ID → pricing (USD per 1M tokens)
const KNOWN_MODEL_PRICING: Record<string, Record<string, ModelCost>> = {
  anthropic: {
    "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    // Older models still in use
    "claude-sonnet-4-5-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
};

type TokenUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/**
 * Estimate cost when openclaw's pricing config is missing.
 * Formula matches openclaw's estimateUsageCost():
 *   (input × inputCost + output × outputCost + cacheRead × cacheReadCost + cacheWrite × cacheWriteCost) / 1_000_000
 *
 * Returns undefined for unknown provider/model combos.
 */
/**
 * Resolve model pricing from openclaw's config — the same config that
 * openclaw's own `resolveModelCostConfig()` reads. This covers ALL
 * user-configured models, not just the 6 hardcoded Anthropic ones.
 *
 * Config path: `config.models.providers[provider].models[{id: model}].cost`
 *
 * Returns undefined if the provider/model isn't configured or has no cost entry.
 */
export function resolveModelCostFromConfig(
  config: Record<string, unknown>,
  provider?: string,
  model?: string,
): ModelCost | undefined {
  if (!provider || !model) return undefined;
  try {
    const models = (config as Record<string, unknown>).models as Record<string, unknown> | undefined;
    if (!models) return undefined;
    const providers = models.providers as Record<string, unknown> | undefined;
    if (!providers) return undefined;
    const providerEntry = providers[provider] as Record<string, unknown> | undefined;
    if (!providerEntry) return undefined;
    const modelList = providerEntry.models as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(modelList)) return undefined;
    const modelEntry = modelList.find((m) => m.id === model);
    if (!modelEntry) return undefined;
    const cost = modelEntry.cost as Record<string, unknown> | undefined;
    if (!cost) return undefined;
    // openclaw's ModelCostConfig uses per-million pricing
    const input = typeof cost.input === "number" ? cost.input : undefined;
    const output = typeof cost.output === "number" ? cost.output : undefined;
    if (input === undefined || output === undefined) return undefined;
    return {
      input,
      output,
      cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : input * 0.1,
      cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : input * 1.25,
    };
  } catch {
    return undefined;
  }
}

/**
 * Estimate cost from a resolved ModelCost and token usage.
 * Same formula as openclaw's estimateUsageCost():
 *   (input × inputCost + output × outputCost + ...) / 1_000_000
 */
export function estimateUsageCost(pricing: ModelCost, usage?: TokenUsage): number | undefined {
  if (!usage) return undefined;
  const cost =
    ((usage.input ?? 0) * pricing.input +
      (usage.output ?? 0) * pricing.output +
      (usage.cacheRead ?? 0) * pricing.cacheRead +
      (usage.cacheWrite ?? 0) * pricing.cacheWrite) /
    1_000_000;
  return cost > 0 ? cost : undefined;
}

export function estimateCostFallback(
  provider?: string,
  model?: string,
  usage?: TokenUsage,
): number | undefined {
  if (!provider || !model || !usage) return undefined;
  const pricing = KNOWN_MODEL_PRICING[provider]?.[model];
  if (!pricing) return undefined;
  return estimateUsageCost(pricing, usage);
}
