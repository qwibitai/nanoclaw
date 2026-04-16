import { describe, expect, it } from 'vitest';

import { resolveThinkingBudget } from './thinking.js';

describe('resolveThinkingBudget', () => {
  it('returns the adaptive preset when given "adaptive"', () => {
    expect(resolveThinkingBudget('adaptive')).toEqual({ type: 'adaptive' });
  });

  it('returns low/medium/high budgets with matching token counts', () => {
    expect(resolveThinkingBudget('low')).toEqual({
      type: 'enabled',
      budgetTokens: 42667,
    });
    expect(resolveThinkingBudget('medium')).toEqual({
      type: 'enabled',
      budgetTokens: 85334,
    });
    expect(resolveThinkingBudget('high')).toEqual({
      type: 'enabled',
      budgetTokens: 128000,
    });
  });

  it('falls back to adaptive for unknown preset names', () => {
    expect(resolveThinkingBudget('turbo')).toEqual({ type: 'adaptive' });
  });

  it('falls back to adaptive when preset is undefined', () => {
    expect(resolveThinkingBudget()).toEqual({ type: 'adaptive' });
  });
});
