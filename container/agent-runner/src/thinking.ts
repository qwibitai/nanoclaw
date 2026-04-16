export type ThinkingBudget =
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' };

/**
 * Map a preset name ("low" | "medium" | "high" | "adaptive") to the
 * SDK `thinking` option. Unknown values fall back to adaptive.
 */
export function resolveThinkingBudget(preset?: string): ThinkingBudget {
  const PRESETS: Record<string, ThinkingBudget> = {
    low: { type: 'enabled', budgetTokens: 42667 },
    medium: { type: 'enabled', budgetTokens: 85334 },
    high: { type: 'enabled', budgetTokens: 128000 },
    adaptive: { type: 'adaptive' },
  };
  return PRESETS[preset || 'adaptive'] || PRESETS['adaptive'];
}
