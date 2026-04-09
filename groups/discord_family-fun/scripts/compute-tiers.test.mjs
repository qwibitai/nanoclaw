import { describe, it, expect, vi } from 'vitest';
import { computeBudgets } from './compute-tiers.mjs';

describe('computeBudgets', () => {
  it('maps each player to their tier guess count', async () => {
    const fakeRows = [
      // Voss (Paden) — 600 lifetime → Fledgling 6
      ['ts', 'd', 'Voss', 'xp_gain', '500', 'win'],
      ['ts', 'd', 'Voss', 'xp_gain', '100', 'win'],
      ['ts', 'd', 'Voss', 'decay', '-200', 'loss'],
      // Nyx (Brenda) — 0 → Hatchling 7
      // Zima (Danny) — 1500 → Adept 5
      ['ts', 'd', 'Zima', 'xp_gain', '1500', 'mega win'],
    ];
    const readRangeFn = vi.fn().mockResolvedValue(fakeRows);
    const result = await computeBudgets({ readRangeFn, token: 'fake' });
    expect(result).toEqual({ Paden: 6, Brenda: 7, Danny: 5 });
    expect(readRangeFn).toHaveBeenCalledOnce();
  });
});
